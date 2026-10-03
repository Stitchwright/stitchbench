// The program's own license, the "base" module (hub-accounts-billing-design.md 3.5, package base-license):
//   1. the key verifies and gates: the hub scope counts as pasted and never as the Companies switch; a dev key for
//      "base" switches it on; the read-only message
//   2. off = working: a company with no key at all is judged writable everywhere
//   3. lapsed = read-only: safe() refuses an unlisted action and lets an allow-listed one through, the by-hand rules
//      (a sale refused, a return and a void allowed), /api/photos' 403, public booking paused, the message worker skips
//      the company; and the allow-list's names all exist
//   4. the hub, mocked by a tiny HTTP server in this process: door 1 from a never-joined install (pending → member),
//      "send it again", 409 and 503 in words, every company claimed with the new fields, the hub's key stored as the
//      one hub row, replaced, revoked (pasted keys untouched), a key for another company ignored, no key = keep what
//      is there, the link code and its 409, "Check again", the reset opt-in
//   5. tenant: company B learns and changes nothing of A's
//   npm run check scripts/checks/base-license.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end); the HubState row and every company's
// hub fields are put back as they were. Nothing is mailed (the mock has no mail).
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { db } from "@/lib/db";
import { safe } from "@/lib/action";
import { isUserError } from "@/lib/user-error";
import { baseResponse, baseWritable, requireBaseWritable } from "@/lib/base-gate";
import { lapseUserFrom } from "@/lib/lapse-guard";
import { BY_HAND, WHILE_LAPSED } from "@/lib/lapse-allow";
import { acceptScope, addDaysYmd, encodeLicense, newKeyId, verifyLicense, type LicensePayload, type PublicKeys } from "@/lib/license";
import { blockedMessage, MODULES, programName, readOnlyMessage } from "@/lib/module-info";
import { loadModules, shopsWithModule, verifyFor } from "@/lib/modules";
import { hubState, syncHub } from "@/lib/hub";
import { accountView, linkCodeFor, refreshStandingFor, requireAccountOwner, setResetOptInFor, startHubAccountFor, TERMS_VERSION } from "@/lib/hub-account";
import { applyStanding } from "@/lib/hub-standing";
import { publicShop } from "@/lib/online-booking";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import type { CurrentUser } from "@/lib/session";
import { devLicenseKey, grantDevLicense } from "../license/dev";
import { checkShop, cleanup } from "./lib";
import { assertUnchanged, RUN, snapshot } from "./tenant";

const DAY = 86_400_000;
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const today = () => new Date().toISOString().slice(0, 10);
const payloadOf = (key: string) => JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")) as LicensePayload;

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
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

// ---------- the mock hub ----------

type Claim = { auth: string | null; body: Record<string, unknown> };
type Mock = {
  url: string;
  installKey: string | null;
  scope: "pending" | "member";
  startMode: "ok" | "409" | "503";
  linkMode: "ok" | "409";
  account: { email: string; verified: boolean } | null;
  accountFor: string | null; // the shopRef the account belongs to
  keyFor: Map<string, string | null>;
  revokeFor: Map<string, string[]>;
  claims: Claim[];
  starts: Claim[];
  links: Claim[];
  close(): Promise<void>;
};

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

async function startMock(): Promise<Mock> {
  const m = {
    installKey: null,
    scope: "pending",
    startMode: "ok",
    linkMode: "ok",
    account: null,
    accountFor: null,
    keyFor: new Map(),
    revokeFor: new Map(),
    claims: [],
    starts: [],
    links: [],
  } as unknown as Mock;
  const standing = (shopRef: string, body: Record<string, unknown>) => {
    const lastDay = addDaysYmd(today(), 29);
    return {
      shop: { id: `hs_${shopRef}`, shopRef, name: body.shopName ?? null, kind: body.kind ?? "repair", standing: "trial", lastDay, message: `Free trial through ${lastDay}.` },
      account: m.accountFor === shopRef ? m.account : null,
      standing: "trial",
      lastDay,
      message: `Free trial through ${lastDay}.`,
      key: m.keyFor.get(shopRef) ?? null,
      revokeKeyIds: m.revokeFor.get(shopRef) ?? [],
    };
  };
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const auth = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    if (p === "/health") return send(200, { ok: true });
    if (p === "/v1/accounts/start" && req.method === "POST") {
      const body = await readJson(req);
      m.starts.push({ auth, body });
      if (m.startMode === "503") return send(503, { error: "This hub doesn't know its own address yet: set HUB_URL (https://hub.example.com)." });
      if (m.startMode === "409") return send(409, { error: 'That address already has a StitchHub account. Choose "I already have an account" and connect this shop with a link code.' });
      if (auth && auth !== m.installKey) return send(401, { error: "This install isn't known to the hub." });
      m.account = { email: String(body.email), verified: false };
      m.accountFor = String(body.shopRef);
      const out: Record<string, unknown> = { ok: true, account: m.account, shop: standing(String(body.shopRef), body).shop };
      if (!auth) {
        m.installKey = `shk_${crypto.randomBytes(24).toString("base64url")}`;
        m.scope = "pending";
        Object.assign(out, { installId: "inst_mock", installKey: m.installKey, hubName: "Mock hub", scope: "pending" });
      }
      return send(200, out);
    }
    if (!auth || auth !== m.installKey) return send(401, { error: "Join the hub first (Settings → Community hub)." });
    if (p === "/v1/me") return send(200, { installId: "inst_mock", name: "Mock install", scope: m.scope, hubName: "Mock hub", discordInvite: null });
    if (p === "/v1/shops/claim" && req.method === "POST") {
      const body = await readJson(req);
      m.claims.push({ auth, body });
      return send(200, { ok: true, listings: 0, ...standing(String(body.shopRef), body) });
    }
    const st = /^\/v1\/shops\/([^/]+)\/standing$/.exec(p);
    if (st) return send(200, standing(decodeURIComponent(st[1]), {}));
    if (p === "/v1/accounts/link-code" && req.method === "POST") {
      const body = await readJson(req);
      m.links.push({ auth, body });
      if (m.linkMode === "409") return send(409, { error: "This shop is already connected to a StitchHub account." });
      return send(200, { code: "ABCDE-FGHJK", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
    }
    if (p === "/v1/changes") return send(200, { links: [], posts: [], figures: [], xparts: [], listings: [], next: "0", more: false });
    if (p === "/v1/orders") return send(200, { orders: [], next: "0" });
    return send(404, { error: "Not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  m.url = `http://127.0.0.1:${port}`;
  m.close = () => new Promise<void>((r) => server.close(() => r()));
  return m;
}

// ---------- main ----------

const HUB_FIELDS = ["hubAccountEmail", "hubAccountVerified", "hubStanding", "hubStandingAt", "hubStandingUntil", "hubStandingNote", "hubResetOptIn", "termsVersion"] as const;

async function main() {
  const savedHub = await hubState();
  const savedShops = await db.shop.findMany({
    select: {
      id: true,
      hubAccountEmail: true,
      hubAccountVerified: true,
      hubStanding: true,
      hubStandingAt: true,
      hubStandingUntil: true,
      hubStandingNote: true,
      hubResetOptIn: true,
      termsVersion: true,
    },
  });
  const savedDefault = process.env.DEFAULT_HUB_URL;
  const mock = await startMock();
  let who: CurrentUser | null = null;
  lapseUserFrom(async () => who);
  try {
    // ---------- 1. the key verifies and gates ----------
    const hubPair = crypto.generateKeyPairSync("ed25519");
    const keys: PublicKeys = { hubx: { x: (hubPair.publicKey.export({ format: "jwk" }) as { x: string }).x, scope: "hub" } };
    const hubKey = encodeLicense(
      { v: 1, k: "hubx", id: newKeyId(), s: "shop1", n: "Shop", m: ["base"], p: "t", f: today(), u: addDaysYmd(today(), 29), g: 14, t: new Date().toISOString() },
      hubPair.privateKey,
    );
    const v = verifyLicense(hubKey, keys);
    assert.ok(v.ok && v.scope === "hub" && v.payload.m[0] === "base");
    const ctx = { devAllowed: false, hostedHeld: true };
    assert.equal(acceptScope("hub", "pasted", ctx), true, "a hub key counts like a pasted one");
    assert.equal(acceptScope("hub", "grant", ctx), false, "a hub key never counts as the Companies switch");
    assert.equal(acceptScope("hub", "grant", { devAllowed: true, hostedHeld: true }), false);
    assert.equal(MODULES.base.href, "/settings/account");
    assert.equal(MODULES.base.label, programName());
    ok("a hub-scope key verifies, counts as pasted and never as the Companies switch");

    const a = await checkShop({ retail: true, repair: true, modules: ["scheduling", "marketing"] });
    const b = await checkShop({ retail: true, repair: true, modules: ["scheduling", "marketing"] });
    const devBase = devLicenseKey({ shopId: a.shopId, modules: ["base"], plan: "t", from: addDaysYmd(today(), -1), until: addDaysYmd(today(), 28), grace: 14 });
    assert.ok(verifyFor(devBase, "pasted").ok, "a development key for base verifies in a check script");
    ok("two companies, and a dev key for the program itself verifies");

    // ---------- 2. off = working ----------
    let m = await loadModules(a.shopId);
    assert.equal(m.states.base.status, "off");
    assert.equal(await baseWritable(a.shopId), true, "off is fully working");
    await requireBaseWritable(a.user);
    assert.equal(await baseResponse(a.shopId), null);
    who = a.user;
    let calls = 0;
    const plain = safe(async () => {
      calls += 1;
    });
    assert.deepEqual(await plain(), { ok: true });
    assert.equal(calls, 1);
    const slug = `check-${RUN}-a`;
    await db.shop.update({ where: { id: a.shopId }, data: { bookingSlug: slug, bookingOn: true } });
    assert.equal((await publicShop(slug))?.open, true);
    assert.deepEqual((await shopsWithModule("marketing", [a.shopId, b.shopId])).sort(), [a.shopId, b.shopId].sort());
    const sale = await completeSaleAs(a.user, { lines: [{ description: "Thread", qty: 1, unitPriceCents: 500, taxable: false }], tenders: [{ method: "CASH", amountCents: 500 }] });
    const sale2 = await completeSaleAs(a.user, {
      lines: [{ description: "Needles", qty: 1, unitPriceCents: 300, taxable: false }],
      tenders: [{ method: "CASH", amountCents: 300 }],
      clientKey: `chk-${RUN}-s2-000000`,
    });
    assert.match(blockedMessage(m.states.base, true), /isn't licensed/);
    ok("off = working: safe() passes, booking open, the worker runs the company, a sale rings up");

    // ---------- 3. lapsed = read-only ----------
    const lapsedKey = await grantDevLicense(a.shopId, ["base"], { from: addDaysYmd(today(), -60), until: addDaysYmd(today(), -20), grace: 14, plan: "m", issuedAt: new Date(Date.now() - 60 * DAY) });
    m = await loadModules(a.shopId);
    assert.equal(m.states.base.status, "lapsed");
    assert.ok(m.states.base.endedAt);
    assert.equal(await baseWritable(a.shopId), false);
    const msg = readOnlyMessage(m.states.base, true);
    assert.match(msg, new RegExp(`^${programName()} for this company is read-only since .* Subscribe in Settings → Account\\.$`));
    assert.equal(blockedMessage(m.states.base, true), msg);
    assert.match(readOnlyMessage(m.states.base, false), /Ask the shop owner/);
    await expectError("requireBaseWritable", () => requireBaseWritable(a.user), /read-only since/);
    const r403 = await baseResponse(a.shopId);
    assert.equal(r403?.status, 403);
    assert.match(await r403!.text(), /read-only since/);
    ok("a lapsed base: read-only message, requireBaseWritable throws, route handlers get a 403");

    who = a.user;
    calls = 0;
    const refused = await plain();
    assert.match(refused.error ?? "", /read-only since/);
    assert.equal(calls, 0, "the body never ran");
    const allowed = safe(
      async () => {
        calls += 1;
      },
      { whileLapsed: "addPayment" },
    );
    assert.deepEqual(await allowed(), { ok: true });
    assert.equal(calls, 1);
    who = b.user;
    assert.deepEqual(await plain(), { ok: true }, "another company isn't touched");
    who = null;
    assert.deepEqual(await plain(), { ok: true }, "nobody signed in: the action's own checks decide");
    who = a.user;
    ok("safe(): refuses an unlisted action while lapsed, lets a whileLapsed one through, judges only the signed-in company");

    await expectError(
      "a sale while lapsed",
      () => completeSaleAs(a.user, { lines: [{ description: "Thread", qty: 1, unitPriceCents: 500, taxable: false }], tenders: [{ method: "CASH", amountCents: 500 }] }),
      /read-only since/,
    );
    const ret = await completeSaleAs(a.user, { lines: [{ description: "Thread (returned)", qty: -1, unitPriceCents: 500, taxable: false }], tenders: [{ method: "CASH", amountCents: -500 }] });
    assert.ok(ret.saleId, "a return (every line money back) still goes through");
    await voidSaleAs(a.user, sale2.saleId, "rung up by mistake");
    assert.equal((await db.sale.findUniqueOrThrow({ where: { id: sale2.saleId }, select: { status: true } })).status, "VOIDED");
    assert.equal((await publicShop(slug))?.open, false, "public booking is paused");
    assert.deepEqual(await shopsWithModule("marketing", [a.shopId, b.shopId]), [b.shopId], "the message worker skips the company");
    assert.deepEqual(await shopsWithModule("scheduling", [a.shopId, b.shopId]), [b.shopId]);
    void sale;
    ok("by hand: a sale refused, a return and a void allowed; booking paused; workers skip the company");

    // The allow-list names exist: each safe() action carries its own name, each by-hand one is a function in src/actions.
    const actionsDir = path.join(process.cwd(), "src", "actions");
    const sources = fs
      .readdirSync(actionsDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => fs.readFileSync(path.join(actionsDir, f), "utf8"))
      .join("\n");
    for (const name of WHILE_LAPSED) assert.ok(sources.includes(`export const ${name} = safe.whileLapsed("${name}")(`), `${name} is a safe.whileLapsed action naming itself`);
    for (const name of BY_HAND) assert.match(sources, new RegExp(`export async function ${name}\\(`), `${name} is an action`);
    const tags = [...sources.matchAll(/safe\.whileLapsed\("([A-Za-z]+)"\)/g)].map((x) => x[1]);
    for (const t of tags) assert.ok((WHILE_LAPSED as readonly string[]).includes(t), `${t} is on the allow-list`);
    ok(`the allow-list's ${WHILE_LAPSED.length} names and ${BY_HAND.length} by-hand names all exist, and no action names itself outside the list`);

    // Back to off: the key goes, and everything works again.
    await db.license.deleteMany({ where: { shopId: a.shopId, keyId: payloadOf(lapsedKey).id } });
    assert.equal((await loadModules(a.shopId)).states.base.status, "off");
    assert.equal((await publicShop(slug))?.open, true);
    ok("the lapsed key removed: off = working again");

    // ---------- 4. the hub, mocked ----------
    process.env.DEFAULT_HUB_URL = mock.url;
    const never = {
      url: null,
      hubName: null,
      installId: null,
      installKey: null,
      joinedAt: null,
      cursor: null,
      orderCursor: null,
      partnerCursor: null,
      lastError: null,
      scope: "member",
      formerUrl: null,
      formerInstallId: null,
      formerInstallKey: null,
      discordUrl: null,
    };
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...never }, update: never });
    let view = await accountView(a.user);
    assert.equal(view.connected, false);
    assert.equal(view.neverConnected, true);
    assert.equal(view.hubUrl, mock.url);
    assert.equal(view.mayManage, true);
    const email = `owner-${RUN}@stitchbench.test`;
    await expectError("no terms tick", () => startHubAccountFor(a.user, form({ email })), /Tick the box/);
    // The dev database holds many companies: joining a hub from here is the StitchBench administrator's to do.
    await expectError("several companies", () => startHubAccountFor(a.user, form({ email, terms: "on" })), /Several companies share/);
    const savedAdmins = process.env.PLATFORM_ADMIN_EMAILS;
    process.env.PLATFORM_ADMIN_EMAILS = [savedAdmins, a.user.email].filter(Boolean).join(",");
    await expectError("bad email", () => startHubAccountFor(a.user, form({ email: "nope", terms: "on" })), /email/i);
    assert.equal(mock.starts.length, 0);
    await startHubAccountFor(a.user, form({ email, terms: "on" }));
    assert.equal(mock.starts.length, 1);
    assert.equal(mock.starts[0].auth, null, "a never-joined install starts with no key");
    assert.deepEqual(
      { ...mock.starts[0].body, version: undefined },
      { shopRef: a.shopId, shopName: a.name, kind: "both", program: programName(), email, termsVersion: TERMS_VERSION, contact: email, version: undefined },
    );
    let hs = await hubState();
    assert.equal(hs?.url, mock.url);
    assert.equal(hs?.scope, "pending");
    assert.equal(hs?.installKey, mock.installKey);
    assert.equal(hs?.installId, "inst_mock");
    let shopA = await db.shop.findUniqueOrThrow({ where: { id: a.shopId } });
    assert.equal(shopA.hubAccountEmail, email);
    assert.equal(shopA.hubAccountVerified, false);
    assert.equal(shopA.termsVersion, TERMS_VERSION);
    assert.equal(shopA.hubStanding, "trial");
    assert.equal(shopA.hubStandingUntil, addDaysYmd(today(), 29));
    assert.match(shopA.hubStandingNote ?? "", /Free trial/);
    ok("door 1 from a never-joined install: the account started, the install joined as pending, the standing written down");

    await syncHub(); // the one the start kicked off, or a fresh run
    const claimedRefs = new Set(mock.claims.map((c) => String(c.body.shopRef)));
    assert.ok(claimedRefs.has(a.shopId) && claimedRefs.has(b.shopId), "every company claimed itself");
    const claimA = mock.claims.find((c) => c.body.shopRef === a.shopId)!;
    assert.equal(claimA.auth, mock.installKey);
    assert.equal(claimA.body.shopName, a.name);
    assert.equal(claimA.body.kind, "both");
    assert.equal(claimA.body.program, programName());
    assert.equal(claimA.body.sole, (await db.shop.count()) === 1);
    assert.ok("version" in claimA.body);
    hs = await hubState();
    assert.equal(hs?.scope, "pending", "the hub still says pending");
    assert.ok(hs?.lastSyncAt, "a pending install's sync finishes (nothing of the community's)");
    assert.equal(hs?.lastError, null);
    view = await accountView(a.user);
    assert.equal(view.connected, true);
    assert.equal(view.scope, "pending");
    assert.equal(view.shop.hubAccountEmail, email);
    assert.equal((await accountView(b.user)).shop.hubAccountEmail, null, "B has no account");
    ok("the sync claims every company with name, kind, program, version and sole; the install stays pending");

    await startHubAccountFor(a.user, form({ email, terms: "on" }));
    assert.equal(mock.starts.length, 2);
    assert.equal(mock.starts[1].auth, mock.installKey, "'Send it again' goes with the install key now");
    await syncHub(); // the run the start kicked off in the background, before the mock changes below
    mock.startMode = "409";
    await expectError("409", () => startHubAccountFor(a.user, form({ email, terms: "on" })), /already has a StitchHub account/);
    mock.startMode = "503";
    await expectError("503", () => startHubAccountFor(a.user, form({ email, terms: "on" })), /can't send account emails yet/);
    mock.startMode = "ok";
    ok("send it again; 409 and 503 in words");

    // The owner opens the email: the hub says member and, once billing exists, sends a key.
    mock.scope = "member";
    mock.account = { email, verified: true };
    const key1 = devLicenseKey({ shopId: a.shopId, modules: ["base"], plan: "t", from: addDaysYmd(today(), -1), until: addDaysYmd(today(), 28), grace: 14 });
    mock.keyFor.set(a.shopId, key1);
    await syncHub();
    hs = await hubState();
    assert.equal(hs?.scope, "member");
    let rows: { keyId: string; source: string; addedBy?: string | null }[] = await db.license.findMany({
      where: { shopId: a.shopId, source: "hub" },
      select: { keyId: true, source: true, addedBy: true },
    });
    assert.deepEqual(rows, [{ keyId: payloadOf(key1).id, source: "hub", addedBy: "StitchHub" }]);
    m = await loadModules(a.shopId);
    assert.equal(m.states.base.status, "on");
    assert.equal(m.states.base.plan, "t");
    assert.equal(m.keys.find((k) => k.keyId === payloadOf(key1).id)?.source, "hub");
    shopA = await db.shop.findUniqueOrThrow({ where: { id: a.shopId } });
    assert.equal(shopA.hubAccountVerified, true);
    ok("pending → member; the hub's key is stored as the one hub row and switches the program on");

    const key2 = devLicenseKey({ shopId: a.shopId, modules: ["base"], plan: "m", from: today(), until: addDaysYmd(today(), 30), grace: 14 });
    mock.keyFor.set(a.shopId, key2);
    await syncHub();
    rows = await db.license.findMany({ where: { shopId: a.shopId, source: "hub" }, select: { keyId: true, source: true } });
    assert.deepEqual(rows, [{ keyId: payloadOf(key2).id, source: "hub" }], "the next key replaces the hub row");
    mock.keyFor.set(a.shopId, null);
    await syncHub();
    assert.equal(await db.license.count({ where: { shopId: a.shopId, keyId: payloadOf(key2).id } }), 1, "no key from the hub leaves the stored one");
    const pasted = await grantDevLicense(a.shopId, ["base"], { from: today(), until: addDaysYmd(today(), 10), grace: 0 });
    mock.revokeFor.set(a.shopId, [payloadOf(key2).id, payloadOf(pasted).id]);
    await syncHub();
    rows = await db.license.findMany({ where: { shopId: a.shopId, keyId: { in: [payloadOf(key2).id, payloadOf(pasted).id] } }, select: { keyId: true, source: true } });
    assert.deepEqual(rows, [{ keyId: payloadOf(pasted).id, source: "pasted" }], "revokeKeyIds removes only what the hub issued");
    mock.revokeFor.delete(a.shopId);
    const forB = devLicenseKey({ shopId: b.shopId, modules: ["base"], plan: "t" });
    mock.keyFor.set(a.shopId, forB);
    await syncHub();
    assert.equal(await db.license.count({ where: { keyId: payloadOf(forB).id } }), 0, "a key for another company is ignored");
    const noBase = devLicenseKey({ shopId: a.shopId, modules: ["vac"], plan: "t" });
    mock.keyFor.set(a.shopId, noBase);
    await syncHub();
    assert.equal(await db.license.count({ where: { keyId: payloadOf(noBase).id } }), 0, "a hub key without the program itself is ignored");
    mock.keyFor.set(a.shopId, null);
    ok("replace on fetch, keep on silence, revoke only hub rows, ignore another company's key");

    const before = mock.claims.length;
    await refreshStandingFor(a.user);
    assert.equal(mock.claims.length, before + 1);
    assert.equal(mock.claims[before].body.shopRef, a.shopId, "Check again claims this company only");
    const code = await linkCodeFor(a.user);
    assert.equal(code.code, "ABCDE-FGHJK");
    assert.equal(code.hubUrl, mock.url);
    assert.deepEqual({ ...mock.links[0].body, version: undefined }, { shopRef: a.shopId, shopName: a.name, kind: "both", program: programName(), version: undefined });
    mock.linkMode = "409";
    await expectError("link 409", () => linkCodeFor(a.user), /already connected/);
    mock.linkMode = "ok";
    await expectError("hosted opt-in", () => setResetOptInFor(a.user, true), /Windows program/);
    process.env.STITCH_DESKTOP = "1";
    try {
      await setResetOptInFor(a.user, true);
    } finally {
      delete process.env.STITCH_DESKTOP;
    }
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { hubResetOptIn: true } })).hubResetOptIn, true);
    const tech = await db.user.create({ data: { shopId: a.shopId, email: `check-${RUN}-tech@stitchbench.test`, name: "Tech", role: "TECH", passwordHash: "x" }, select: { id: true } });
    const techUser: CurrentUser = { id: tech.id, shopId: a.shopId, role: "TECH", name: "Tech", email: `check-${RUN}-tech@stitchbench.test` };
    assert.throws(() => requireAccountOwner(techUser), /Only the shop owner/);
    assert.equal((await accountView(techUser)).mayManage, false);
    ok("Check again, the link code and its 409, the reset opt-in (Windows only), owners only");

    // ---------- 5. tenant ----------
    await grantDevLicense(a.shopId, ["base"], { from: addDaysYmd(today(), -60), until: addDaysYmd(today(), -20), grace: 14, plan: "m", issuedAt: new Date(Date.now() - 60 * DAY) });
    await db.license.deleteMany({ where: { shopId: a.shopId, keyId: payloadOf(pasted).id } });
    assert.equal((await loadModules(a.shopId)).states.base.status, "lapsed");
    const snapA = await snapshot(a.shopId, ["Shop", "License", "Sale"]);
    assert.equal((await loadModules(b.shopId)).states.base.status, "off", "A's lapse isn't B's");
    await requireBaseWritable(b.user);
    const bView = await accountView(b.user);
    assert.equal(bView.shop.id, b.shopId);
    assert.equal(bView.shop.hubAccountEmail, null);
    assert.equal(bView.base.status, "off");
    await applyStanding(b.shopId, { standing: "comped", key: key1, revokeKeyIds: [payloadOf(key1).id] });
    assert.equal(await db.license.count({ where: { shopId: b.shopId } }), 1, "A's key sent to B is ignored (B keeps its scheduling key only)");
    assert.equal(await db.license.count({ where: { shopId: b.shopId, source: "hub" } }), 0);
    const linksBefore = mock.links.length;
    await linkCodeFor(b.user);
    assert.equal(mock.links[linksBefore].body.shopRef, b.shopId, "B's code is for B");
    await applyStanding("not-a-company", { standing: "trial" });
    assertUnchanged("company A", snapA, await snapshot(a.shopId, ["Shop", "License", "Sale"]));
    ok("tenant: B's calls learn and change nothing of A's");

    if (savedAdmins === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = savedAdmins;
    console.log(`base-license.check: ${steps} steps passed (run ${RUN}; mock hub ${mock.url})`);
  } finally {
    if (savedDefault === undefined) delete process.env.DEFAULT_HUB_URL;
    else process.env.DEFAULT_HUB_URL = savedDefault;
    // The hub connection and every company's hub fields go back as they were.
    if (savedHub) {
      const { id: _id, ...data } = savedHub;
      void _id;
      await db.hubState.update({ where: { id: 1 }, data }).catch((e) => console.error("restoring HubState:", e));
    } else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => undefined);
    for (const s of savedShops) {
      const { id, ...fields } = s;
      await db.shop.updateMany({ where: { id }, data: Object.fromEntries(HUB_FIELDS.map((k) => [k, fields[k]])) }).catch(() => undefined);
    }
    await cleanup();
    await mock.close();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
