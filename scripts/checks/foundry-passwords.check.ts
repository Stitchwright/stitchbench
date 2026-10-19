// Retiring local passwords (docs/plan.md FA-5), with FOUNDRY_SIGNIN=only: driving password-reset.ts, people.ts, signin.ts's link
// by one-time link and retire.ts against the stand-in Foundry service (scripts/test-mail/foundry-mock.mjs) and the dev database:
//   1. no password to reset: the forgot and reset paths refuse in the Foundry words; a setup or administrator's link goes to the Foundry
//      link page (off and on: still /reset)
//   2. a one-time link proves a login by itself: it links an account without an old password, works once (two at once: one wins), is not
//      spent by a wrong Foundry password or by another account's refusal, and is refused when unknown, malformed, expired, a plain reset
//      link, or for a login that was switched off
//   3. people: a person is added with no password and a link, whose hash matches nothing; a "sign-in link" clears the old link and ends
//      sessions; the owner and yourself are refused; the platform administrator's owner link does the same for an owner
//   4. retiring: only linked logins lose their passwords (audited), unlinked ones keep theirs, a dry run changes nothing, again is harmless,
//      and nothing happens until the switch says only
// What this does not cover: the pages and the seed (a browser and a CLI run did that).
//   npm run check scripts/checks/foundry-passwords.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { startFoundryMock } from "../test-mail/foundry-mock.mjs";
import { addPersonAs, staffSignInLinkAs } from "@/lib/people";
import { checkResetLink, finishReset, issueResetLink, ONLY_WORDS, ownerResetLinkFor, requestResetFor, resetByEmailProblem, SETUP_HOURS, tokenHash } from "@/lib/password-reset";
import { linkFoundryAccount } from "@/lib/foundry/signin";
import { retirePasswords } from "@/lib/foundry/retire";
import { checkSignIn } from "@/lib/sign-in";
import { isUserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { checkShop, cleanup } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const OLD = "check-pass-1234"; // what scripts/checks/tenant.ts gives each owner
const FPASS = "fire truck 1";

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
    }
  };
  set(vars);
  try {
    return await fn();
  } finally {
    set(was);
  }
}

async function failsWith(p: Promise<unknown> | (() => unknown), re: RegExp, label: string) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

const tokenOf = (link: string) => new URL(link).searchParams.get("t") ?? "";

async function main() {
  assert.ok(process.env.AUTH_SECRET, "AUTH_SECRET (from .env) is needed");
  const mock = await startFoundryMock({ port: 0, firstId: 4_000_000 + crypto.randomInt(1_000_000) });
  const started: string[] = [];
  const o = { baseUrl: mock.url, start: async (t: string) => void started.push(t) };
  const a = await checkShop();
  const b = await checkShop();
  const adminOf = (s: { shopId: string; user: { id: string; email: string; name: string } }): CurrentUser => ({ id: s.user.id, shopId: s.shopId, role: "OWNER", name: s.user.name, email: s.user.email });
  const owner = adminOf(a);
  const form = (o2: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o2)) f.set(k, v);
    return f;
  };
  const link = (email: string, extra: Partial<Parameters<typeof linkFoundryAccount>[0]> = {}, tok = "") => linkFoundryAccount({ token: tok, foundryEmail: email, foundryPassword: FPASS, create: true, ...extra }, undefined, o);
  try {
    await withEnv({ FOUNDRY_SIGNIN: "only", STITCH_DESKTOP: undefined, APP_URL: "http://localhost:3000", PLATFORM_ADMIN_EMAILS: undefined }, async () => {
      // 1. No password to reset.
      assert.equal(resetByEmailProblem(), ONLY_WORDS);
      assert.throws(() => requestResetFor("a@b.co", null), (e) => isUserError(e) && /Foundry Account/.test((e as Error).message));
      await failsWith(finishReset("x".repeat(40), "password-1", "password-1"), /Foundry Account/, "finish a reset");
      const setup = await issueResetLink(owner.id, "setup", SETUP_HOURS);
      assert.match(setup.link, /^http:\/\/localhost:3000\/login\/link\?t=[A-Za-z0-9_-]{40,}$/);
      const reset = await issueResetLink(owner.id, "reset", 1);
      assert.match(reset.link, /\/reset\?t=/, "a forgot-password link keeps its address (and is no proof here)");
      await withEnv({ FOUNDRY_SIGNIN: "on" }, async () => assert.match((await issueResetLink(owner.id, "setup", 1)).link, /\/reset\?t=/, "with the switch on, a setup link still sets a password"));
      await withEnv({ FOUNDRY_SIGNIN: undefined }, async () => assert.match((await issueResetLink(owner.id, "admin", 1)).link, /\/reset\?t=/, "off: as before"));
      ok("only: no password to reset or ask for; a setup or administrator's link goes to the Foundry link page (off and on: as before)");

      // 2. A one-time link as proof.
      const t1 = await issueResetLink(owner.id, "setup", SETUP_HOURS);
      const state = await checkResetLink(t1.token);
      assert.equal(state.ok, true);
      const wrong = await link("denise@example.com", { foundryPassword: "wrong one", create: false }, t1.token);
      assert.deepEqual(wrong, { ok: false, reason: "foundry-wrong" }, "no such account yet");
      assert.ok((await db.passwordReset.findUniqueOrThrow({ where: { tokenHash: tokenHash(t1.token) } })).usedAt === null, "a wrong Foundry password doesn't spend the link");
      const first = await link("denise@example.com", {}, t1.token);
      assert.ok(first.ok);
      const row = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
      assert.ok(row.foundryId !== null, "linked by the account's id");
      assert.equal(started.length, 1);
      assert.deepEqual(await link("denise@example.com", { create: false }, t1.token), { ok: false, reason: "link" }, "once only");
      assert.equal(started.length, 1, "and nothing started by the second try");
      for (const bad of ["", "short", "x".repeat(200), "!!!not-a-token-at-all-but-long-enough-for-the-shape!!!", reset.token]) {
        assert.deepEqual(await link("denise@example.com", { create: false }, bad || "nope"), { ok: false, reason: "link" }, `refused: ${bad.slice(0, 20) || "(empty)"}`);
      }
      const old = await issueResetLink(owner.id, "admin", 1);
      await db.passwordReset.update({ where: { tokenHash: tokenHash(old.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      assert.deepEqual(await link("denise@example.com", { create: false }, old.token), { ok: false, reason: "link" }, "expired");
      // Another account is refused and doesn't spend the link; a login that was switched off can't use one.
      await fetch(`${mock.url}/v1/signup`, { method: "POST", body: JSON.stringify({ email: "pat@example.com", password: FPASS }) });
      const t2 = await issueResetLink(owner.id, "admin", SETUP_HOURS);
      assert.deepEqual(await link("pat@example.com", { create: false }, t2.token), { ok: false, reason: "other-account" });
      assert.ok((await db.passwordReset.findUniqueOrThrow({ where: { tokenHash: tokenHash(t2.token) } })).usedAt === null, "a refusal for another account keeps the link");
      const off = await db.user.create({ data: { shopId: a.shopId, email: `check-off-${crypto.randomBytes(3).toString("hex")}@stitchbench.test`, name: "Off", role: "TECH", active: true, passwordHash: row.passwordHash } });
      const t3 = await issueResetLink(off.id, "setup", SETUP_HOURS);
      await db.user.update({ where: { id: off.id }, data: { active: false } });
      assert.deepEqual(await link("denise@example.com", { create: false }, t3.token), { ok: false, reason: "link" }, "a login switched off");
      // A plain "forgot my password" link is no proof of who a login is (made last, so nothing has cancelled it).
      const rtUser = await db.user.create({ data: { shopId: b.shopId, email: `check-rt-${crypto.randomBytes(3).toString("hex")}@stitchbench.test`, name: "Reset only", role: "TECH", active: true, passwordHash: row.passwordHash } });
      const rt = await issueResetLink(rtUser.id, "reset", 1);
      assert.equal((await checkResetLink(rt.token)).ok, true, "a good reset link, unused");
      assert.deepEqual(await link("denise@example.com", { create: false }, rt.token), { ok: false, reason: "link" }, "a reset link can't link an account");
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: rtUser.id } })).foundryId, null);
      // Two at once: one wins.
      const tech = await db.user.create({ data: { shopId: b.shopId, email: `check-race-${crypto.randomBytes(3).toString("hex")}@stitchbench.test`, name: "Race", role: "TECH", active: true, passwordHash: row.passwordHash } });
      const t4 = await issueResetLink(tech.id, "setup", SETUP_HOURS);
      const both = await Promise.all([link("denise@example.com", { create: false }, t4.token), link("denise@example.com", { create: false }, t4.token)]);
      assert.equal(both.filter((r) => r.ok).length, 1, "two tries at once: exactly one links");
      // The old email-and-password proof still works while the switch is only (the way for a login that has no link yet).
      const viaOld = await linkFoundryAccount({ email: b.user.email, password: OLD, foundryEmail: "denise@example.com", foundryPassword: FPASS, create: false }, undefined, o);
      assert.ok(viaOld.ok || viaOld.reason === "taken", "the old-password proof is not closed");
      ok("a one-time link proves a login: once, not spent by a refusal, refused when odd, expired, a reset link or switched off; two at once, one wins");
    });

    await withEnv({ FOUNDRY_SIGNIN: "only", STITCH_DESKTOP: undefined, APP_URL: "http://localhost:3000" }, async () => {
      // 3. People.
      const added = await addPersonAs(owner, form({ name: "New Tech", email: `check-new-${crypto.randomBytes(3).toString("hex")}@stitchbench.test`, role: "TECH" }));
      assert.ok(added && /\/login\/link\?t=/.test(added.link), "no password asked for; a link comes back");
      const person = await db.user.findFirstOrThrow({ where: { shopId: a.shopId, name: "New Tech" } });
      for (const guess of ["", OLD, person.email, "password1", FPASS]) assert.equal(await bcrypt.compare(guess, person.passwordHash), false, `nothing matches: ${guess}`);
      assert.equal(await checkSignIn({ email: person.email, password: OLD }, undefined), null);
      const joined = await link("tech.person@example.com", {}, tokenOf(added.link));
      assert.ok(joined.ok, "the new person links their own account");
      await withEnv({ FOUNDRY_SIGNIN: undefined }, async () => failsWith(addPersonAs(owner, form({ name: "X", email: "x@y.co", role: "TECH" })), /temporary password/, "off: a password is still required"));
      // A sign-in link for a person: clears the link, ends sessions.
      const before = await db.user.findUniqueOrThrow({ where: { id: person.id } });
      const personLink = await staffSignInLinkAs(owner, person.id);
      const after = await db.user.findUniqueOrThrow({ where: { id: person.id } });
      assert.equal(after.foundryId, null, "the old link is cleared so they can attach another account");
      assert.equal(after.sessionVersion, before.sessionVersion + 1, "their sessions end");
      assert.match(personLink, /\/login\/link\?t=/);
      await failsWith(staffSignInLinkAs(owner, owner.id), /for yourself/, "yourself");
      await failsWith(staffSignInLinkAs(owner, (await db.user.findFirstOrThrow({ where: { shopId: a.shopId, role: "OWNER" } })).id), /for yourself/, "the owner is yourself here");
      const otherOwner = await db.user.findFirstOrThrow({ where: { shopId: b.shopId, role: "OWNER" } });
      await failsWith(staffSignInLinkAs(owner, otherOwner.id), /User not found/, "another company's login");
      // The platform administrator's owner link.
      await withEnv({ PLATFORM_ADMIN_EMAILS: "platform.admin@stitchbench.test" }, async () => {
        const admin = { ...owner, id: "not-a-company-user", email: "platform.admin@stitchbench.test" } as CurrentUser;
        const ownerBefore = await db.user.findUniqueOrThrow({ where: { id: otherOwner.id } });
        const ownerLink = await ownerResetLinkFor(admin, b.shopId);
        const ownerAfter = await db.user.findUniqueOrThrow({ where: { id: otherOwner.id } });
        assert.match(ownerLink, /\/login\/link\?t=/);
        assert.equal(ownerAfter.foundryId, null);
        assert.equal(ownerAfter.sessionVersion, ownerBefore.sessionVersion + 1);
        await failsWith(ownerResetLinkFor({ ...admin, email: "someone@else.test" } as CurrentUser, b.shopId), /administrator/, "only the platform administrator");
      });
      ok("people: added with no password and a link whose hash matches nothing; a sign-in link clears the old link and ends sessions; owner, self and strangers refused; the administrator's owner link too");

      // 4. Retiring.
      const linkedTech = await db.user.create({ data: { shopId: a.shopId, email: `check-lt-${crypto.randomBytes(3).toString("hex")}@stitchbench.test`, name: "Linked Tech", role: "TECH", active: true, passwordHash: await bcrypt.hash("tech-pass-1234", 10), foundryId: 4_999_999 } });
      const waiting = await db.user.create({ data: { shopId: a.shopId, email: `check-w-${crypto.randomBytes(3).toString("hex")}@stitchbench.test`, name: "Waiting", role: "TECH", active: true, passwordHash: await bcrypt.hash("wait-pass-1234", 10) } });
      const scope = { onlyShops: [a.shopId, b.shopId] };
      const dry = await retirePasswords({ apply: false, ...scope });
      assert.ok(dry.linked >= 2 && dry.retired === 0);
      assert.ok(dry.waiting.some((w) => w.email === waiting.email), "unlinked logins are listed as waiting");
      assert.equal(await bcrypt.compare("tech-pass-1234", (await db.user.findUniqueOrThrow({ where: { id: linkedTech.id } })).passwordHash), true, "a dry run changes nothing");
      const done = await retirePasswords({ apply: true, ...scope });
      assert.equal(done.retired, done.linked);
      assert.equal(await bcrypt.compare("tech-pass-1234", (await db.user.findUniqueOrThrow({ where: { id: linkedTech.id } })).passwordHash), false, "a linked login's password is gone");
      assert.equal(await bcrypt.compare("wait-pass-1234", (await db.user.findUniqueOrThrow({ where: { id: waiting.id } })).passwordHash), true, "an unlinked login keeps its password");
      assert.ok(await db.auditEntry.findFirst({ where: { shopId: a.shopId, action: "user.password_retired", subjectId: linkedTech.id } }), "audited");
      assert.equal((await retirePasswords({ apply: true, ...scope })).retired, done.linked, "again is harmless");
      await withEnv({ FOUNDRY_SIGNIN: "on" }, async () => {
        assert.equal(await checkSignIn({ email: linkedTech.email, password: "tech-pass-1234" }, undefined), null, "even with the switch on, the retired password signs nobody in");
        assert.equal((await checkSignIn({ email: waiting.email, password: "wait-pass-1234" }, undefined))?.id, waiting.id, "an unlinked login still can");
        await failsWith(retirePasswords({ apply: true, ...scope }), /FOUNDRY_SIGNIN=only/, "not until the switch says only");
      });
      await withEnv({ FOUNDRY_SIGNIN: undefined }, async () => failsWith(retirePasswords({ apply: false, ...scope }), /FOUNDRY_SIGNIN=only/, "off"));
      ok("retiring: only linked logins lose their passwords (audited); unlinked keep theirs; a dry run changes nothing; again is harmless; nothing before only");
    });
    console.log(`\n${steps} steps passed.`);
  } finally {
    await mock.close();
    await cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
