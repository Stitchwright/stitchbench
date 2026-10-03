// Sharing is chosen per item, never automatic (HANDOFF section 3 item 9; src/lib/offer.ts):
//   1. the hint form's content is the brand and model (and the photos to tick), from a machine or from a ticket:
//      never the customer, the serial, the problem or the notes; the form and the pages carry no pre-fill
//   2. offering a hint saves brand, model, kind, title, body and the ticked photos; the serial or the customer's name
//      typed in is refused; no hub call is made by the body
//   3. offering a part to partner shops only: the flag and the partner price, in the catalog, and the hub untouched
//   4. offering it on the marketplace only: one POST /v1/listings with the company's name, the copy here is the
//      company's, the partner flag stays off
//   5. both at once; neither refused; a tech can't set what partners pay; a consigned part refused
//   6. withdrawing each: partners (out of the catalog), the marketplace (DELETE on the hub, the copy gone)
//   7. nothing automatic: a new part is offered nowhere, a Details save keeps the partner offer as it was (on stays
//      on, off stays off), a new company's usage sharing is off, and none of that reached the hub
//   8. tenant: company B with A's part, machine and ticket learns and changes nothing of A's
//   npm run check scripts/checks/sharing.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end); the HubState row is pointed at a
// mock hub in this process and put back as it was. Nothing is mailed.
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/user-error";
import { modelKey } from "@/lib/format";
import { hubState } from "@/lib/hub";
import { hintFormFor, offerHintAs, offerPartAs, offersFor, withdrawOfferAs } from "@/lib/offer";
import { catalogFor } from "@/lib/partners";
import type { CurrentUser } from "@/lib/session";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;

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

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), ...rel.split("/")), "utf8");

// ---------- the mock hub: listings only, and a record of every request ----------

type Req = { method: string; path: string; listing?: Record<string, unknown> };
type Mock = { url: string; installKey: string; requests: Req[]; close(): Promise<void> };

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** The "listing" field of a multipart body (the JSON the install sends; photos are the other parts). */
function listingField(raw: Buffer, contentType: string): Record<string, unknown> {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
  if (!boundary) return {};
  const text = raw.toString("latin1");
  for (const part of text.split(`--${boundary}`)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    if (!/name="listing"/.test(headers)) continue;
    const body = part.slice(headerEnd + 4).replace(/\r\n$/, "");
    return JSON.parse(Buffer.from(body, "latin1").toString("utf8")) as Record<string, unknown>;
  }
  return {};
}

async function startMock(): Promise<Mock> {
  const installKey = "shk_check_sharing";
  const requests: Req[] = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const p = (req.url ?? "/").split("?")[0];
    if (p === "/health") return send(200, { ok: true });
    const auth = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    if (auth !== installKey) return send(401, { error: "Join the hub first." });
    const raw = await readBody(req);
    const entry: Req = { method: req.method ?? "GET", path: p };
    if (p === "/v1/listings" && req.method === "POST") {
      const listing = listingField(raw, req.headers["content-type"] ?? "");
      entry.listing = listing;
      requests.push(entry);
      n += 1;
      const now = new Date().toISOString();
      return send(200, {
        id: `lst_${n}`,
        shopName: listing.shopName,
        shopRef: listing.shopRef,
        mine: true,
        title: listing.title,
        description: listing.description ?? null,
        kind: listing.kind,
        condition: listing.condition,
        origin: listing.origin ?? null,
        brand: listing.brand ?? null,
        partNumber: listing.partNumber ?? null,
        xpartId: null,
        fits: listing.fits ?? null,
        priceCents: listing.priceCents,
        currency: "USD",
        qty: listing.qty,
        shippingCents: listing.shippingCents ?? null,
        shippingNote: null,
        shipsFrom: listing.shipsFrom ?? null,
        status: "ACTIVE",
        photos: [],
        createdAt: now,
        updatedAt: now,
        sellerId: "inst_mock",
        sellerRating: null,
      });
    }
    requests.push(entry);
    if (/^\/v1\/listings\/[^/]+$/.test(p) && req.method === "DELETE") return send(200, { ok: true });
    return send(404, { error: "Not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, installKey, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ---------- main ----------

let no = 9100;
async function machineWithTicket(shopId: string, customerId: string, serial: string) {
  const m = await db.machine.create({ data: { shopId, customerId, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P"), serial, notes: "Customer says it was dropped" } });
  const t = await db.ticket.create({
    data: { shopId, number: no++, status: "ON_BENCH", machineId: m.id, customerId, intake: {}, problem: "Skips stitches", diagnosis: "Bent needle bar", workDone: "Replaced it" },
  });
  return { m, t };
}

async function main() {
  const savedHub = await hubState();
  const mock = await startMock();
  const a = await checkShop({ repair: true });
  const b = await checkShop({ repair: true });
  try {
    // The install is joined to the mock hub for the run.
    const joined = { url: mock.url, installId: "inst_mock", installKey: mock.installKey, joinedAt: new Date(), scope: "member", lastError: null };
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...joined }, update: joined });

    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Hannah Private", email: "hannah@example.test" } });
    const { m, t } = await machineWithTicket(a.shopId, cust.id, "SN-778899");
    const photo = await db.machinePhoto.create({ data: { shopId: a.shopId, machineId: m.id, kind: "INSIDE", caption: "Needle bar", mime: "image/jpeg", data: Buffer.from("jpeg") } });

    // ---------- 1. the hint form's content ----------
    const byMachine = await hintFormFor(a.shopId, { machineId: m.id });
    const byTicket = await hintFormFor(a.shopId, { ticketId: t.id });
    for (const [label, h] of [
      ["machine", byMachine],
      ["ticket", byTicket],
    ] as const) {
      assert.ok(h, label);
      assert.deepEqual(Object.keys(h).sort(), ["brand", "machineId", "model", "photos"], `${label}: the form holds brand, model and photos only`);
      assert.equal(h.brand, "Janome");
      assert.equal(h.model, "MC6700P");
      assert.deepEqual(h.photos, [{ id: photo.id, caption: "Needle bar", kind: "INSIDE" }]);
      const text = JSON.stringify(h);
      for (const secret of ["SN-778899", "Hannah", "Skips stitches", "Bent needle bar", "Replaced it", "dropped"]) assert.ok(!text.includes(secret), `${label}: ${secret} isn't in the form`);
    }
    assert.equal(await hintFormFor(a.shopId, { machineId: "nope" }), null);
    // The form and the two pages: no pre-fill of the body, and nothing of the ticket handed to the form.
    const hintForm = src("src/components/hint-form.tsx");
    assert.ok(!/defaultBody|defaultValue=\{[^}]*(diagnosis|workDone|problem|notes|serial|customer)/.test(hintForm), "the hint form has no pre-filled body");
    assert.match(hintForm, /Offer a hint about this model/);
    assert.ok(!fs.existsSync(path.join(process.cwd(), "src", "components", "share-form.tsx")), "the old share form is gone");
    for (const page of ["src/app/(app)/machines/[id]/page.tsx", "src/app/(app)/tickets/[id]/page.tsx"]) {
      const s = src(page);
      const uses = [...s.matchAll(/<HintForm hint=\{\{([^}]*)\}\}/g)].map((x) => x[1]);
      assert.equal(uses.length, 1, `${page} offers the hint once`);
      assert.deepEqual(
        uses[0]
          .split(",")
          .map((x) => x.trim().split(":")[0])
          .filter(Boolean)
          .sort(),
        ["brand", "machineId", "model", "photos"],
        `${page} hands the form brand, model, photos and the machine id only`,
      );
      assert.ok(!/diagnosis|workDone|problem/.test(s.slice(s.indexOf("<HintForm") - 300, s.indexOf("<HintForm") + 300)), `${page}: no ticket text near the form`);
    }
    ok("the hint form, from a machine or a ticket, holds the brand, model and photos only; no pre-fill in the form or the pages");

    // ---------- 2. offering a hint ----------
    await expectError("serial typed in", () => offerHintAs(user(a), m.id, form({ title: "Needle bar", body: "On sn-778899 the bar was bent" })), /serial number/);
    await expectError("customer typed in", () => offerHintAs(user(a), m.id, form({ title: "Hannah Private's machine", body: "bent bar" })), /customer's name/);
    await expectError("no title", () => offerHintAs(user(a), m.id, form({ body: "x" })), /short title/);
    await expectError("bad kind", () => offerHintAs(user(a), m.id, form({ title: "t", body: "b", kind: "RANT" })), /what kind/);
    const hintFd = form({ title: "Needle bar bends if dropped", body: "Check the bar for a bend before timing.", kind: "TIP" });
    hintFd.append("photoIds", photo.id);
    const postId = await offerHintAs(user(a), m.id, hintFd);
    const post = await db.sharedPost.findUniqueOrThrow({ where: { id: postId }, include: { photos: true } });
    assert.deepEqual(
      { shopId: post.shopId, authorId: post.authorId, brand: post.brand, model: post.model, kind: post.kind, title: post.title, body: post.body, hubId: post.hubId, photos: post.photos.length },
      {
        shopId: a.shopId,
        authorId: a.user.id,
        brand: "Janome",
        model: "MC6700P",
        kind: "TIP",
        title: "Needle bar bends if dropped",
        body: "Check the bar for a bend before timing.",
        hubId: null,
        photos: 1,
      },
    );
    assert.equal(mock.requests.length, 0, "the hint body makes no hub call of its own (the sync sends it)");
    ok("a hint saves brand, model, kind, title, body and the ticked photo; the serial or the customer's name typed in is refused");

    // ---------- 3. a part to partner shops only ----------
    const part = await db.part.create({ data: { shopId: a.shopId, partNumber: "BC-700", description: "Bobbin case", numberKeys: ["BC700"], qtyOnHand: 3, priceCents: 1600, brand: "Janome" } });
    await expectError("no partner price", () => offerPartAs(user(a), part.id, form({ partners: "on" })), /partner price/);
    let r = await offerPartAs(user(a), part.id, form({ partners: "on", wholesale: "11.50" }));
    assert.deepEqual(r, { partners: true, listingId: null });
    let p = await db.part.findUniqueOrThrow({ where: { id: part.id } });
    assert.equal(p.offerToPartners, true);
    assert.equal(p.wholesaleCents, 1150);
    assert.deepEqual(
      (await catalogFor(a.shopId)).map((i) => [i.partNumber, i.wholesaleCents]),
      [["BC-700", 1150]],
    );
    let offers = await offersFor(a.shopId, p);
    assert.deepEqual(offers, { partners: { on: true, wholesaleCents: 1150 }, listings: [] });
    assert.equal(mock.requests.length, 0, "a partner offer touches no hub endpoint");
    ok("offered to partner shops only: the flag and the partner price, in the catalog, the hub untouched");

    // ---------- 4. on the marketplace only ----------
    const part2 = await db.part.create({ data: { shopId: a.shopId, partNumber: "FD-100", description: "Feed dog", numberKeys: ["FD100"], qtyOnHand: 2, priceCents: 2400, brand: "Janome" } });
    await expectError("no price", () => offerPartAs(user(a), part2.id, form({ market: "on", title: "Feed dog", qty: "2" })), /price each/);
    r = await offerPartAs(user(a), part2.id, form({ market: "on", title: "Janome feed dog, new", price: "24.00", qty: "2", partNumber: "FD-100", brand: "Janome", clientId: "chk-fd" }));
    assert.equal(r.partners, false);
    assert.equal(r.listingId, "lst_1");
    assert.deepEqual(
      mock.requests.map((x) => [x.method, x.path]),
      [["POST", "/v1/listings"]],
    );
    const sent = mock.requests[0].listing!;
    assert.equal(sent.shopRef, a.shopId);
    assert.equal(sent.shopName, a.name);
    assert.equal(sent.title, "Janome feed dog, new");
    assert.equal(sent.priceCents, 2400);
    assert.equal(sent.clientId, "chk-fd");
    assert.ok(!("address" in sent) && !("email" in sent), "nothing of the shop but its id and name");
    const l = await db.listing.findUniqueOrThrow({ where: { id: "lst_1" } });
    assert.equal(l.mine, true);
    assert.equal(l.shopId, a.shopId);
    assert.equal(l.numberKey, "FD100");
    p = await db.part.findUniqueOrThrow({ where: { id: part2.id } });
    assert.equal(p.offerToPartners, false, "the marketplace choice doesn't offer it to partners");
    offers = await offersFor(a.shopId, p);
    assert.deepEqual(offers.partners, { on: false, wholesaleCents: null });
    assert.deepEqual(
      offers.listings.map((x) => [x.id, x.title, x.qty, x.priceCents, x.status]),
      [["lst_1", "Janome feed dog, new", 2, 2400, "ACTIVE"]],
    );
    ok("listed on the marketplace only: one POST with the company's name, the copy here is the company's, partners untouched");

    // ---------- 5. both, neither, a tech, a consigned part ----------
    const part3 = await db.part.create({ data: { shopId: a.shopId, partNumber: "NP-5", description: "Needle plate", numberKeys: ["NP5"], qtyOnHand: 1, priceCents: 3000, wholesaleCents: 2000 } });
    await expectError("neither", () => offerPartAs(user(a), part3.id, form({ title: "x" })), /Pick where/);
    assert.equal(mock.requests.length, 1);
    r = await offerPartAs(user(a), part3.id, form({ partners: "on", market: "on", title: "Needle plate", price: "30", qty: "1", partNumber: "NP-5" }));
    assert.deepEqual(r, { partners: true, listingId: "lst_2" });
    p = await db.part.findUniqueOrThrow({ where: { id: part3.id } });
    assert.equal(p.offerToPartners, true);
    assert.equal(p.wholesaleCents, 2000, "the saved partner price stands when none is typed");
    offers = await offersFor(a.shopId, p);
    assert.equal(offers.partners.on, true);
    assert.equal(offers.listings.length, 1);
    const tech: CurrentUser = { ...a.user, id: a.user.id, role: "TECH" };
    await expectError("tech to partners", () => offerPartAs(tech, part2.id, form({ partners: "on", wholesale: "1" })), /owner or admin/);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part2.id } })).offerToPartners, false);
    const link = await db.partnerLink.create({ data: { id: `chk${Date.now().toString(36)}`, shopId: a.shopId, side: "repair", partnerName: "Sewing Shop" } });
    const consigned = await db.part.create({ data: { shopId: a.shopId, partNumber: "CN-1", description: "Consigned thread", numberKeys: ["CN1"], consignLinkId: link.id } });
    await expectError("consigned", () => offerPartAs(user(a), consigned.id, form({ partners: "on", wholesale: "2" })), /consigned stock/);
    assert.equal(mock.requests.length, 2, "the refusals made no hub call");
    ok("both at once (the saved partner price stands); neither refused; a tech can't set what partners pay; a consigned part refused");

    // ---------- 6. withdrawing ----------
    await withdrawOfferAs(user(a), part.id, "partners");
    p = await db.part.findUniqueOrThrow({ where: { id: part.id } });
    assert.equal(p.offerToPartners, false);
    assert.equal(p.wholesaleCents, 1150, "the price stays for next time");
    assert.deepEqual(
      (await catalogFor(a.shopId)).map((i) => i.partNumber),
      ["NP-5"],
    );
    await expectError("withdraw twice", () => withdrawOfferAs(user(a), part.id, "partners"), /isn't offered/);
    await expectError("tech withdraws partners", () => withdrawOfferAs(tech, part3.id, "partners"), /owner or admin/);
    assert.equal(mock.requests.length, 2, "a partner withdrawal touches no hub endpoint");
    await expectError("no listing id", () => withdrawOfferAs(user(a), part2.id, "market"), /which listing/);
    await expectError("another part's listing", () => withdrawOfferAs(user(a), part2.id, "market", "lst_2"), /isn't of this part/);
    await withdrawOfferAs(user(a), part2.id, "market", "lst_1");
    assert.deepEqual(
      mock.requests.slice(2).map((x) => [x.method, x.path]),
      [["DELETE", "/v1/listings/lst_1"]],
    );
    assert.equal(await db.listing.count({ where: { id: "lst_1" } }), 0);
    assert.deepEqual((await offersFor(a.shopId, part2)).listings, []);
    await expectError("withdraw a gone listing", () => withdrawOfferAs(user(a), part2.id, "market", "lst_1"), /isn't one of yours/);
    ok("withdrawn from partner shops (out of the catalog, price kept) and off the marketplace (one DELETE, the copy gone)");

    // ---------- 7. nothing automatic ----------
    const before = mock.requests.length;
    const fresh = await db.part.findUniqueOrThrow({ where: { id: part2.id } });
    assert.deepEqual(await offersFor(a.shopId, fresh), { partners: { on: false, wholesaleCents: null }, listings: [] }, "a part starts offered nowhere");
    // The Details form no longer carries the partner offer: saving it keeps the offer as it is, on or off.
    const partsSrc = src("src/actions/parts.ts");
    assert.ok(!/formData\.get\("offerToPartners"\)/.test(partsSrc), "partData doesn't read an offer from the Details form");
    assert.ok(!/offerToPartners/.test(src("src/components/part-fields.tsx")), "the Details form has no offer checkbox");
    // updatePart needs a signed-in session, so the Details save is shown by what partData builds: with no offer key in
    // it, Prisma leaves the column as it is (on stays on, off stays off), and the TECH line no longer names it either.
    assert.ok(!/offerToPartners/.test(partsSrc), "neither partData nor updatePart's tech rule touches the partner offer");
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part3.id } })).offerToPartners, true);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part2.id } })).offerToPartners, false);
    const shopA = await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { shareUsage: true, hubWritesOff: true } });
    assert.equal(shopA.shareUsage, false, "a new company's monthly parts counts are not offered");
    assert.equal(shopA.hubWritesOff, false);
    assert.equal(mock.requests.length, before, "none of that reached the hub");
    // The usage report is per company and off unless turned on: the schema's default and pushUsage's skip.
    assert.match(src("prisma/schema.prisma"), /shareUsage\s+Boolean\s+@default\(false\)/, "Shop.shareUsage defaults to false");
    assert.match(src("src/lib/hub.ts"), /if \(!shop\.shareUsage\) \{/, "pushUsage skips a company that hasn't turned it on");
    ok("nothing automatic: a part starts offered nowhere, the Details form carries no offer, usage sharing is off by default, no hub call");

    // ---------- 8. tenant ----------
    const snapA = await snapshot(a.shopId, ["Part", "SharedPost", "Listing"]);
    await expectNotFound("hintFormFor(B, A's machine)", () => hintFormFor(b.shopId, { machineId: m.id }));
    await expectNotFound("hintFormFor(B, A's ticket)", () => hintFormFor(b.shopId, { ticketId: t.id }));
    await expectNotFound("offerHintAs(B, A's machine)", () => offerHintAs(user(b), m.id, form({ title: "t", body: "b" })));
    await expectNotFound("offerPartAs(B, A's part)", () => offerPartAs(user(b), part.id, form({ partners: "on", wholesale: "1" })));
    await expectNotFound("offerPartAs(B, A's part, market)", () => offerPartAs(user(b), part.id, form({ market: "on", title: "t", price: "1", qty: "1" })));
    await expectNotFound("withdrawOfferAs(B, A's part)", () => withdrawOfferAs(user(b), part3.id, "partners"));
    await expectNotFound("withdrawOfferAs(B, A's listing)", () => withdrawOfferAs(user(b), part3.id, "market", "lst_2"));
    // B's own part, A's listing: refused as not B's.
    const bPart = await db.part.create({ data: { shopId: b.shopId, partNumber: "NP-5", description: "Needle plate", numberKeys: ["NP5"] } });
    await expectError("B's part, A's listing", () => withdrawOfferAs(user(b), bPart.id, "market", "lst_2"), /isn't one of yours/);
    assert.deepEqual(await offersFor(b.shopId, bPart), { partners: { on: false, wholesaleCents: null }, listings: [] }, "A's listing of the same number isn't B's");
    assert.deepEqual(await catalogFor(b.shopId), []);
    assert.equal(mock.requests.length, before, "B's refused calls reached no hub endpoint");
    assertUnchanged("tenant", snapA, await snapshot(a.shopId, ["Part", "SharedPost", "Listing"]));
    ok("tenant: B's calls with A's machine, ticket, part and listing learn and change nothing of A's");
  } finally {
    await db.listing.deleteMany({ where: { id: { in: ["lst_1", "lst_2"] } } }).catch(() => undefined);
    if (savedHub) {
      const { id: _id, ...data } = savedHub;
      void _id;
      await db.hubState.update({ where: { id: 1 }, data }).catch((e) => console.error("restoring HubState:", e));
    } else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => undefined);
    await cleanup();
    await mock.close();
  }
  console.log(`sharing.check: ${steps} groups passed (mock hub ${mock.url})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
