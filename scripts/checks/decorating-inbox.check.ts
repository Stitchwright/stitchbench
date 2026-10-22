// The StitchFoundry inbox on the program's side (docs/plans/decorators-proposal.md, the cloud inbox; StitchHub's side is its own
// test/inbox.mjs), against a stand-in hub in this process (a tiny HTTP server): what the list says in each state (no hub, a company
// not tied to an account, a hub with no inbox, a hub that fails, the files), a file taken into an open order or into a new one (a DST
// read for its stitch count, any other format using what StitchFoundry said), the file checked against the size and SHA-256 the
// hub listed, a hub that can't be told it was taken, and a second company unable to touch the first's orders.
//   npm run check scripts/checks/decorating-inbox.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end); the HubState row is put back as it was.
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { hubState } from "@/lib/hub";
import { cleanItemMeta, inboxFor, takeInboxItemFor } from "@/lib/decor-inbox";
import { addLineFor, createOrderFor, mockupFile, orderView, setMockupFor } from "@/lib/decor";
import type { CurrentUser } from "@/lib/session";
import { grantDevLicense } from "../license/dev";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

const DAY = 86_400_000;
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const fd = (o: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
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
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

/** A DST file of n stitches (a colour change in the middle), as the other decorating checks make them. */
function dst(n: number): Uint8Array {
  // n stitches with a colour change in the middle (that record is not a stitch), then the end
  const recs: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (i === Math.floor(n / 2)) recs.push([0, 0, 0xc3]);
    recs.push([i % 2 === 0 ? 0x01 : 0x02, 0, 0x03]);
  }
  const out = new Uint8Array(512 + recs.length * 3 + 3);
  out.fill(0x20, 0, 512);
  const h = `LA:FROM FOUNDRY    \rST:${String(recs.length).padStart(7)}\rCO:  1\r+X:   10\r-X:    0\r+Y:    0\r-Y:    0\r`;
  for (let i = 0; i < h.length; i++) out[i] = h.charCodeAt(i);
  recs.forEach((r, i) => out.set(r, 512 + i * 3));
  out.set([0, 0, 0xf3], 512 + recs.length * 3);
  return out;
}

type Stored = { id: string; fileName: string; bytes: Uint8Array; meta: Record<string, unknown>; listed?: { size?: number; sha256?: string }; preview?: Uint8Array; previewType?: string };
type Mode = { linked: boolean; listStatus: number; takeStatus: number; tamper: boolean; previewStatus: number; tamperPreview: boolean };

/** The stand-in hub: the inbox routes of StitchHub's src/inbox.mjs as the program uses them, and the bucket's download. */
async function startHub() {
  const store = new Map<string, Map<string, Stored>>(); // shopRef -> id -> file
  const taken: { shopRef: string; id: string }[] = [];
  const seen: { path: string; auth: string | undefined; shopRef: string | null }[] = [];
  const mode: Mode = { linked: true, listStatus: 200, takeStatus: 200, tamper: false, previewStatus: 200, tamperPreview: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (url.pathname === "/health") return send(200, { ok: true });
    if (url.pathname.startsWith("/bucket/")) {
      const [, , shopRef, id, what] = url.pathname.split("/");
      const f = store.get(shopRef)?.get(id);
      if (!f) return send(404, {});
      if (what === "preview") {
        if (mode.previewStatus !== 200 || !f.preview) return send(mode.previewStatus === 200 ? 404 : mode.previewStatus, {});
        const pb = mode.tamperPreview ? Uint8Array.from(f.preview, (b, i) => (i === 0 ? b ^ 1 : b)) : f.preview;
        res.writeHead(200, { "content-length": pb.length });
        return res.end(Buffer.from(pb));
      }
      const bytes = mode.tamper ? Uint8Array.from(f.bytes, (b, i) => (i === 0 ? b ^ 1 : b)) : f.bytes;
      res.writeHead(200, { "content-length": bytes.length });
      return res.end(Buffer.from(bytes));
    }
    const shopRef = url.searchParams.get("shopRef") ?? body.shopRef ?? (req.headers["x-shop-ref"] as string | undefined) ?? null;
    seen.push({ path: url.pathname, auth: req.headers.authorization, shopRef });
    if (url.pathname === "/v1/inbox/list") {
      if (mode.listStatus !== 200) return send(mode.listStatus, { error: "no" });
      if (!mode.linked) return send(200, { linked: false, items: [] });
      const items = [...(store.get(String(shopRef))?.values() ?? [])].map((f) => ({ id: f.id, fileName: f.fileName, size: f.listed?.size ?? f.bytes.length, sha256: f.listed?.sha256 ?? sha(f.bytes), meta: f.meta, preview: f.preview ? { size: f.preview.length, sha256: sha(f.preview), type: f.previewType ?? "image/png" } : null, createdAt: "2026-10-22T10:00:00Z", expiresAt: "2026-11-21T10:00:00Z" }));
      return send(200, { linked: true, items });
    }
    if (url.pathname === "/v1/inbox/get") {
      const f = store.get(String(shopRef))?.get(String(body.id));
      if (!f) return send(404, { error: "not in this inbox" });
      return send(200, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/bucket/${shopRef}/${f.id}`, ...(f.preview ? { previewUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/bucket/${shopRef}/${f.id}/preview` } : {}), expiresIn: 600 });
    }
    if (url.pathname === "/v1/inbox/take") {
      if (mode.takeStatus !== 200) return send(mode.takeStatus, { error: "the hub had a problem" });
      const m = store.get(String(shopRef));
      if (!m?.delete(String(body.id))) return send(404, { error: "not in this inbox" });
      taken.push({ shopRef: String(shopRef), id: String(body.id) });
      return send(200, { ok: true });
    }
    return send(404, { error: "no route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    taken,
    seen,
    mode,
    add(shopRef: string, f: Omit<Stored, "id"> & { id?: string }) {
      const id = f.id ?? `it${crypto.randomBytes(6).toString("hex")}`;
      const m = store.get(shopRef) ?? new Map<string, Stored>();
      m.set(id, { ...f, id });
      store.set(shopRef, m);
      return id;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const hub = await startHub();
  const savedHub = await hubState();
  const net = (globalThis as unknown as { __hubNet?: { offlineSince: number | null; checkedAt: number; lastOk: number } }).__hubNet;
  const online = async () => {
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url: hub.url, installKey: "ik_check", scope: "member", installId: "inst_check" }, update: { url: hub.url, installKey: "ik_check", scope: "member", installId: "inst_check" } });
    if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
  };
  try {
    for (const s of [a, b]) await grantDevLicense(s.shopId, ["decorating"], { from: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) });
    const base = { customerName: "Riverside Fire Dept", customerPhone: "555-0142", title: "Polos" };

    // 1. The list in each state.
    await db.hubState.deleteMany({});
    assert.deepEqual(await inboxFor(a.shopId), { state: "not-joined", items: [] });
    await online();
    hub.mode.linked = false;
    assert.equal((await inboxFor(a.shopId)).state, "not-linked");
    hub.mode.linked = true;
    hub.mode.listStatus = 404;
    assert.equal((await inboxFor(a.shopId)).state, "not-offered", "a hub with no inbox is quiet");
    hub.mode.listStatus = 500;
    assert.equal((await inboxFor(a.shopId)).state, "offline", "a hub that fails is not an error page");
    hub.mode.listStatus = 200;
    await online();
    const dstBytes = dst(5000);
    const id1 = hub.add(a.shopId, { fileName: "crest.dst", bytes: dstBytes, meta: { job: "J-14", customer: "Riverside", placement: "Left chest", threads: ["Red 1147", "White"], stitches: 1234, colors: 9, evil: "<script>", widthMm: "wide", quantity: 24 } });
    hub.add(a.shopId, { fileName: "weird.dst", bytes: dstBytes, meta: {}, listed: { size: 99_999_999 } }); // a size no file can have: dropped
    hub.add(a.shopId, { fileName: "weird2.dst", bytes: dstBytes, meta: {}, listed: { sha256: "nope" } }); // not a hash: dropped
    const view = await inboxFor(a.shopId);
    assert.equal(view.state, "ok");
    assert.deepEqual(view.items.map((i) => i.fileName), ["crest.dst"], "items the hub got wrong are dropped");
    assert.deepEqual(view.items[0].meta, { job: "J-14", customer: "Riverside", placement: "Left chest", threads: ["Red 1147", "White"], stitches: 1234, colors: 9, quantity: 24 }, "what StitchFoundry said, cleaned again here: unknown keys and a text where a number belongs are dropped");
    assert.ok(hub.seen.every((r) => r.auth === "Bearer ik_check" && r.shopRef === a.shopId), "every request carries the install key and this company's id");
    assert.deepEqual(cleanItemMeta({ notes: "x".repeat(900), due: "soon", threads: Array.from({ length: 200 }, (_, i) => `T${i}`) }).threads?.length, 100);
    assert.equal(cleanItemMeta({ due: "soon" }).due, undefined);
    ok("the list: no hub, not tied to an account, a hub with no inbox and a hub that fails are states; wrong items are dropped and what StitchFoundry said is cleaned; every request names the company");

    // 2. Into an open order: a DST is read; the file wins over what was said.
    const o = await createOrderFor(user(a), fd(base));
    await addLineFor(user(a), o.id, fd({ description: "Polo", qty: "10", garment: "9" }));
    const r1 = await takeInboxItemFor(user(a), id1, { orderId: o.id, newOrder: null, location: null });
    assert.equal(r1.orderId, o.id);
    assert.match(r1.text, /The file says 5,000 stitches in 2 colours/);
    let v = (await orderView(a.shopId, o.id))!;
    const p = v.placements[0];
    assert.deepEqual([p.location, p.stitches, p.colors, p.fileName, p.fileReadable, p.method], ["Left chest", 5000, 2, "crest.dst", true, "EMBROIDERY"], "the DST was read: it wins over the 1,234 stitches and 9 colours StitchFoundry said; the place came from the hub's meta");
    assert.match(p.note ?? "", /StitchFoundry job J-14\. Threads: Red 1147, White/);
    assert.deepEqual(hub.taken, [{ shopRef: a.shopId, id: id1 }], "the hub was told it was taken");
    assert.equal((await inboxFor(a.shopId)).items.length, 0, "and it is no longer listed");
    await expectError("a second time", () => takeInboxItemFor(user(a), id1, { orderId: o.id, newOrder: null, location: null }), /isn't in the inbox any more/);
    ok("into an open order: a DST is read for its stitch count (the file wins over what was said), the place, job and threads go in the note, the hub is told, it is gone from the list");

    // 3. Other formats use what StitchFoundry said; with nothing said, it is refused and left in the inbox.
    const pes = new Uint8Array([35, 80, 69, 83, 48, 48, 48, 49, 1, 2, 3, 4]);
    const idPes = hub.add(a.shopId, { fileName: "sleeve.pes", bytes: pes, meta: { stitches: 8000, colors: 3, widthMm: 50, heightMm: 40 } });
    const idBare = hub.add(a.shopId, { fileName: "bare.pes", bytes: pes, meta: {} });
    await takeInboxItemFor(user(a), idPes, { orderId: o.id, newOrder: null, location: "Right sleeve" });
    v = (await orderView(a.shopId, o.id))!;
    const sl = v.placements.find((x) => x.location === "Right sleeve")!;
    assert.deepEqual([sl.stitches, sl.colors, sl.widthMm, sl.heightMm, sl.fileReadable, sl.fileFormat], [8000, 3, 50, 40, false, "PES"], "a PES isn't read, so the numbers StitchFoundry gave are used");
    const takenBefore = hub.taken.length;
    await expectError("nothing said", () => takeInboxItemFor(user(a), idBare, { orderId: o.id, newOrder: null, location: null }), /files aren't read yet: type the stitch count/);
    assert.equal(hub.taken.length, takenBefore, "a file that couldn't be used is left in the inbox, not taken");
    assert.ok((await inboxFor(a.shopId)).items.some((i) => i.id === idBare));
    ok("another format uses what StitchFoundry said (stitches, colours, size); with nothing said it is refused and stays in the inbox");

    // 4. A new order from a file.
    const idNew = hub.add(a.shopId, { fileName: "logo.dst", bytes: dst(3000), meta: { placement: "Cap front" } });
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Cap", phone: "555-0100" } });
    const r2 = await takeInboxItemFor(user(a), idNew, { orderId: null, newOrder: fd({ customerId: cust.id, title: "Caps" }), location: null });
    assert.match(r2.text, /^Started order #\d+\. /);
    const nv = (await orderView(a.shopId, r2.orderId))!;
    assert.deepEqual([nv.title, nv.name, nv.placements.map((x) => [x.location, x.stitches])], ["Caps", "Pat Cap", [["Cap front", 3000]]]);
    await expectError("neither an order nor a new one", () => takeInboxItemFor(user(a), idBare, { orderId: null, newOrder: null, location: null }), /^Pick an order, or start a new one\.$/);
    ok("a new order from a file: the customer and title, the file as its first decoration, the place from what was said");

    // 5. The file is checked against what the hub listed; a hub that can't be told.
    const idTamper = hub.add(a.shopId, { fileName: "t.dst", bytes: dst(2000), meta: {} });
    hub.mode.tamper = true;
    const before = (await orderView(a.shopId, o.id))!.placements.length;
    await expectError("changed bytes", () => takeInboxItemFor(user(a), idTamper, { orderId: o.id, newOrder: null, location: null }), /isn't the file the hub listed/);
    hub.mode.tamper = false;
    assert.equal((await orderView(a.shopId, o.id))!.placements.length, before, "nothing was added");
    hub.mode.takeStatus = 500;
    const r3 = await takeInboxItemFor(user(a), idTamper, { orderId: o.id, newOrder: null, location: "Back" });
    assert.match(r3.text, /couldn't be told it was taken/);
    assert.equal((await orderView(a.shopId, o.id))!.placements.length, before + 1, "the order stands");
    hub.mode.takeStatus = 200;
    ok("a file whose bytes aren't the listed size and checksum is refused and nothing is added; a hub that can't be told leaves the order standing and says so");

    // 5b. A preview picture that comes with the file becomes the mock-up, only when the order has none, and never costs the file.
    const PNGB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
    const view2 = cleanItemMeta({ design: "Front logo", format: "DST", hoop: "100x100", fabric: "pique", trims: 12, colorChanges: 3, threadM: 41.3, bobbinM: 18, hack: 1 });
    assert.deepEqual(view2, { design: "Front logo", format: "dst", hoop: "100x100", fabric: "pique", trims: 12, colorChanges: 3, threadM: 41.3, bobbinM: 18 }, "the newer keys are kept and checked");
    assert.deepEqual(cleanItemMeta({ format: "DST;rm", trims: -1, colorChanges: 5000, threadM: Infinity, hoop: 5 }), {}, "bad values of them are dropped");
    const oP = await createOrderFor(user(a), fd(base));
    const idPv = hub.add(a.shopId, { fileName: "front.dst", bytes: dst(2500), meta: { hoop: "100x100", design: "Front" }, preview: PNGB });
    const withPv = (await inboxFor(a.shopId)).items.find((i) => i.id === idPv)!;
    assert.deepEqual([withPv.preview?.size, withPv.preview?.type], [PNGB.length, "image/png"]);
    const rp = await takeInboxItemFor(user(a), idPv, { orderId: oP.id, newOrder: null, location: null });
    assert.match(rp.text, /preview picture was saved as the order's mock-up/);
    const mk = await mockupFile(a.shopId, oP.id);
    assert.deepEqual([mk?.mime, mk ? Buffer.from(mk.data).equals(Buffer.from(PNGB)) : false], ["image/png", true], "the picture is the order's mock-up");
    assert.match((await orderView(a.shopId, oP.id))!.placements[0].note ?? "", /Design: Front\. Hoop 100x100/, "what StitchFoundry said about the design goes in the note");
    // an order that has a mock-up keeps it
    const mine = new File([new Uint8Array([0xff, 0xd8, 0xff, 9, 9])], "mine.jpg");
    await setMockupFor(user(a), o.id, fd({ mockup: mine }));
    const idKeep = hub.add(a.shopId, { fileName: "keep.dst", bytes: dst(2100), meta: {}, preview: PNGB });
    const rk = await takeInboxItemFor(user(a), idKeep, { orderId: o.id, newOrder: null, location: "Back" });
    assert.match(rk.text, /already has a mock-up/);
    assert.equal((await mockupFile(a.shopId, o.id))?.mime, "image/jpeg", "the mock-up someone chose is not replaced");
    // a picture that can't be fetched, isn't a picture, or has the wrong bytes: the file is still taken
    const oQ = await createOrderFor(user(a), fd(base));
    hub.mode.previewStatus = 500;
    const idBadFetch = hub.add(a.shopId, { fileName: "p1.dst", bytes: dst(2200), meta: {}, preview: PNGB });
    const rf = await takeInboxItemFor(user(a), idBadFetch, { orderId: oQ.id, newOrder: null, location: "Left chest" });
    hub.mode.previewStatus = 200;
    assert.match(rf.text, /preview picture couldn't be fetched/);
    assert.equal(await mockupFile(a.shopId, oQ.id), null, "no picture, no mock-up");
    assert.equal((await orderView(a.shopId, oQ.id))!.placements.length, 1, "the design itself was taken");
    const idNotPng = hub.add(a.shopId, { fileName: "p2.dst", bytes: dst(2300), meta: {}, preview: new Uint8Array([60, 115, 118, 103, 62, 1, 2, 3, 4, 5]) });
    const rn = await takeInboxItemFor(user(a), idNotPng, { orderId: oQ.id, newOrder: null, location: "Back" });
    assert.match(rn.text, /isn't usable/);
    assert.equal(await mockupFile(a.shopId, oQ.id), null, "something that isn't a PNG or JPEG is not used");
    hub.mode.tamperPreview = true;
    const idLie = hub.add(a.shopId, { fileName: "p3.dst", bytes: dst(2400), meta: {}, preview: PNGB });
    const rl = await takeInboxItemFor(user(a), idLie, { orderId: oQ.id, newOrder: null, location: "Sleeve" });
    hub.mode.tamperPreview = false;
    assert.match(rl.text, /preview picture couldn't be fetched/, "a picture whose checksum isn't the listed one is not used");
    assert.equal(await mockupFile(a.shopId, oQ.id), null);
    ok("a preview picture becomes the mock-up when the order has none; one a person chose is kept; a picture that can't be fetched or isn't a PNG/JPEG never costs the design; the newer keys are cleaned");

    // 6. Tenant and the module gate.
    const idB = hub.add(b.shopId, { fileName: "b.dst", bytes: dst(1000), meta: {} });
    const oB = await createOrderFor(user(b), fd(base));
    await expectNotFound("B adds to A's order", () => takeInboxItemFor(user(b), idB, { orderId: o.id, newOrder: null, location: null }));
    await expectError("A takes B's file", () => takeInboxItemFor(user(a), idB, { orderId: o.id, newOrder: null, location: null }), /isn't in the inbox any more/);
    assert.equal((await inboxFor(b.shopId)).items.length, 1, "B's file is still B's");
    assert.deepEqual((await inboxFor(a.shopId)).items.every((i) => i.id !== idB), true);
    void oB;
    process.env.PROGRAM_FREE = "off";
    const off = await checkShop({ retail: true });
    hub.add(off.shopId, { fileName: "o.dst", bytes: dst(500), meta: {} });
    const offId = (await inboxFor(off.shopId)).items[0].id;
    await expectError("no Decorating key", () => takeInboxItemFor(user(off), offId, { orderId: null, newOrder: fd({ customerName: "X", customerPhone: "555", title: "T" }), location: null }), /Decorating/);
    ok("tenant: B can't add to A's order and A can't take B's file; with no Decorating key nothing is taken");
  } finally {
    if (savedHub) await db.hubState.update({ where: { id: 1 }, data: { url: savedHub.url, installKey: savedHub.installKey, installId: savedHub.installId, scope: savedHub.scope } }).catch(() => {});
    else await db.hubState.deleteMany({});
    await hub.close();
    await cleanup();
  }
  console.log(`decorating-inbox.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
