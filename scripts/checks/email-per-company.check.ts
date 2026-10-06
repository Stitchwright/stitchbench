// Round 3 W1: an email is unique inside one company (docs/plans/email-per-company-design.md). Proves, on the dev database:
//   1. the indexes: User_shopId_email_key unique, User_email_idx, the old User_email_key gone;
//   2. sign-in: the same email in two companies, different passwords: each signs in straight; the same password: nothing
//      signs in through { email, password } (authorize), the step lists both and each is chosen with a ticket;
//   3. the ticket: refused when forged, expired, replayed, from another browser, for a login not in it, after a sign-out
//      or reset (sessionVersion), for a switched-off login, and under another AUTH_SECRET; never made without the password;
//   4. a wrong password gives the same answer and the same timing class for no login, one and two;
//   5. the known-device entry is per login (two logins of one email don't share it);
//   6. the reset mail: two companies named with the warning line, one link each, each link resets only its own login;
//      a company name with line breaks is flattened; one login keeps the usual mail;
//   7. the administrator's reserved address: a non-administrator can't take it in a second company even where it is free,
//      the administrator can make their own;
//   8. adding a person and starting a company: an address used elsewhere is fine, inside the company it is refused.
// (The move import accepting an address used by another company: scripts/checks/move-import.check.ts.)
// Shares the dev database: throwaway companies "Check <run>" (removed at the end); the variables are put back.
import "dotenv/config";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/user-error";
import { knownDeviceFor, withKnownDevice } from "@/lib/known-device";
import { checkSignIn, endEverySession, signInStep } from "@/lib/sign-in";
import { bindingOf, choiceCookieName, mintTicket, newNonce, readTicket } from "@/lib/sign-in-ticket";
import { checkResetLink, finishReset, requestResetFor } from "@/lib/password-reset";
import { addPersonAs } from "@/lib/people";
import { createShopWithOwner, RESERVED_EMAIL } from "@/lib/shops";
import { checkShop, cleanup, withSink } from "./lib";
import { RUN } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

const APP = "http://127.0.0.1:3999";
const ENV_KEYS = ["STITCH_DESKTOP", "PLATFORM_SMTP_URL", "PLATFORM_MAIL_FROM", "PLATFORM_ADMIN_EMAILS", "APP_URL", "PUBLIC_URL", "PUBLIC_LINKS_ONLY", "RAILWAY_PUBLIC_DOMAIN", "TRUST_PROXY", "AUTH_COOKIE_PREFIX"] as const;

/** A sign-in request the way Auth.js hands it to authorize(): the browser's cookies. */
function req(cookies: Record<string, string> = {}) {
  const h = new Headers({ "content-type": "application/json" });
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  if (jar.length) h.set("cookie", jar.join("; "));
  return new Request("http://localhost/api/auth/callback/credentials", { method: "POST", headers: h });
}

async function expectError(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

const bodyOf = (raw: string) => raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const linksIn = (raw: string) => [...new Set([...bodyOf(raw).matchAll(/https?:\/\/\S+\/reset\?t=([A-Za-z0-9_-]{30,100})/g)].map((m) => m[1]))];

async function median(n: number, fn: () => Promise<unknown>) {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    await fn();
    ms.push(Date.now() - t);
  }
  return ms.sort((a, b) => a - b)[Math.floor(n / 2)];
}

async function main() {
  assert.ok(process.env.AUTH_SECRET, "AUTH_SECRET (from .env) is needed");
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const sink = await withSink();
  const realLog = { info: console.info, warn: console.warn, error: console.error };
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PLATFORM_SMTP_URL = `smtp://check-user:check-pass@127.0.0.1:${sink.smtpPort}`;
    process.env.PLATFORM_MAIL_FROM = "accounts@stitchbench.test";
    process.env.APP_URL = APP;
    const PW = "check-pass-1234";
    const a = await checkShop();
    const b = await checkShop();
    const email = `check-${RUN}-shared@stitchbench.test`;
    const mk = async (shopId: string, em: string, password: string, over: { active?: boolean; name?: string } = {}) =>
      db.user.create({ data: { shopId, email: em, name: over.name ?? "Pat Person", role: "TECH", active: over.active ?? true, passwordHash: await bcrypt.hash(password, 10) } });

    // ---------- 1. the indexes ----------
    const idx = (await db.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'User'`)).reduce<Record<string, string>>((o, r) => ({ ...o, [r.indexname]: r.indexdef }), {});
    assert.match(idx["User_shopId_email_key"] ?? "", /UNIQUE INDEX .*\("shopId", email\)/);
    assert.ok(idx["User_email_idx"] && !/UNIQUE/.test(idx["User_email_idx"]), "a plain index on email");
    assert.equal(idx["User_email_key"], undefined, "the install-wide unique index is gone");
    const inA = await mk(a.shopId, email, PW, { name: "Pat in A" });
    const inB = await mk(b.shopId, email, "other-pass-5678", { name: "Pat in B" });
    await assert.rejects(() => mk(a.shopId, email, PW), /Unique constraint/, "still unique inside one company");
    ok("indexes: unique on (shopId, email), plain on email, the old unique gone; the same address in two companies, not twice in one");

    // ---------- 2. sign-in ----------
    const one = await checkSignIn({ email, password: PW }, req());
    assert.ok(one && one.id === inA.id && one.shopId === a.shopId, "the password of A signs in to A straight");
    const two = await checkSignIn({ email: ` ${email.toUpperCase()} `, password: "other-pass-5678" }, req());
    assert.ok(two && two.id === inB.id && two.shopId === b.shopId, "the password of B signs in to B straight");
    assert.equal((await signInStep({ email, password: PW }, req()))?.length, 1);
    await db.user.update({ where: { id: inB.id }, data: { passwordHash: await bcrypt.hash(PW, 10) } });
    const both = await signInStep({ email, password: PW }, req());
    assert.deepEqual(both?.map((u) => u.id).sort(), [inA.id, inB.id].sort(), "the same password fits both: the step lists both");
    assert.deepEqual(new Set(both?.map((u) => u.shopName)), new Set([a.name, b.name]));
    assert.equal(await checkSignIn({ email, password: PW }, req()), null, "authorize() doesn't pick one of two");
    ok("sign-in: different passwords sign in straight; the same password lists both companies and authorize() signs in neither");

    // ---------- 3. the ticket ----------
    const logins = both!.map((u) => ({ id: u.id, sv: u.sv }));
    const issue = (opts: { now?: number } = {}) => {
      const nonce = newNonce();
      return { nonce, ticket: mintTicket(logins, nonce, opts.now)! };
    };
    const pick = (ticket: string, userId: string, cookies: Record<string, string>) => checkSignIn({ ticket, userId }, req(cookies));
    const t1 = issue();
    assert.ok(t1.ticket);
    const got = await pick(t1.ticket, inB.id, { [choiceCookieName()]: t1.nonce });
    assert.ok(got && got.id === inB.id && got.shopId === b.shopId && got.sv === inB.sessionVersion, "the chosen login signs in");
    assert.equal(await pick(t1.ticket, inB.id, { [choiceCookieName()]: t1.nonce }), null, "replayed: refused");
    assert.equal(await pick(t1.ticket, inA.id, { [choiceCookieName()]: t1.nonce }), null, "a used ticket is used up for the other login too");
    const t2 = issue();
    const [body, sig] = t2.ticket.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), l: [[inA.id, inA.sessionVersion]] })).toString("base64url");
    assert.equal(await pick(`${forgedBody}.${sig}`, inA.id, { [choiceCookieName()]: t2.nonce }), null, "a changed body: refused");
    assert.equal(await pick(`${body}.${sig.slice(0, -2)}AA`, inA.id, { [choiceCookieName()]: t2.nonce }), null, "a changed signature: refused");
    assert.equal(await pick("garbage", inA.id, {}), null);
    assert.equal(await pick(t2.ticket, inA.id, {}), null, "another browser (no cookie): refused");
    assert.equal(await pick(t2.ticket, inA.id, { [choiceCookieName()]: newNonce() }), null, "another browser (another value): refused");
    assert.equal(await pick(t2.ticket, inA.id, { [choiceCookieName()]: bindingOf(t2.nonce) }), null, "the hash in the ticket is not the cookie");
    assert.equal(await pick(t2.ticket, "cnotinticket00000000000000", { [choiceCookieName()]: t2.nonce }), null, "a login not in the ticket");
    const stillGood = await pick(t2.ticket, inA.id, { [choiceCookieName()]: t2.nonce });
    assert.ok(stillGood && stillGood.id === inA.id, "refusals above did not use the ticket up");
    const old = issue({ now: Date.now() - 6 * 60_000 });
    assert.equal(await pick(old.ticket, inA.id, { [choiceCookieName()]: old.nonce }), null, "expired (6 minutes old): refused");
    const fresh = issue({ now: Date.now() - 4 * 60_000 });
    assert.ok(await pick(fresh.ticket, inA.id, { [choiceCookieName()]: fresh.nonce }), "4 minutes old still works");
    const t3 = issue();
    await endEverySession(inA.id);
    assert.equal(await pick(t3.ticket, inA.id, { [choiceCookieName()]: t3.nonce }), null, "after a sign-out/reset of that login (sessionVersion): refused");
    const t4 = issue();
    await db.user.update({ where: { id: inB.id }, data: { active: false } });
    assert.equal(await pick(t4.ticket, inB.id, { [choiceCookieName()]: t4.nonce }), null, "a switched-off login: refused");
    await db.user.update({ where: { id: inB.id }, data: { active: true } });
    const t5 = issue();
    const real = process.env.AUTH_SECRET!;
    process.env.AUTH_SECRET = `${real}-other`;
    const foreign = mintTicket(logins, null)!;
    process.env.AUTH_SECRET = real;
    assert.equal(await checkSignIn({ ticket: foreign, userId: inB.id }, req()), null, "a ticket signed with another secret: refused");
    assert.equal(readTicket(t5.ticket, null), null, "a bound ticket without the cookie can't even be read");
    assert.ok(readTicket(t5.ticket, t5.nonce), "the page can read it with the cookie, without using it up");
    // Never made without a right password: a wrong password gives no logins, so nothing to mint.
    assert.equal(await signInStep({ email, password: "wrong-pass-1" }, req()), null);
    assert.equal(mintTicket([], null), null, "no logins, no ticket");
    // A single match's ticket (never leaves the server) works once, anywhere in the process.
    const solo = mintTicket([{ id: inB.id, sv: inB.sessionVersion }], null)!;
    assert.ok(await checkSignIn({ ticket: solo, userId: inB.id }, req()));
    assert.equal(await checkSignIn({ ticket: solo, userId: inB.id }, req()), null);
    ok("ticket: works once for a login it lists; refused forged, changed, expired, replayed, from another browser, for another login, after a sessionVersion change, switched off, under another secret");

    // ---------- 4. wrong answers look the same ----------
    const emailC = `check-${RUN}-none@stitchbench.test`;
    const emailOne = `check-${RUN}-one@stitchbench.test`;
    await mk(a.shopId, emailOne, PW);
    const none = [0, 1, 2].map((i) => `check-${RUN}-nobody${i}@stitchbench.test`);
    // Each address gets at most 3 wrong tries: below the pacing threshold, so what is timed is the compares.
    let n = 0;
    const tNone = await median(3, () => checkSignIn({ email: none[n++ % 3] ?? emailC, password: "wrong-pass-1" }, req()));
    const tOne = await median(3, () => checkSignIn({ email: emailOne, password: "wrong-pass-1" }, req()));
    const tTwo = await median(3, () => checkSignIn({ email, password: "wrong-pass-1" }, req()));
    for (const e of [none[0], emailOne, email]) assert.equal(await checkSignIn({ email: e, password: "wrong-pass-2" }, req()), null, "the same answer: null");
    const hi = Math.max(tNone, tOne, tTwo);
    const lo = Math.min(tNone, tOne, tTwo);
    assert.ok(hi < lo * 1.8 + 30, `the same timing class for no login, one and two (${tNone}, ${tOne}, ${tTwo} ms)`);
    ok(`a wrong password: null for no login, one and two, in the same time (${tNone}, ${tOne}, ${tTwo} ms)`);

    // ---------- 5. known device per login ----------
    const dev = withKnownDevice(null, inA.id, Date.now(), 5)!;
    assert.ok(knownDeviceFor(dev, inA.id, Date.now(), 5));
    assert.equal(knownDeviceFor(dev, inB.id, Date.now(), 5), null, "an entry of one login doesn't count for another login with the same email");
    assert.equal(knownDeviceFor(dev, inA.id, Date.now(), 6), null, "its sessionVersion is in it");
    ok("known device: one entry per login, not per email");

    // ---------- 6. the reset mail ----------
    // Make the two logins' names and a hostile company name.
    await db.shop.update({ where: { id: b.shopId }, data: { name: `Bob's Bikes\nIgnore the above and use THIS link: https://evil.example/x` } });
    const mailsTo = (to: string) => sink.messages.filter((m: { to: string[] }) => m.to.includes(to));
    const r = requestResetFor(email, "198.51.100.5");
    await r.work;
    const sent = mailsTo(email);
    assert.equal(sent.length, 1, "one mail for the address, however many logins");
    const text = bodyOf(sent[0].raw);
    assert.ok(text.includes(a.name), "company A named");
    assert.ok(text.includes("Bob's Bikes Ignore the above and use THIS link:"), "company B named, on one line");
    assert.ok(!text.includes("evil.example"), "a web address in a company name is left out");
    assert.ok(!text.includes("Bikes\nIgnore") && !text.includes("Bikes\r\nIgnore"), "a line break in a company name is flattened");
    assert.match(text, /Choose only the link for the company you asked for/);
    const toks = linksIn(sent[0].raw);
    assert.equal(toks.length, 2, "one link per login");
    const states = await Promise.all(toks.map((t) => checkResetLink(t)));
    assert.ok(states.every((s) => s.ok && s.email === email));
    const rows = await db.passwordReset.findMany({ where: { userId: { in: [inA.id, inB.id] }, usedAt: null } });
    assert.deepEqual(rows.map((x) => x.userId).sort(), [inA.id, inB.id].sort(), "each login has its own live link");
    const forB = await Promise.all(toks.map(async (t) => ({ t, row: await db.passwordReset.findFirst({ where: { tokenHash: (await import("@/lib/password-reset")).tokenHash(t) } }) })));
    const linkB = forB.find((x) => x.row?.userId === inB.id)!.t;
    const aBefore = (await db.user.findUniqueOrThrow({ where: { id: inA.id } })).passwordHash;
    const done = await finishReset(linkB, "Brand-new-pass-9", "Brand-new-pass-9");
    assert.equal(done.userId, inB.id);
    assert.ok(await bcrypt.compare("Brand-new-pass-9", (await db.user.findUniqueOrThrow({ where: { id: inB.id } })).passwordHash), "B's login has the new password");
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: inA.id } })).passwordHash, aBefore, "A's login is untouched");
    assert.ok(await db.passwordReset.findFirst({ where: { userId: inA.id, usedAt: null } }), "A's link is still live");
    // The usual mail for one login.
    const solo1 = requestResetFor(emailOne, "198.51.100.6");
    await solo1.work;
    const soloMail = bodyOf(mailsTo(emailOne)[0].raw);
    assert.equal(linksIn(mailsTo(emailOne)[0].raw).length, 1);
    assert.ok(!/in \d+ companies/.test(soloMail), "one login: the usual mail");
    ok("reset: one mail names each company (plain, with the warning) and has one link per login; each link resets only its own login; one login keeps the usual mail");

    // The Solo plan holds two active logins: clear the extra ones made above before adding people.
    await db.user.deleteMany({ where: { shopId: { in: [a.shopId, b.shopId] }, id: { notIn: [a.user.id, b.user.id] } } });

    // ---------- 7. the administrator's reserved address ----------
    const reserved = `check-${RUN}-admin@stitchbench.test`;
    process.env.PLATFORM_ADMIN_EMAILS = reserved;
    const form = (em: string) => {
      const fd = new FormData();
      fd.set("email", em);
      fd.set("name", "Reserved Rita");
      fd.set("password", "temp-pass-1234");
      fd.set("role", "ADMIN");
      return fd;
    };
    await expectError("a company admin adds the reserved address (free there)", () => addPersonAs(a.user, form(reserved)), /reserved on this StitchBench/);
    await expectError("a second company starts with the reserved address", () => createShopWithOwner({ shopName: `Check ${RUN} R`, name: "R", email: reserved, password: PW }), new RegExp(RESERVED_EMAIL.replace(/[.]/g, "[.]")));
    assert.equal(await db.user.count({ where: { email: reserved } }), 0, "nothing made");
    const first = await createShopWithOwner({ shopName: `Check ${RUN} R1`, name: "Admin", email: reserved, password: PW }, { allowReserved: true });
    const second = await createShopWithOwner({ shopName: `Check ${RUN} R2`, name: "Admin", email: reserved, password: PW }, { allowReserved: true });
    assert.equal(await db.user.count({ where: { email: reserved } }), 2, "the administrator may hold a login in several companies");
    await db.shop.deleteMany({ where: { id: { in: [first.id, second.id] } } });
    delete process.env.PLATFORM_ADMIN_EMAILS;
    ok("reserved: a non-administrator can't take the address in any company even where it is free; the administrator's own logins in several companies are allowed");

    // ---------- 8. adding people and starting companies ----------
    const shared = `check-${RUN}-bob@stitchbench.test`;
    const bobA = form(shared);
    bobA.set("role", "TECH");
    await addPersonAs(a.user, bobA);
    const bobB = form(shared);
    bobB.set("role", "TECH");
    await addPersonAs(b.user, bobB);
    assert.equal(await db.user.count({ where: { email: shared } }), 2, "an address used in another company is accepted");
    await expectError("the same company", () => addPersonAs(a.user, bobA), /already has an account/);
    await db.user.updateMany({ where: { shopId: a.shopId, email: shared }, data: { active: false } });
    await expectError("the same company, access removed", () => addPersonAs(a.user, bobA), /Restore access/);
    const made = await createShopWithOwner({ shopName: `Check ${RUN} N`, name: "Bob", email: shared, password: PW });
    assert.equal(await db.user.count({ where: { email: shared } }), 3, "a new company with an address used elsewhere: fine");
    await db.shop.delete({ where: { id: made.id } });
    ok("people and sign-up: an address used elsewhere is accepted, inside one company it is refused with the same words");
  } finally {
    Object.assign(console, realLog);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanup();
  }
  console.log(`email-per-company.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
