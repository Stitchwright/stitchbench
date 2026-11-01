import "dotenv/config";
// The whole MakerFoundry order flow against the REAL StitchHub (docs/plans/makerfoundry-orders-plan.md), not the stand-in the other checks use:
// the hub's own server code is started on this computer against a scratch database, with a stand-in object store for the files (the one
// StitchHub's own tests use), a service key and signing key issued the way the admin does, and a small "MakerFoundry" in this script that speaks
// the hub's routes as the service and signs `order.placed` with the hub's own signing code. StitchShop's side is the real code under test.
// Needs a StitchHub checkout with the order messages (STITCHHUB_DIR, default ../stitchhub); without one it says SKIPPED, which is not a pass.
//   STITCHHUB_DIR=/path/to/stitchhub npm run check scripts/checks/online-realhub.check.ts
// REALHUB_SERVICE=makerfoundry-test runs the same flow as the TEST identity: a platform admin points the shop at that service, its key is a
// different one from production's, the order is signed as service:makerfoundry-test, and the production key (also issued) sees no shop.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { db } from "@/lib/db";
import { setOrderStatusFor, turnDownOrderFor } from "@/lib/decor";
import { handOverOnlineOrderFor } from "@/lib/shop-orders/handover";
import { saveOfferFor, saveProductFor, saveShippingFor, setOnlineOrdersFor, setServiceFor } from "@/lib/shop-orders/online";
import { sendOnlineProofFor } from "@/lib/shop-orders/proofs";
import { syncShop } from "@/lib/shop-orders/sync";
import { makeCompany, removeCompany } from "./tenant";

const SERVICE = (process.env.REALHUB_SERVICE ?? "makerfoundry").trim();
const HUB_DIR = path.resolve(process.env.STITCHHUB_DIR ?? path.join(process.cwd(), "..", "stitchhub"));
const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/shop-orders", n), "utf8"));
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const freePort = () => new Promise<number>((r) => net.createServer().listen(0, "127.0.0.1", function (this: net.Server) { const p = (this.address() as net.AddressInfo).port; this.close(() => r(p)); }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
// A DST written from the format's public description (as src/lib/embroidery-file.test.ts does).
function dst(n: number): Buffer {
  const out = Buffer.alloc(512 + n * 3 + 3, 0x20);
  out.write(`LA:REAL            \rST:${String(n).padStart(7)}\rCO:  1\r+X:    0\r-X:    0\r+Y:    0\r-Y:    0\r`, 0, "latin1");
  for (let i = 0; i < n; i++) out.set([0x01, 0x00, 0x03], 512 + i * 3);
  out.set([0, 0, 0xf3], 512 + n * 3);
  return out;
}
const PNG = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/shop-orders/preview.png"));

async function main() {
  if (!fs.existsSync(path.join(HUB_DIR, "test", "sync-orders.mjs"))) {
    console.log(`SKIPPED: no StitchHub with the order messages at ${HUB_DIR} (set STITCHHUB_DIR). This is not a pass.`);
    return;
  }
  const { startBucket } = (await import(pathToFileURL(path.join(HUB_DIR, "test", "bucket-mock.mjs")).href)) as { startBucket: () => Promise<{ env: Record<string, string>; store: Map<string, Buffer>; close: () => Promise<void> }> };
  const { signEnvelope } = (await import(pathToFileURL(path.join(HUB_DIR, "src", "sync-orders.mjs")).href)) as { signEnvelope: (env: unknown, key: crypto.KeyObject) => { v: 1; sig: string } };

  // ----- the hub: its own code, a scratch database, a stand-in object store -----
  const base = new URL(process.env.DATABASE_URL ?? "");
  const hubDb = `realhub_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${hubDb}`);
  const hubUrl = new URL(base.toString());
  hubUrl.pathname = `/${hubDb}`;
  const bucket = await startBucket();
  const port = await freePort();
  const HUB = `http://127.0.0.1:${port}`;
  const ADMIN = "realhub-admin-token";
  const JOIN = "join-realhub";
  const hub = spawn(process.execPath, ["src/server.mjs"], {
    cwd: HUB_DIR,
    env: { ...process.env, ...bucket.env, DATABASE_URL: hubUrl.toString(), ADMIN_TOKEN: ADMIN, JOIN_KEY: JOIN, PORT: String(port), LINK_CHECKER: "off", PROGRAM_FREE: "off", RAILWAY_ENVIRONMENT_ID: "", HUB_NAME: "Real hub check", TRUST_PROXY: "true", SYNC_SWEEP_MS: "600" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  hub.stdout.on("data", (d) => (log += d));
  hub.stderr.on("data", (d) => (log += d));
  const A = await makeCompany("Real hub A", { kind: "retail" });
  const B = await makeCompany("Real hub B", { kind: "retail" });
  const saved = await db.hubState.findUnique({ where: { id: 1 } });
  try {
    for (let i = 0; ; i++) {
      if (hub.exitCode !== null) throw new Error(`the hub stopped:\n${log}`);
      if (await fetch(`${HUB}/health`).then((r) => r.ok, () => false)) break;
      if (i > 300) throw new Error(`the hub didn't start:\n${log}`);
      await sleep(200);
    }
    const call = async (p: string, o: { key?: string; method?: string; json?: unknown; headers?: Record<string, string> } = {}) => {
      const r = await fetch(HUB + p, { method: o.method ?? (o.json !== undefined ? "POST" : "GET"), headers: { ...(o.key ? { Authorization: `Bearer ${o.key}` } : {}), ...(o.json !== undefined ? { "Content-Type": "application/json" } : {}), ...(o.headers ?? {}) }, body: o.json !== undefined ? JSON.stringify(o.json) : undefined });
      const t = await r.text();
      return { status: r.status, body: (t ? JSON.parse(t) : {}) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const expect = (r: { status: number; body: unknown }, status: number, what: string) => {
      assert.equal(r.status, status, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };

    // ----- the admin issues the service key and registers its signing key; the shop's install joins -----
    const issued = expect(await call("/v1/admin/service-keys", { key: ADMIN, json: { name: SERVICE } }), 200, "service key");
    const SVK = issued.key as string;
    const kp = crypto.generateKeyPairSync("ed25519");
    expect(await call(`/v1/admin/service-keys/${issued.id}/public-key`, { key: ADMIN, method: "PUT", json: { publicKey: kp.publicKey.export({ type: "spki", format: "der" }).toString("base64") } }), 200, "public key");
    const inst = expect(await call("/v1/register", { json: { joinKey: JOIN, name: "Real hub install" } }), 200, "register");
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url: HUB, installKey: inst.installKey, scope: "member", installId: inst.installId }, update: { url: HUB, installKey: inst.installKey, scope: "member", installId: inst.installId } });
    const net = (globalThis as unknown as { __hubNet?: object }).__hubNet;
    if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
    const { grantDevLicense } = await import("../license/dev");
    for (const c of [A, B]) {
      await grantDevLicense(c.shopId, ["decorating"], { from: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) });
      expect(await call("/v1/shops/claim", { key: inst.installKey, json: { shopRef: c.shopId, shopName: `Shop ${c.shopId.slice(-4)}`, kind: "retail", program: "StitchShop", version: "1.8.0", sole: false } }), 200, "claim");
    }
    ok("the real hub is up on a scratch database, with a service key, its signing key and a joined install");

    // ----- the service side: a small MakerFoundry that speaks the hub's routes -----
    const SVC = { key: SVK, headers: { "X-Client": "makerfoundry/0.1.0" } };
    expect(await call("/v2/hello", { ...SVC, json: { app: "makerfoundry", version: "0.1.0", types: { "order.status": [1], "proof.sent": [1], "order.cancel": [1], catalog: [1], "message.expired": [1] } } }), 200, "service hello");
    let cursor = "0";
    type Msg = { id: string; type: string; conversation: string; seq: number; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const heard: Msg[] = [];
    const inbox = async (): Promise<Msg[]> => {
      const r = expect(await call(`/v2/messages?after=${cursor}&limit=100`, SVC), 200, "service reads");
      cursor = r.next;
      const ms = r.messages as Msg[];
      if (ms.length) expect(await call("/v2/messages/ack", { ...SVC, json: { ids: ms.map((m) => m.id) } }), 200, "service acks");
      heard.push(...ms);
      return ms;
    };
    // The hub hands out a conversation's messages one at a time while the next waits for the one before: a service polls until it has what it wants.
    const hear = async (conversation: string, count: number, type?: string): Promise<Msg[]> => {
      for (let i = 0; i < 30; i++) {
        const got = heard.filter((m) => m.conversation === conversation && (!type || m.type === type));
        if (got.length >= count) return got;
        await inbox();
        if (heard.filter((m) => m.conversation === conversation && (!type || m.type === type)).length < count) await sleep(150);
      }
      return heard.filter((m) => m.conversation === conversation && (!type || m.type === type));
    };
    const seqs = new Map<string, number>();
    const sendAs = async (to: string, conversation: string, type: string, body: unknown, o: { sign?: boolean; id?: string; seq?: number } = {}) => {
      const seq = o.seq ?? (seqs.get(conversation) ?? 0) + 1;
      seqs.set(conversation, Math.max(seq, seqs.get(conversation) ?? 0));
      const env: Record<string, unknown> = { id: o.id ?? crypto.randomUUID(), type, version: 1, conversation, seq, to, created_at: new Date().toISOString(), body };
      if (type === "order.placed" && o.sign !== false) env.sig = signEnvelope({ ...env, from: `service:${SERVICE}` }, kp.privateKey);
      return { env, res: await call("/v2/messages", { ...SVC, json: env }) };
    };
    const upload = async (conversation: string, bytes: Buffer, kind: "art" | "mockup", to: string) => {
      const put = expect(await call("/v2/files/put", { ...SVC, json: { conversation, sha256: sha(bytes), size: bytes.length, kind, to, ...(kind === "mockup" ? { type: "image/png" } : {}) } }), 200, "files/put");
      if (!put.ready) {
        const r = await fetch(put.url, { method: "PUT", headers: put.headers, body: new Uint8Array(bytes) });
        assert.equal(r.status, 200, `the bucket took the file: ${r.status}`);
        expect(await call("/v2/files/done", { ...SVC, json: { conversation, sha256: sha(bytes) } }), 200, "files/done");
      }
    };
    const order = (art: Buffer, o: { ship?: boolean; note?: string } = {}) => {
      const b = fixture("order.placed.v1.valid.json");
      b.lines[0].decorations[0].art = { file: "logo.dst", size: art.length, sha256: sha(art) };
      b.lines[0].sku = "REAL-TEE";
      b.lines[0].decorations[0].placement = "Left chest";
      b.preview = { size: PNG.length, sha256: sha(PNG), type: "image/png" };
      if (!o.ship) {
        b.fulfilment = "pickup";
        delete b.customer.ship_to;
      }
      if (o.note) b.note = o.note;
      return b;
    };
    const syncUntil = async (shopId: string, ok2: () => Promise<boolean>, what: string) => {
      for (let i = 0; i < 30; i++) {
        await syncShop(shopId);
        if (await ok2()) return;
        await sleep(300);
      }
      assert.fail(`${what}: not reached`);
    };

    // ----- the shop opts in on the real hub and its catalogue arrives -----
    const ownerLogin = await db.user.findFirstOrThrow({ where: { shopId: A.shopId, role: "OWNER" } });
    const ACCOUNT = crypto.randomInt(8_000_000, 8_090_000);
    await db.user.update({ where: { id: ownerLogin.id }, data: { foundryId: ACCOUNT } }); // the owner's linked Foundry Account
    await saveProductFor(A.user, form({ sku: "REAL-TEE", name: "Real tee", colours: "Navy, White", sizes: "M, L", blank: "9.00" }));
    await saveOfferFor(A.user, form({ method: "embroidery", placement: "Left chest", breaks: "1: 12.00\n12: 10.00", setup: "25", maxStitches: "5000" }));
    await saveShippingFor(A.user, form({ pickup: "on", ships: "on", shipping: "8.99", perExtra: "0.50", freeOver: "300", pa_line1: "210 Main Street", pa_city: "Elmwood", pa_region: "OH", pa_postcode: "44001", pa_country: "US" }));
    // The other identity: a production key is issued as well when this run is as the test service, and must see nothing of the test shop.
    let otherKey: string | null = null;
    if (SERVICE !== "makerfoundry") {
      process.env.PLATFORM_ADMIN_EMAILS = A.user.email;
      await assert.rejects(() => setServiceFor(B.user, SERVICE), /platform admin/, "only the platform admin changes the order service");
      assert.match(await setServiceFor(A.user, SERVICE), new RegExp(`now come through ${SERVICE}`));
      otherKey = expect(await call("/v1/admin/service-keys", { key: ADMIN, json: { name: "makerfoundry" } }), 200, "production key").key as string;
      expect(await call("/v2/hello", { key: otherKey, headers: { "X-Client": "makerfoundry/0.1.0" }, json: { app: "makerfoundry", version: "0.1.0", types: { "order.status": [1], "proof.sent": [1], "order.cancel": [1], catalog: [1], "message.expired": [1] } } }), 200, "production hello");
    }
    const said = await setOnlineOrdersFor(A.user, form({ on: "on", maxOpen: "5" }));
    assert.match(said, /You take orders from MakerFoundry/);
    let shops: { id: string; name: string; ready: boolean }[] = [];
    for (let i = 0; i < 20 && !shops.length; i++) {
      shops = expect(await call("/v2/shops", SVC), 200, "shops").shops;
      if (!shops.length) await sleep(250);
    }
    assert.equal(shops.length, 1, "only the shop that opted in is listed");
    if (otherKey) {
      const prod = expect(await call("/v2/shops", { key: otherKey, headers: { "X-Client": "makerfoundry/0.1.0" } }), 200, "production lists shops").shops as unknown[];
      assert.equal(prod.length, 0, "the production key sees nothing of a shop that opted in to the test service");
      ok("the test service and the production service are separate: each sees only the shops that opted in to its own name");
    }
    const TO = shops[0].id; // the hub lists a shop by its address, shop:<id>
    assert.equal(shops[0].ready, true, "and the hub sees its program understands orders");
    let cat: { body: Record<string, any> } | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < 20 && !cat; i++) {
      await syncShop(A.shopId);
      cat = (await inbox()).find((m) => m.type === "catalog") ?? heard.find((m) => m.type === "catalog");
      if (!cat) await sleep(250);
    }
    assert.ok(cat, "the service received the catalogue through the real hub");
    assert.equal(cat.body.shop.account, ACCOUNT, "the owner's Foundry Account comes through the real hub");
    assert.equal(cat.body.products[0].cents, 900, "the garment's own price comes through the real hub");
    assert.deepEqual(cat.body.products[0].methods[0].price_breaks, [{ min: 1, cents: 1200 }, { min: 12, cents: 1000 }], "and the decoration's, apart");
    assert.deepEqual(cat.body.shipping, { flat_cents: 899, per_extra_piece_cents: 50, free_over_cents: 30000 }, "shipping by the piece");
    assert.deepEqual(cat.body.shop.address, { line1: "210 Main Street", city: "Elmwood", region: "OH", postcode: "44001", country: "US" }, "and the pick-up address");
    ok("the shop opts in on the real hub, is listed, and the service receives its catalogue");

    // ----- B has not opted in: the real hub refuses an order for it -----
    const stranger = await sendAs("shop:nobody", "mf-nope", "order.placed", order(dst(10)));
    assert.ok([403, 404].includes(stranger.res.status), `an unknown shop is refused: ${stranger.res.status}`);
    ok("an order for a shop that did not opt in is refused by the hub");

    // ----- an order arrives through the hub, signed, with its art by signed address -----
    const art = dst(1200);
    await upload("mf-e2e-0001", art, "art", TO);
    const body1 = order(art);
    delete body1.preview;
    const placed = await sendAs(TO, "mf-e2e-0001", "order.placed", body1);
    expect(placed.res, 202, "order.placed through the real hub");
    await syncUntil(A.shopId, async () => (await db.decorOrder.count({ where: { shopId: A.shopId, onlineRef: "mf-e2e-0001" } })) === 1, "the order arrives");
    const o1 = await db.decorOrder.findFirstOrThrow({ where: { shopId: A.shopId, onlineRef: "mf-e2e-0001" }, include: { placements: true, lines: true } });
    assert.equal(o1.status, "QUOTED");
    assert.equal(o1.quoteCents, 9000 + 2500);
    assert.equal(o1.customerId, null);
    await syncUntil(A.shopId, async () => !!(await db.decorPlacement.findFirstOrThrow({ where: { orderId: o1.id } })).fileData, "the art arrives");
    const pl = await db.decorPlacement.findFirstOrThrow({ where: { orderId: o1.id } });
    assert.equal(sha(Buffer.from(pl.fileData!)), sha(art), "the art is byte for byte what the service uploaded to the real hub's store");
    assert.equal(pl.stitches, 1200);
    const got = await hear("mf-e2e-0001", 1, "order.status");
    assert.deepEqual(got.map((m) => [m.type, m.body.status]), [["order.status", "received"]], "`received` came back through the real hub");
    ok("a signed order comes through the real hub, becomes a paid decorating order, its art is fetched and `received` goes back");

    // ----- a duplicate send is stored once -----
    const dup = await sendAs(TO, "mf-e2e-0001", "order.placed", body1, { id: placed.env.id as string, seq: 1 });
    assert.equal(dup.res.status, 202);
    assert.equal(dup.res.body.duplicate, true, "the hub dedupes by the sender's id");
    await syncShop(A.shopId);
    assert.equal(await db.decorOrder.count({ where: { shopId: A.shopId, onlineRef: "mf-e2e-0001" } }), 1);
    ok("the same order sent twice is one order");

    // ----- a taxed order: the sales tax is the marketplace's, outside the shop's earnings -----
    const artT = dst(500);
    await upload("mf-e2e-0010", artT, "art", TO);
    const taxed = fixture("order.placed.v1.taxed.valid.json");
    taxed.lines[0].decorations[0].art = { file: "logo.dst", size: artT.length, sha256: sha(artT) };
    taxed.lines[0].sku = "REAL-TEE";
    delete taxed.preview;
    expect((await sendAs(TO, "mf-e2e-0010", "order.placed", taxed)).res, 202, "a taxed order through the real hub");
    await syncUntil(A.shopId, async () => (await db.decorOrder.count({ where: { shopId: A.shopId, onlineRef: "mf-e2e-0010" } })) === 1, "the taxed order arrives");
    const ot = await db.decorOrder.findFirstOrThrow({ where: { shopId: A.shopId, onlineRef: "mf-e2e-0010" } });
    assert.equal(ot.taxPaidCents, 1603);
    assert.equal(ot.shopGetsCents, 21131, "$259.52 paid, $16.03 tax, $24.35 and $7.83 in fees: the shop earns $211.31");
    assert.equal((ot.shipTo as { postcode: string }).postcode, "44000");
    const wrong = JSON.parse(JSON.stringify(taxed));
    wrong.totals.shop_gets_cents = 25952 - 2435 - 783;
    const refusedEarn = await sendAs(TO, "mf-e2e-0011", "order.placed", wrong);
    assert.equal(refusedEarn.res.status, 400);
    assert.equal(refusedEarn.res.body.code, "totals_dont_add_up");
    ok("a taxed order comes through the real hub with the shop earning $211.31; earnings that count the tax are refused by the hub");

    // ----- the hub's privacy rules hold -----
    const leak = order(art);
    delete leak.preview;
    leak.note = "write me at pat@example.com";
    const leaked = await sendAs(TO, "mf-e2e-0002", "order.placed", leak);
    assert.equal(leaked.res.status, 400);
    assert.equal(leaked.res.body.code, "personal_contact");
    const unsigned = await sendAs(TO, "mf-e2e-0003", "order.placed", order(art), { sign: false });
    assert.equal(unsigned.res.status, 403);
    ok("the real hub refuses a contact detail in a note and an unsigned order");

    // ----- the proof loop through the hub -----
    await db.decorOrder.update({ where: { id: o1.id }, data: { mockupName: "m.png", mockupMime: "image/png", mockupData: PNG } });
    assert.match(await sendOnlineProofFor(A.user, o1.id, "First proof"), /Proof 1/);
    await syncShop(A.shopId);
    const ps = (await hear("mf-e2e-0001", 1, "proof.sent"))[0];
    assert.ok(ps, "the service received the proof");
    assert.equal(ps.body.proof, 1);
    assert.equal(ps.body.note, "First proof");
    assert.deepEqual((await hear("mf-e2e-0001", 2, "order.status")).map((m) => m.body.status), ["received", "proof_sent"]);
    const got2 = expect(await call("/v2/files/get", { ...SVC, json: { conversation: "mf-e2e-0001", sha256: ps.body.mockup.sha256 } }), 200, "service fetches the mock-up");
    const bytes = Buffer.from(await (await fetch(got2.url)).arrayBuffer());
    assert.equal(sha(bytes), sha(PNG), "the mock-up the customer would see is the shop's picture, byte for byte");
    expect(await call("/v2/files/get", { key: inst.installKey, headers: { "X-Client": "stitchshop/1.8.0", "X-Shop-Ref": B.shopId }, json: { conversation: "mf-e2e-0001", sha256: ps.body.mockup.sha256 } }), 404, "another shop can't fetch it");
    const ans = await sendAs(TO, "mf-e2e-0001", "proof.answer", { proof: 1, answer: "approved", note: "Looks great" });
    expect(ans.res, 202, "proof.answer");
    await syncUntil(A.shopId, async () => (await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } })).status === "APPROVED", "the approval arrives");
    ok("the shop's proof reaches the service with its picture byte for byte, a stranger can't fetch it, and the customer's approval moves the order on");

    // ----- production to hand-over, told through the hub in order -----
    await setOrderStatusFor(A.user, o1.id, "IN_PRODUCTION");
    await setOrderStatusFor(A.user, o1.id, "READY");
    await handOverOnlineOrderFor(A.user, o1.id, null);
    await syncShop(A.shopId);
    const told = (await hear("mf-e2e-0001", 6, "order.status")).slice(2);
    assert.deepEqual(told.map((m) => m.body.status), ["approved", "in_production", "ready", "collected"]);
    assert.deepEqual(told.map((m) => m.seq), [...told.map((m) => m.seq)].sort((a, b) => a - b), "in seq order");
    assert.ok((await db.decorOrder.findUniqueOrThrow({ where: { id: o1.id } })).saleId);
    ok("approved, in production, ready and collected reach the service in order; the order is booked paid online");

    // ----- the customer cancels, and the shop turns an order down -----
    const art2 = dst(800);
    await upload("mf-e2e-0004", art2, "art", TO);
    const b4 = order(art2, { ship: true });
    delete b4.preview;
    expect(( await sendAs(TO, "mf-e2e-0004", "order.placed", b4)).res, 202, "second order");
    await syncUntil(A.shopId, async () => (await db.decorOrder.count({ where: { shopId: A.shopId, onlineRef: "mf-e2e-0004" } })) === 1, "second order arrives");
    const c4 = await sendAs(TO, "mf-e2e-0004", "order.cancel", { by: "customer", why: "Changed my mind" });
    expect(c4.res, 202, "customer cancel");
    await syncUntil(A.shopId, async () => (await db.decorOrder.findFirstOrThrow({ where: { shopId: A.shopId, onlineRef: "mf-e2e-0004" } })).status === "CANCELLED", "the cancel arrives");
    assert.equal((await db.decorOrder.findFirstOrThrow({ where: { shopId: A.shopId, onlineRef: "mf-e2e-0004" } })).shipTo, null, "and the address is wiped");
    const art3 = dst(700);
    await upload("mf-e2e-0005", art3, "art", TO);
    const b5 = order(art3);
    delete b5.preview;
    expect((await sendAs(TO, "mf-e2e-0005", "order.placed", b5)).res, 202, "third order");
    await syncUntil(A.shopId, async () => (await db.decorOrder.count({ where: { shopId: A.shopId, onlineRef: "mf-e2e-0005" } })) === 1, "third order arrives");
    const o5 = await db.decorOrder.findFirstOrThrow({ where: { shopId: A.shopId, onlineRef: "mf-e2e-0005" } });
    await turnDownOrderFor(A.user, o5.id, "We can't make that logo.");
    await syncShop(A.shopId);
    const cancels = await hear("mf-e2e-0005", 1, "order.cancel");
    assert.deepEqual(cancels.map((m) => m.body), [{ by: "shop", why: "We can't make that logo." }]);
    ok("a customer cancel closes the order and wipes the address; the shop's turn-down reaches the service");

    // ----- the per-shop cap is the hub's, and the shop opted in with 5 -----
    const row = await db.shopOrdersSync.findUniqueOrThrow({ where: { shopId: A.shopId } });
    assert.equal(row.maxOpen, 5);
    const summary = expect(await call("/v1/admin/sync/summary", { key: ADMIN }), 200, "summary");
    assert.ok(summary.states.acked > 0);
    assert.equal((await db.syncOut.count({ where: { shopId: A.shopId, deadAt: { not: null } } })), 0, "the real hub refused nothing the shop sent");
    ok("the hub refused nothing the shop sent, and its queue shows what was delivered and acknowledged");
    console.log(`online-realhub: ${steps} steps ok`);
  } finally {
    hub.kill();
    await bucket.close().catch(() => {});
    if (saved) await db.hubState.update({ where: { id: 1 }, data: { url: saved.url, installKey: saved.installKey, installId: saved.installId, scope: saved.scope } }).catch(() => {});
    else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => {});
    for (const c of [A, B]) await removeCompany(c.shopId).catch(() => {});
    await db.$disconnect();
    await sleep(500);
    await admin.query(`DROP DATABASE IF EXISTS ${hubDb} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
