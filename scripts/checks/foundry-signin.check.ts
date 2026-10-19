// Signing in to StitchBench / StitchShop with a Foundry Account (docs/plan.md FA-2), driving src/lib/foundry/signin.ts,
// session.ts (the sealed token) and mode.ts against the stand-in service (scripts/test-mail/foundry-mock.mjs) and the dev
// database:
//   1. the switch: off unless "on" or "only"; the Windows program is always off
//   2. a Foundry sign-in with no login linked to the account is refused, and the service session is ended again
//   3. linking: needs the OLD login's password and the account's password; a taken, different or several-company
//      case is refused; an audit entry is written; the same account may be linked in another company
//   4. after linking, the account's id opens the login: the right password in any case of the email, a wrong one not,
//      a switched-off login not, two companies give two logins (the "Choose a company" step)
//   5. a Foundry Account made with a local user's email is NOT that user (the id decides, never the email)
//   6. the service down, locking an email, and the per-address limit
//   7. FOUNDRY_SIGNIN=only closes the old password at sign-in (a ticket, which a Foundry sign-in earns, still opens)
//   8. the stored token is sealed, opens for its own row only, and dies with the row
// What this does not cover: the cookie and the page (they need a request and a browser).
//   npm run check scripts/checks/foundry-signin.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { startFoundryMock } from "../test-mail/foundry-mock.mjs";
import { foundrySignInMode } from "@/lib/foundry/mode";
import { FOUNDRY_PER_ADDRESS, foundrySignInStep, linkFoundryAccount } from "@/lib/foundry/signin";
import { foundryTokenOf, storeFoundrySession } from "@/lib/foundry/session";
import { checkSignIn } from "@/lib/sign-in";
import { mintTicket } from "@/lib/sign-in-ticket";
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

async function main() {
  assert.ok(process.env.AUTH_SECRET, "AUTH_SECRET (from .env) is needed: tickets are keyed from it");
  // Account ids start high and random: the dev database may already hold logins linked to small ids (a browser run, a demo).
  const mock = await startFoundryMock({ port: 0, firstId: 1_000_000 + crypto.randomInt(1_000_000) });
  const started: { token: string; foundryId: number }[] = [];
  const o = { baseUrl: mock.url, start: async (token: string, foundryId: number) => void started.push({ token, foundryId }) };
  const a = await checkShop();
  const b = await checkShop();
  try {
    // 1. The switch.
    await withEnv({ FOUNDRY_SIGNIN: undefined, STITCH_DESKTOP: undefined }, async () => {
      assert.equal(foundrySignInMode(), "off");
      for (const [v, want] of [["on", "on"], [" ON ", "on"], ["only", "only"], ["Only", "only"], ["yes", "off"], ["", "off"], ["off", "off"]] as const) {
        process.env.FOUNDRY_SIGNIN = v;
        assert.equal(foundrySignInMode(), want, `"${v}"`);
      }
      process.env.FOUNDRY_SIGNIN = "only";
      process.env.STITCH_DESKTOP = "1";
      assert.equal(foundrySignInMode(), "off", "the Windows program keeps its local logins");
    });
    ok("the switch is off unless on or only, and always off on the Windows program");

    // A Foundry Account for the owner of company A, not linked yet.
    const owner = a.user;
    const mk = (email: string, create = true) => linkFoundryAccount({ email: owner.email, password: OLD, foundryEmail: email, foundryPassword: FPASS, create }, undefined, o);

    // 2. Unlinked.
    const made = await fetch(`${mock.url}/v1/signup`, { method: "POST", body: JSON.stringify({ email: "denise@example.com", password: FPASS }) }).then((r) => r.json() as Promise<{ account: { id: number } }>);
    const before = mock.requests.length;
    assert.deepEqual(await foundrySignInStep({ email: "denise@example.com", password: FPASS }, undefined, o), { ok: false, reason: "unlinked" });
    assert.equal(started.length, 0, "no browser session for an unlinked account");
    assert.ok(mock.requests.slice(before).some((r: { route: string }) => r.route === "POST /v1/signout"), "the service session is ended again");
    ok("a right Foundry password with no linked login is refused, and the service session ended");

    // 3. Linking.
    assert.deepEqual(await linkFoundryAccount({ email: owner.email, password: "wrong", foundryEmail: "denise@example.com", foundryPassword: FPASS, create: false }, undefined, o), { ok: false, reason: "old" });
    assert.deepEqual(await linkFoundryAccount({ email: owner.email, password: OLD, foundryEmail: "denise@example.com", foundryPassword: "wrong one", create: false }, undefined, o), { ok: false, reason: "foundry-wrong" });
    assert.deepEqual(await mk("denise@example.com"), { ok: false, reason: "foundry-taken" }, "make-me-one for an email that has an account");
    assert.deepEqual(await linkFoundryAccount({ email: owner.email, password: OLD, foundryEmail: "new@example.com", foundryPassword: "short", create: true }, undefined, o), { ok: false, reason: "short" });
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).foundryId, null, "nothing linked by the refusals above");
    assert.equal(started.length, 0);
    const linked = await linkFoundryAccount({ email: owner.email, password: OLD, foundryEmail: "denise@example.com", foundryPassword: FPASS, create: false }, undefined, o);
    assert.ok(linked.ok);
    assert.equal(linked.ok && linked.foundryId, made.account.id);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).foundryId, made.account.id);
    assert.equal(started.length, 1);
    assert.match(started[0].token, /^sfs_[0-9a-f]{64}$/);
    assert.ok(await db.auditEntry.findFirst({ where: { shopId: a.shopId, action: "foundry.link", subjectId: owner.id } }), "an audit entry");
    ok("linking needs both proofs, refuses the odd cases, links by the account's id and writes an audit entry");

    // The same login, another account; another login of the company, the same account; the same account in company B.
    const other = await fetch(`${mock.url}/v1/signup`, { method: "POST", body: JSON.stringify({ email: "pat@example.com", password: FPASS }) }).then((r) => r.json() as Promise<{ account: { id: number } }>);
    assert.deepEqual(await linkFoundryAccount({ email: owner.email, password: OLD, foundryEmail: "pat@example.com", foundryPassword: FPASS, create: false }, undefined, o), { ok: false, reason: "other-account" });
    const tech = await db.user.create({ data: { shopId: a.shopId, email: `check-${a.user.id.slice(-6)}-tech@stitchbench.test`, name: "Tech", role: "TECH", passwordHash: (await db.user.findUniqueOrThrow({ where: { id: owner.id } })).passwordHash } });
    assert.deepEqual(await linkFoundryAccount({ email: tech.email, password: OLD, foundryEmail: "denise@example.com", foundryPassword: FPASS, create: false }, undefined, o), { ok: false, reason: "taken" });
    assert.ok((await linkFoundryAccount({ email: b.user.email, password: OLD, foundryEmail: "denise@example.com", foundryPassword: FPASS, create: false }, undefined, o)).ok, "one account, a login in each of two companies");
    assert.equal(other.account.id === made.account.id, false);
    ok("a login keeps its account, a company links an account once, and one account may have a login in two companies");

    // 4. Signing in.
    let r = await foundrySignInStep({ email: " Denise@Example.COM ", password: FPASS }, undefined, o);
    assert.ok(r.ok);
    const ids = r.ok ? r.logins.map((l) => l.id).sort() : [];
    assert.deepEqual(ids, [owner.id, b.user.id].sort(), "both companies' logins fit: the page asks which");
    assert.deepEqual(await foundrySignInStep({ email: "denise@example.com", password: "nope nope" }, undefined, o), { ok: false, reason: "wrong" });
    assert.deepEqual(await foundrySignInStep({ email: "", password: "" }, undefined, o), { ok: false, reason: "wrong" });
    assert.deepEqual(await foundrySignInStep({ nope: 1 }, undefined, o), { ok: false, reason: "wrong" });
    await db.user.update({ where: { id: b.user.id }, data: { active: false } });
    r = await foundrySignInStep({ email: "denise@example.com", password: FPASS }, undefined, o);
    assert.deepEqual(r.ok && r.logins.map((l) => l.id), [owner.id], "a switched-off login does not fit");
    await db.user.update({ where: { id: b.user.id }, data: { active: true } });
    ok("the account's id opens the linked logins: any email case, wrong passwords refused, switched-off logins left out, two companies give two");

    // 5. The id decides, never the email.
    const takeover = await fetch(`${mock.url}/v1/signup`, { method: "POST", body: JSON.stringify({ email: owner.email, password: FPASS }) });
    assert.equal(takeover.status, 200, "the service lets anyone make an account for any address");
    const startedBefore = started.length;
    assert.deepEqual(await foundrySignInStep({ email: owner.email, password: FPASS }, undefined, o), { ok: false, reason: "unlinked" }, "an account made with the owner's email is not the owner");
    assert.equal(started.length, startedBefore);
    ok("a Foundry Account made with someone's StitchBench email gets nothing: only the linked id counts");

    // 6. Down, locked, per address.
    const gone = await startFoundryMock({ port: 0 });
    const deadUrl = gone.url;
    await gone.close();
    assert.deepEqual(await foundrySignInStep({ email: "denise@example.com", password: FPASS }, undefined, { ...o, baseUrl: deadUrl, timeoutMs: 1500 }), { ok: false, reason: "offline" });
    assert.deepEqual(await linkFoundryAccount({ email: owner.email, password: OLD, foundryEmail: "denise@example.com", foundryPassword: FPASS, create: false }, undefined, { ...o, baseUrl: deadUrl, timeoutMs: 1500 }), { ok: false, reason: "offline" });
    for (let i = 0; i < 5; i++) await foundrySignInStep({ email: "pat@example.com", password: "wrong wrong" }, undefined, o);
    assert.deepEqual(await foundrySignInStep({ email: "pat@example.com", password: FPASS }, undefined, o), { ok: false, reason: "wait" }, "the service's lock after five wrong");
    await withEnv({ TRUST_PROXY: "true" }, async () => {
      const req = new Request("http://localhost/", { headers: { "x-forwarded-for": "203.0.113.9" } });
      for (let i = 0; i < FOUNDRY_PER_ADDRESS; i++) await foundrySignInStep({ email: `nobody${i}@example.com`, password: "wrong wrong" }, req, o);
      assert.deepEqual(await foundrySignInStep({ email: "denise@example.com", password: FPASS }, req, o), { ok: false, reason: "wait" }, "this address has used up its tries");
      const elsewhere = new Request("http://localhost/", { headers: { "x-forwarded-for": "203.0.113.10" } });
      assert.ok((await foundrySignInStep({ email: "denise@example.com", password: FPASS }, elsewhere, o)).ok, "another address is not held back");
    });
    ok("the service being down says offline, nothing changes, its lock and this address's limit say wait");

    // 7. "only" closes the old password.
    await withEnv({ FOUNDRY_SIGNIN: "only" }, async () => {
      assert.equal(await checkSignIn({ email: owner.email, password: OLD }, undefined), null, "the old password no longer signs in");
      const ticket = mintTicket([{ id: owner.id, sv: (await db.user.findUniqueOrThrow({ where: { id: owner.id } })).sessionVersion }], null)!;
      const via = await checkSignIn({ ticket, userId: owner.id }, undefined);
      assert.equal(via?.id, owner.id, "a ticket (earned by a Foundry sign-in or a link) still opens it");
    });
    for (const v of [undefined, "on"]) {
      await withEnv({ FOUNDRY_SIGNIN: v }, async () => {
        assert.equal((await checkSignIn({ email: owner.email, password: OLD }, undefined))?.id, owner.id, `old password works with the switch ${v ?? "unset"}`);
      });
    }
    ok("only closes the old password at sign-in; off and on leave it working");

    // 8. The stored token.
    const secret = `sfs_${crypto.randomBytes(32).toString("hex")}`;
    const id = await storeFoundrySession(secret, made.account.id);
    const idHash = crypto.createHash("sha256").update(id).digest("hex");
    const row = await db.foundrySession.findUniqueOrThrow({ where: { idHash } });
    assert.ok(!row.token.includes(secret) && row.token.startsWith("v1."), "sealed, not plain");
    assert.equal(await foundryTokenOf({ idHash }), secret);
    assert.equal(await foundryTokenOf({ idHash: "0".repeat(64) }), null);
    await db.foundrySession.create({ data: { idHash: "1".repeat(64), foundryId: 1, token: row.token, expiresAt: new Date(Date.now() + 60_000) } });
    assert.equal(await foundryTokenOf({ idHash: "1".repeat(64) }), null, "a sealed token copied to another row does not open");
    await db.foundrySession.deleteMany({ where: { idHash: { in: [idHash, "1".repeat(64)] } } });
    assert.equal(await foundryTokenOf({ idHash }), null, "gone with the row");
    ok("the token is sealed to its own row and gone with it");

    console.log(`\n${steps} steps passed.`);
  } finally {
    await db.foundrySession.deleteMany({});
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
