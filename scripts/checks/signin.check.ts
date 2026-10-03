// Sign-in and sessions (round 3 batch C: M44, L42, I20, I22), driving src/lib/sign-in.ts (Auth.js' authorize()) and
// src/lib/known-device.ts directly:
//   1. the known-device cookie: an entry proves only its own login, tampered, expired, future and foreign entries are
//      refused, 10 entries at most (newest first), the cookie read from a Cookie header, off without AUTH_SECRET
//   2. plain sign-in: the right password, a wrong one, an unknown or switched-off login, a malformed email
//   3. the lockout (M44): 5 wrong, then a flood fills the account's queue (20) and the rest are refused, the right
//      password too, from a browser that never signed in; a browser that did gets straight in, a different login's entry
//      doesn't count, the known browser's own count (5 wrong, then it is paced like any other), the account's count left
//      for the guesser
//   4. the per-address limit (I20) with TRUST_PROXY=true: the last X-Forwarded-For hop, 50 wrong from one address and
//      then that address is refused, a known browser too; another address and no TRUST_PROXY are not
//   5. a password reset during a flood: the link sets the password and ends every session (sessionVersion + 1); the
//      browser it was used in (the cookie finishPasswordReset sets) gets in with the new password, not the old one
//   6. sessionVersion (L42): signing out ends every session of that login and nobody else's; sign-in hands the new one out
//   7. first-run sign-up (I20, I22): SETUP_TOKEN's first-company-only and the administrator's reserved address refused
//      once a company exists, nothing made
//   npm run check scripts/checks/signin.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end); the variables are put back. The
// flooded tries stay queued in this process for minutes by design, so it exits when done instead of waiting for them.
import "dotenv/config";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/user-error";
import { KNOWN_DEVICE_DAYS, knownDeviceCookie, knownDeviceCookieName, knownDeviceFor, withKnownDevice } from "@/lib/known-device";
import { checkSignIn, endEverySession, FREE_TRIES, PER_ADDRESS, PER_DEVICE, QUEUE_CAP } from "@/lib/sign-in";
import { finishReset, issueResetLink } from "@/lib/password-reset";
import { createShopWithOwner, RESERVED_EMAIL } from "@/lib/shops";
import { checkShop, cleanup } from "./lib";
import { RUN } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

const PASSWORD = "check-pass-1234"; // what scripts/checks/tenant.ts gives each owner
const DAY = 86_400_000;

/** A sign-in request the way Auth.js hands it to authorize(): the browser's cookies and, behind a proxy, the address. */
function req(o: { device?: string | null; xff?: string } = {}) {
  const h = new Headers({ "content-type": "application/json" });
  if (o.device) h.set("cookie", `authjs.csrf-token=x; ${knownDeviceCookieName()}=${encodeURIComponent(o.device)}; other=1`);
  if (o.xff) h.set("x-forwarded-for", o.xff);
  return new Request("http://localhost/api/auth/callback/credentials", { method: "POST", headers: h });
}

const signIn = (email: string, password: string, o: { device?: string | null; xff?: string } = {}) => checkSignIn({ email, password }, req(o));

async function timed<T>(p: Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await p;
  return { value, ms: Date.now() - t0 };
}

/** Sets variables for `fn`, then puts them back. */
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

/** Sends `n` wrong passwords for `email` at once, without waiting: the ones the queue takes stay pending for minutes. */
function flood(email: string, n: number, o: { xff?: string } = {}) {
  const tries: Promise<unknown>[] = [];
  for (let i = 0; i < n; i++) tries.push(signIn(email, `wrong-${i}`, o));
  return tries;
}

/** Settles within `ms`, or "pending". */
const within = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), ms))]);

/**
 * Doesn't get in: refused, or still held after 1.5 s behind the flood's queue (the queued tries wait 1, 2, 4 ... 30 s
 * each, one after another: minutes). Once the first queued try has run there is room for one more, so a try may be
 * queued rather than refused.
 */
async function heldOut(label: string, p: Promise<unknown>) {
  const r = await Promise.race([p.then((v) => ({ v })), new Promise<"pending">((res) => setTimeout(() => res("pending"), 1500))]);
  if (r !== "pending") assert.equal(r.v, null, label);
}

async function main() {
  assert.ok(process.env.AUTH_SECRET, "AUTH_SECRET (from .env) is needed: the known-device cookie is keyed from it");
  await withEnv({ TRUST_PROXY: undefined, AUTH_COOKIE_PREFIX: undefined, APP_URL: "http://localhost:3000", STITCH_DESKTOP: undefined }, async () => {
    const a = await checkShop();
    const b = await checkShop();
    try {
      const ownerA = a.user.email;
      const ownerB = b.user.email;
      const mk = async (label: string, active = true) =>
        db.user.create({
          data: { shopId: a.shopId, email: `check-${RUN}-${label}@stitchbench.test`, name: `Check ${label}`, role: "TECH", active, passwordHash: await bcrypt.hash(PASSWORD, 10) },
        });
      const techC = await mk("c");
      const off = await mk("off", false);

      // 1. The cookie itself.
      const now = Date.now();
      const v1 = withKnownDevice(null, ownerA, now)!;
      assert.match(v1, /^[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
      assert.ok(!v1.includes("@") && !v1.includes("check-"), "no email in the cookie");
      assert.ok(knownDeviceFor(v1, ownerA, now));
      assert.equal(knownDeviceFor(v1, ownerB, now), null, "an entry proves only its own login");
      const tampered = v1.slice(0, -2) + (v1.endsWith("AA") ? "BB" : "AA");
      assert.equal(knownDeviceFor(tampered, ownerA, now), null, "a changed mac");
      const [t, m] = v1.split(".");
      assert.equal(knownDeviceFor(`${(parseInt(t, 36) + 1).toString(36)}.${m}`, ownerA, now), null, "a changed time");
      assert.equal(knownDeviceFor(withKnownDevice(null, ownerA, now - (KNOWN_DEVICE_DAYS + 1) * DAY), ownerA, now), null, "older than 180 days");
      assert.ok(knownDeviceFor(withKnownDevice(null, ownerA, now - (KNOWN_DEVICE_DAYS - 1) * DAY), ownerA, now), "179 days old still counts");
      assert.equal(knownDeviceFor(withKnownDevice(null, ownerA, now + DAY), ownerA, now), null, "from the future");
      assert.equal(knownDeviceFor("junk~1.2~", ownerA, now), null);
      // A shared tablet: one entry per login, the newest first, 10 at most; signing in again moves that login's entry up.
      let shared: string | null = null;
      for (let i = 0; i < 12; i++) shared = withKnownDevice(shared, `tablet${i}@shop`, now + i);
      assert.equal(shared!.split("~").length, 10);
      assert.ok(knownDeviceFor(shared, "tablet11@shop", now + 20) && knownDeviceFor(shared, "tablet2@shop", now + 20));
      assert.equal(knownDeviceFor(shared, "tablet1@shop", now + 20), null, "the oldest went");
      shared = withKnownDevice(shared, "tablet2@shop", now + 30);
      assert.equal(shared!.split("~").length, 10, "no second entry for the same login");
      assert.equal(knownDeviceFor(shared!.split("~")[0], "tablet2@shop", now + 30) !== null, true, "and it is first");
      // Read from a Cookie header among others; the Windows program's prefix names it.
      assert.equal(knownDeviceCookie(req({ device: v1 })), v1);
      assert.equal(knownDeviceCookie(req()), null);
      await withEnv({ AUTH_COOKIE_PREFIX: "StitchShop" }, async () => assert.equal(knownDeviceCookieName(), "StitchShop.known-device"));
      assert.equal(knownDeviceCookieName(), "known-device");
      await withEnv({ AUTH_SECRET: undefined }, async () => {
        assert.equal(withKnownDevice(null, ownerA), null);
        assert.equal(knownDeviceFor(v1, ownerA), null);
      });
      ok("the known-device cookie: own login only, no email in it, tampered/expired/future refused, 10 entries, off without AUTH_SECRET");

      // 2. Plain sign-in.
      const me = await signIn(` ${ownerB.toUpperCase()} `, PASSWORD);
      assert.ok(me && me.id === b.user.id && me.shopId === b.shopId && me.role === "OWNER" && me.sv === 0, "trimmed, any case");
      assert.equal(await signIn(ownerB, "not-it"), null);
      assert.equal(await signIn(off.email, PASSWORD), null, "access removed");
      assert.equal(await signIn(`nobody-${RUN}@stitchbench.test`, PASSWORD), null);
      assert.equal(await checkSignIn({ email: "no at sign", password: PASSWORD }, req()), null);
      assert.equal(await checkSignIn({ email: ownerB, password: "" }, req()), null);
      ok("sign-in: the right password, wrong, switched off, unknown and malformed");

      // 3. The lockout (M44). Owner A signed in on a browser before (the sign-in page set this cookie then).
      const browserA = withKnownDevice(null, ownerA, Date.now() - 3 * DAY);
      for (let i = 0; i < FREE_TRIES; i++) assert.equal(await signIn(ownerA, `wrong-${i}`), null);
      const queued = flood(ownerA, QUEUE_CAP + 5);
      const settled = await Promise.all(queued.map((p) => within(p, 300)));
      assert.equal(settled.filter((s) => s === "pending").length, QUEUE_CAP, "20 wait in the queue");
      assert.equal(settled.filter((s) => s === "settled").length, 5, "the rest refused at once");
      // The right password from a browser that never signed in: refused, at once (the lockout this fixes for known ones).
      const stranger = await timed(signIn(ownerA, PASSWORD));
      assert.equal(stranger.value, null, "a full queue refuses the right password from an unknown browser");
      assert.ok(stranger.ms < 1000, `refused at once (${stranger.ms} ms)`);
      // The same from the owner's own browser: straight in.
      const known = await timed(signIn(ownerA, PASSWORD, { device: browserA }));
      assert.ok(known.value && known.value.id === a.user.id, "the known browser gets in during the flood");
      assert.ok(known.ms < 2000, `without waiting in the queue (${known.ms} ms)`);
      // Another login's entry doesn't make the browser known for this one.
      await heldOut("another login's entry", signIn(ownerA, PASSWORD, { device: withKnownDevice(null, techC.email) }));
      // The owner's sign-in gives the guesser no fresh start: unknown browsers are still held back.
      await heldOut("an unknown browser after the owner signed in", signIn(ownerA, PASSWORD));
      ok("M44: a full queue refuses an unknown browser, the owner's known browser gets straight in");

      // The known browser's own count: 5 wrong (each answered at once), then it is paced like any other (here: the full queue).
      const stolen = withKnownDevice(null, ownerA, Date.now() - 2 * DAY);
      for (let i = 0; i < PER_DEVICE; i++) {
        const r = await timed(signIn(ownerA, `guess-${i}`, { device: stolen }));
        assert.equal(r.value, null);
        assert.ok(r.ms < 2000, `known browser's wrong try ${i + 1} not queued (${r.ms} ms)`);
      }
      await heldOut("after 5 wrong it is no longer exempt", signIn(ownerA, PASSWORD, { device: stolen }));
      // Another of the owner's browsers is unaffected, and its right password clears only its own count.
      assert.ok(await signIn(ownerA, PASSWORD, { device: browserA }));
      ok("M44: a known browser has its own count (5 wrong, then queued like any other); other known browsers unaffected");

      // 4. The per-address limit (I20): only behind a proxy we trust; the address is the last X-Forwarded-For hop.
      await withEnv({ TRUST_PROXY: "true" }, async () => {
        const here = "198.51.100.1, 203.0.113.7"; // the sender wrote the first hop, the proxy the last
        const tries: Promise<unknown>[] = [];
        for (let i = 0; i < PER_ADDRESS / FREE_TRIES; i++) {
          for (let j = 0; j < FREE_TRIES; j++) tries.push(signIn(`nobody-${RUN}-${i}@stitchbench.test`, "wrong", { xff: here }));
        }
        assert.deepEqual(new Set(await Promise.all(tries)), new Set([null]));
        const deviceC = withKnownDevice(null, techC.email);
        assert.equal(await signIn(techC.email, PASSWORD, { xff: here }), null, "the address is refused, right password or not");
        assert.equal(await signIn(techC.email, PASSWORD, { xff: "203.0.113.7" }), null, "the same address however the header starts");
        assert.equal(await signIn(techC.email, PASSWORD, { xff: here, device: deviceC }), null, "a known browser too");
        assert.ok(await signIn(techC.email, PASSWORD, { xff: "203.0.113.7, 198.51.100.9" }), "another last hop is another address");
        // The refused tries never reached the login's own count: from anywhere else it signs in.
        assert.ok(await signIn(techC.email, PASSWORD, { xff: "203.0.113.8" }));
      });
      // Without TRUST_PROXY the header is whatever the sender wrote: no per-address limit at all.
      assert.ok(await signIn(techC.email, PASSWORD, { xff: "203.0.113.7" }));
      ok("I20: 50 wrong from one address (last X-Forwarded-For hop) and it is refused, a known browser too; only with TRUST_PROXY");

      // 5. A password reset while owner B's account is flooded: the link's browser gets in with the new password.
      const svB = (await db.user.findUniqueOrThrow({ where: { id: b.user.id } })).sessionVersion;
      for (let i = 0; i < FREE_TRIES; i++) assert.equal(await signIn(ownerB, `wrong-${i}`), null);
      const floodB = await Promise.all(flood(ownerB, QUEUE_CAP + 2).map((p) => within(p, 300)));
      assert.equal(floodB.filter((s) => s === "pending").length, QUEUE_CAP);
      const { link } = await issueResetLink(b.user.id, "reset", 1);
      const token = new URL(link).searchParams.get("t")!;
      const fresh = "a-new-password-5678";
      const { email: resetEmail } = await finishReset(token, fresh, fresh);
      assert.equal(resetEmail, ownerB);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: b.user.id } })).sessionVersion, svB + 1, "the reset ends every session");
      // What finishPasswordReset sets in the browser that used the link (rememberThisDevice(email)).
      const resetBrowser = withKnownDevice(null, resetEmail);
      const after = await timed(signIn(ownerB, fresh, { device: resetBrowser }));
      assert.ok(after.value && after.value.id === b.user.id && after.value.sv === svB + 1, "in, with the new sessionVersion");
      assert.ok(after.ms < 2000, `not queued (${after.ms} ms)`);
      assert.equal(await signIn(ownerB, PASSWORD, { device: resetBrowser }), null, "the old password no longer works");
      await heldOut("a browser that never signed in still waits out the flood", signIn(ownerB, fresh));
      ok("M44 + reset: during a flood, the browser the reset link was used in signs in with the new password (sessionVersion + 1)");

      // 6. Signing out (L42): every session of that login ends, nobody else's.
      const before = await db.user.findMany({ where: { id: { in: [a.user.id, b.user.id, techC.id] } }, select: { id: true, sessionVersion: true } });
      const sv = (id: string) => before.find((u) => u.id === id)!.sessionVersion;
      const tokenSv = (await signIn(techC.email, PASSWORD))!.sv; // what the cookie of a signed-in device carries
      assert.equal(tokenSv, sv(techC.id));
      await endEverySession(techC.id);
      const now2 = await db.user.findMany({ where: { id: { in: [a.user.id, b.user.id, techC.id] } }, select: { id: true, sessionVersion: true } });
      for (const u of now2) assert.equal(u.sessionVersion, sv(u.id) + (u.id === techC.id ? 1 : 0), u.id);
      // sessionUser() (src/lib/session.ts) ends a session whose cookie's sv isn't the login's: every copy of that cookie.
      assert.notEqual(now2.find((u) => u.id === techC.id)!.sessionVersion, tokenSv);
      assert.equal((await signIn(techC.email, PASSWORD))!.sv, tokenSv + 1, "signing in again hands out the new one");
      await endEverySession("cnotarealid0000000000000"); // a login removed meanwhile: nothing to do, no error
      ok("L42: signing out ends every session of that login (sessionVersion + 1), nobody else's; the next sign-in carries the new one");

      // 7. First-run sign-up (I20, I22): the Windows program's SETUP_TOKEN sign-up is for the first company only, and the
      // administrator's reserved address can't be taken once a company exists. Nothing is made.
      const shopsBefore = await db.shop.count();
      const firstRun = { shopName: `Check ${RUN} late`, name: "Late", email: `check-${RUN}-late@stitchbench.test`, password: PASSWORD };
      await expectError("SETUP_TOKEN sign-up after the first company", () => createShopWithOwner(firstRun, { firstOnly: true }), /already has its company/);
      const reserved = `check-${RUN}-admin@stitchbench.test`;
      await withEnv({ PLATFORM_ADMIN_EMAILS: reserved }, () =>
        expectError("the administrator's address", () => createShopWithOwner({ ...firstRun, email: reserved }), new RegExp(RESERVED_EMAIL.replace(/[.]/g, "[.]"))),
      );
      assert.equal(await db.shop.count(), shopsBefore);
      assert.equal(await db.user.count({ where: { email: { in: [firstRun.email, reserved] } } }), 0);
      ok("I20/I22: SETUP_TOKEN sign-up refused once a company exists; the reserved address refused; nothing made");
    } finally {
      await cleanup();
    }
  });
  console.log(`signin.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    // The flooded tries are still queued (minutes of waits, by design): don't wait for them.
    process.exit(process.exitCode ?? 0);
  });
