// The desktop program's optional Foundry Account link (docs/plan.md FA-3), driving src/lib/foundry/link.ts, mode.ts, hub.ts's
// guard and the Assistant's availability against the stand-in service (scripts/test-mail/foundry-mock.mjs) and the dev database:
//   1. the switch: FOUNDRY_LINK only counts on the desktop program; unset/off, offer, required
//   2. the gate: open unless required; required and unlinked says "link it"; a TECH can't link or unlink
//   3. linking: the service's own words for a wrong password, a made account, the token sealed (never plain), an audit entry,
//      another account refused until unlinked
//   4. offline: the gate reads the database only (a dead service changes nothing), an old check is retried in the background,
//      and the balance shown is the last one the service gave
//   5. a token the service refuses closes the gate with its own words; the view says so; unlinking ends the service's session
//   6. the guard in front of every hub request, and the Assistant: required and unlinked, no request is even tried
//      (not "offline"); linked, the request goes on (and meets a hub that isn't there)
// What this does not cover: the pages (a browser) and the Electron shell.
//   npm run check scripts/checks/foundry-link.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { startFoundryMock } from "../test-mail/foundry-mock.mjs";
import { foundryLinkMode } from "@/lib/foundry/mode";
import { foundryGate, foundryLinkView, foundryTokenFor, linkFoundry, NOT_LINKED, SIGNED_OUT, unlinkFoundry, verifyLink } from "@/lib/foundry/link";
import { hubRequest } from "@/lib/hub";
import { assistantAvailable } from "@/lib/assistant/client";
import { isUserError } from "@/lib/user-error";
import { checkShop, cleanup } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
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

async function userErrorOf(p: Promise<unknown>, re: RegExp, label: string) {
  try {
    await p;
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

async function main() {
  assert.ok(process.env.AUTH_SECRET, "AUTH_SECRET (from .env) is needed to seal the token");
  const mock = await startFoundryMock({ port: 0, firstId: 2_000_000 + crypto.randomInt(1_000_000) });
  const deadMock = await startFoundryMock({ port: 0 });
  const dead = deadMock.url;
  await deadMock.close();
  const shop = await checkShop();
  const owner = { id: shop.user.id, shopId: shop.shopId, name: shop.user.name, role: "OWNER" as const };
  const tech = { ...owner, role: "TECH" as const };
  const desktop = { STITCH_DESKTOP: "1", FOUNDRY_CLOUD_URL: mock.url };
  try {
    // 1. The switch.
    await withEnv({ STITCH_DESKTOP: undefined, FOUNDRY_LINK: "required" }, async () => assert.equal(foundryLinkMode(), "off", "hosted editions never use it"));
    await withEnv({ STITCH_DESKTOP: "1", FOUNDRY_LINK: undefined }, async () => assert.equal(foundryLinkMode(), "off"));
    for (const [v, want] of [["offer", "offer"], [" REQUIRED ", "required"], ["on", "off"], ["", "off"]] as const) {
      await withEnv({ STITCH_DESKTOP: "1", FOUNDRY_LINK: v }, async () => assert.equal(foundryLinkMode(), want, `"${v}"`));
    }
    ok("FOUNDRY_LINK counts only on the desktop program: off, offer or required");

    await withEnv({ ...desktop, FOUNDRY_LINK: "offer" }, async () => {
      assert.deepEqual(await foundryGate(), { ok: true }, "offer: nothing depends on the link");
    });
    await withEnv({ ...desktop, FOUNDRY_LINK: "required" }, async () => {
      // 2. The gate.
      const g = await foundryGate();
      assert.equal(g.ok, false);
      assert.equal(!g.ok && g.why, "not-linked");
      assert.equal(!g.ok && g.message, NOT_LINKED);
      await userErrorOf(linkFoundry(tech, { email: "denise@example.com", password: FPASS, create: true }), /owner or an admin/, "a tech can't link");
      ok("required and unlinked: the gate says to link; a tech can't link");

      // 3. Linking.
      await userErrorOf(linkFoundry(owner, { email: "denise@example.com", password: FPASS, create: false }), /don't match/, "no such account");
      await userErrorOf(linkFoundry(owner, { email: "not an address", password: FPASS, create: false }), /email/i, "bad email");
      await userErrorOf(linkFoundry(owner, { email: "denise@example.com", password: "short", create: true }), /8 characters/, "a short password for a new account");
      assert.equal(await db.foundryLink.count({ where: { shopId: shop.shopId } }), 0, "nothing kept by the refusals");
      const made = await linkFoundry(owner, { email: " Denise@Example.com ", password: FPASS, create: true });
      assert.deepEqual(made, { email: "denise@example.com", creditsLeft: 100 });
      const row = await db.foundryLink.findUniqueOrThrow({ where: { shopId: shop.shopId } });
      assert.equal(row.state, "ok");
      assert.ok(row.token.startsWith("v1.") && !/sfs_/.test(row.token), "the token is sealed, not plain");
      const plain = await foundryTokenFor(shop.shopId);
      assert.match(plain ?? "", /^sfs_[0-9a-f]{64}$/);
      assert.ok(await db.auditEntry.findFirst({ where: { shopId: shop.shopId, action: "foundry.link" } }), "an audit entry");
      assert.deepEqual(await foundryGate(), { ok: true });
      assert.equal((await linkFoundry(owner, { email: "denise@example.com", password: FPASS, create: false })).email, "denise@example.com", "linking the same account again is fine");
      assert.equal(await db.foundryLink.count({ where: { shopId: shop.shopId } }), 1, "still one link");
      await fetch(`${mock.url}/v1/signup`, { method: "POST", body: JSON.stringify({ email: "pat@example.com", password: FPASS }) });
      await userErrorOf(linkFoundry(owner, { email: "pat@example.com", password: FPASS, create: false }), /different Foundry Account/, "another account while linked");
      ok("linking: the service's words, a made account, a sealed token, an audit entry; another account refused while linked");

      // 4. Offline.
      await withEnv({ FOUNDRY_CLOUD_URL: dead }, async () => {
        assert.deepEqual(await foundryGate(), { ok: true }, "a dead service changes nothing: the gate reads the database");
        await db.foundryLink.update({ where: { shopId: shop.shopId }, data: { checkedAt: new Date(Date.now() - 2 * 86_400_000) } });
        assert.deepEqual(await foundryGate(), { ok: true }, "an old check is retried in the background and never holds anyone up");
        await new Promise((r) => setTimeout(r, 700));
        const after = await db.foundryLink.findUniqueOrThrow({ where: { shopId: shop.shopId } });
        assert.equal(after.state, "ok", "an unreachable service is not 'signed out'");
        assert.equal((await verifyLink(shop.shopId, { timeoutMs: 1500 })).state, "unreachable");
        const v = await foundryLinkView(shop.shopId);
        assert.equal(v?.linked, true);
        assert.equal(v?.reachable, false);
        assert.equal(v?.creditsLeft, 100, "the last balance the service gave");
      });
      const fresh = await foundryLinkView(shop.shopId);
      assert.equal(fresh?.reachable, true);
      ok("offline: the gate and the link stay as they are, and the view shows the last balance");

      // 5. A token the service refuses.
      await fetch(`${mock.url}/__expire`, { method: "POST", body: JSON.stringify({ email: "denise@example.com" }) });
      assert.equal((await verifyLink(shop.shopId)).state, "signed-out");
      const closed = await foundryGate();
      assert.equal(!closed.ok && closed.why, "signed-out");
      assert.equal(!closed.ok && closed.message, SIGNED_OUT);
      assert.equal(await foundryTokenFor(shop.shopId), null, "no token is handed out for a link the service refused");
      assert.equal((await foundryLinkView(shop.shopId))?.state, "signed-out");
      // Unlink, then link again: it works as a first time.
      const before = mock.requests.length;
      await unlinkFoundry(owner);
      assert.equal(await db.foundryLink.count({ where: { shopId: shop.shopId } }), 0);
      assert.ok(mock.requests.slice(before).some((r: { route: string }) => r.route === "POST /v1/signout"), "the service's session is ended too");
      assert.equal((await foundryGate()).ok, false);
      await userErrorOf(unlinkFoundry(tech), /owner or an admin/, "a tech can't unlink");
      await linkFoundry(owner, { email: "denise@example.com", password: FPASS, create: false });
      assert.deepEqual(await foundryGate(), { ok: true });
      ok("a refused token closes the gate in the service's words; unlinking ends its session; linking again works");

      // 6. The guard in front of the hub and the Assistant.
      await db.foundryLink.deleteMany({ where: { shopId: shop.shopId } });
      const calls = mock.requests.length;
      await userErrorOf(hubRequest("http://127.0.0.1:1", "/v1/me", { method: "GET" }), /Link your Foundry Account/, "no hub traffic without the link");
      const a = await assistantAvailable(shop.shopId, { module: false });
      assert.equal(!a.ok && a.why, "foundry");
      assert.equal(mock.requests.length, calls, "no request to the hub or the service was tried to find that out");
      await linkFoundry(owner, { email: "denise@example.com", password: FPASS, create: false });
      await userErrorOf(hubRequest("http://127.0.0.1:1", "/v1/me", { method: "GET" }), /community hub right now|internet/i, "linked: the request goes on and meets a hub that isn't there");
      const b = await assistantAvailable(shop.shopId, { module: false });
      assert.equal(!b.ok && b.why, "no-hub", "linked: the Assistant's own checks follow");
      ok("required and unlinked: no hub request and no Assistant; linked: both go on to their own checks");
    });
    // And with the switch off (or hosted), the same calls are untouched.
    await withEnv({ STITCH_DESKTOP: undefined, FOUNDRY_LINK: "required" }, async () => {
      await db.foundryLink.deleteMany({ where: { shopId: shop.shopId } });
      assert.deepEqual(await foundryGate(), { ok: true });
      await userErrorOf(hubRequest("http://127.0.0.1:1", "/v1/me", { method: "GET" }), /community hub right now|internet/i, "hosted: the hub guard is open");
      const h = await assistantAvailable(shop.shopId, { module: false });
      assert.notEqual(!h.ok && h.why, "foundry", "hosted: the Assistant is not held for a link it doesn't have");
    });
    ok("hosted editions are untouched whatever FOUNDRY_LINK says");
    console.log(`\n${steps} steps passed.`);
  } finally {
    await db.foundryLink.deleteMany({ where: { shopId: shop.shopId } });
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
