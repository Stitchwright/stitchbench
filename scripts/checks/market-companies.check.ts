// The marketplace on an install that holds two companies (round-3 I12 and I13: docs/round3/ROUND3_REMAINING_2026-10-03.md, batch I).
// The real server actions in src/actions/market.ts (and offerPart, saveShop) run against a mock hub in this process that
// keeps the hub's rules: a row belongs to the company that made it (X-Shop-Ref, the 403 "belongs to another company"), a
// company can't order on its own install, and the order steps are the hub's (src/market.mjs).
//   1. two companies list under their own names (the form and a part's "Offer this part"): the hub row names the company,
//      the copy here is that company's, and another company can't offer a part that isn't its own
//   2. two companies buy under their own names: buyer name and contact, the order is each company's, a retried form is
//      one order, and the hub's refusals (own install, quantity) come back in words
//   3. the buyer's side: paid, received (into stock for the buyer only), rating (1 to 5, the hub's "once it is paid"),
//      cancel before and after the seller accepted (the units go back on the listing)
//   4. the seller's side: orders reach the company that listed the item; decline, accept (stock on the listing), ship
//      before payment, take from stock (only the seller's own part, never twice), cancel after accepting
//   5. a listing paused or edited: price, quantity (a stale number is refused by the hub in words), sold out, active again
//   6. a listing removed with orders open: the orders stay the company's and carry on; an order that arrives after
//      the removal still reaches the company (the hub names it), and one that names none reaches nobody
//   7. a tech: accepts with the shop's saved pay instructions only, is refused without them, and can't set them
//   8. the hub's 403 for a row of another company (a copy here that disagrees with the hub) reaches the person as a plain message
//   9. tenant: company B's calls with A's listings, orders and parts are refused, reach no hub endpoint, and change nothing of A's
//   npm run check scripts/checks/market-companies.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end); the HubState row is pointed at the mock
// hub and put back as it was; the listings and orders made here are removed. Nothing is mailed.
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import Module from "node:module";
import { db } from "@/lib/db";
import { hubState, syncHub } from "@/lib/hub";
import { lapseUserFrom } from "@/lib/lapse-guard";
import { appName } from "@/lib/shops";
import { orderStockNote } from "@/lib/parts";
import type { CurrentUser } from "@/lib/session";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, RUN, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

// ---------- the actions, outside Next ----------
// The actions ask who is signed in (the session), revalidate pages and redirect: none of that exists outside a request.
// The session says whoever `who` is, revalidatePath does nothing and redirect says where it went.

class Redirected extends Error {
  constructor(public url: string) {
    super(`redirect to ${url}`);
  }
}
let who: CurrentUser | null = null;
const needUser = () => {
  if (!who) throw new Error("check script: nobody is signed in");
  return who;
};
const sessionStub = {
  requireUser: async () => needUser(),
  sessionUser: async () => who,
  requireAdmin: async () => {
    const u = needUser();
    if (u.role === "TECH") throw new (await import("@/lib/user-error")).UserError("Only the shop owner or an admin can change this.");
    return u;
  },
};
type Loader = { _load: (request: string, ...rest: unknown[]) => unknown };
const loader = Module as unknown as Loader;
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === "@/lib/session") return sessionStub;
  if (request === "next/cache") return { revalidatePath: () => undefined };
  if (request === "next/navigation") {
    return {
      redirect: (url: string) => {
        throw new Redirected(url);
      },
    };
  }
  return realLoad.call(this, request, ...rest);
};
/* eslint-disable @typescript-eslint/no-require-imports */
const market = require("@/actions/market") as typeof import("@/actions/market");
const settings = require("@/actions/settings") as typeof import("@/actions/settings");
/* eslint-enable @typescript-eslint/no-require-imports */
lapseUserFrom(async () => who);

type Out = { ok?: boolean; error?: string; redirect?: string };
/** Runs an action as this person: what it answered, or where it sent them. */
async function as(user: CurrentUser, fn: () => Promise<unknown>): Promise<Out> {
  who = user;
  try {
    return (await fn()) as Out;
  } catch (e) {
    if (e instanceof Redirected) return { ok: true, redirect: e.url };
    throw e;
  } finally {
    who = null;
  }
}
async function mustFail(label: string, user: CurrentUser, fn: () => Promise<unknown>, re: RegExp) {
  const r = await as(user, fn);
  assert.ok(r.error, `${label}: no error (${JSON.stringify(r)})`);
  assert.match(r.error, re, label);
}
async function mustWork(label: string, user: CurrentUser, fn: () => Promise<unknown>) {
  const r = await as(user, fn);
  assert.equal(r.error, undefined, `${label}: ${r.error}`);
  return r;
}

// ---------- the mock hub: listings, orders, the steps and the company rules ----------

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type MListing = { id: string; own: boolean; shopRef: string | null; shopName: string; f: J; qty: number; status: string; createdAt: string; updatedAt: string };
type MOrder = {
  id: string;
  number: string;
  listingId: string;
  side: "buyer" | "seller"; // which side this install is
  ourRef: string | null; // the company on this install that is that side
  sellerShop: string;
  buyerShop: string;
  item: J;
  qty: number;
  unit: number;
  shipping: number | null;
  shipTo: string | null;
  buyerNote: string | null;
  buyerContact: J | null;
  sellerContact: J | null;
  pay: string | null;
  status: string;
  buyerPaidNote: string | null;
  paidAt: string | null;
  carrier: string | null;
  tracking: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
  cancelReason: string | null;
  events: J[];
  ratings: { buyer: J | null; seller: J | null };
  clientId: string | null;
  updatedAt: string;
};
type Req = { method: string; path: string; shop: string | undefined; body: J };
type Mock = {
  url: string;
  installKey: string;
  requests: Req[];
  listings: Map<string, MListing>;
  orders: Map<string, MOrder>;
  /** A listing of another install's on the hub. */
  addOutsideListing(o: { title: string; qty: number; shippingCents?: number | null; partNumber?: string | null }): MListing;
  /** The outside seller (another install) takes a step on an order this install placed. */
  outsideStep(orderId: string, action: "accept" | "paid" | "ship"): void;
  /** An outside shop orders one of this install's listings: it waits on the hub until the next sync brings it. */
  incoming(listingId: string, qty: number, o?: { buyer?: string; withRef?: boolean }): MOrder;
  close(): Promise<void>;
};

const OPEN = ["REQUESTED", "ACCEPTED", "PAID"];
const nowIso = () => new Date().toISOString();

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** The "listing" field of a multipart body (the JSON the install sends; photos are the other parts). */
function listingField(raw: Buffer, contentType: string): J {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
  if (!boundary) return {};
  for (const part of raw.toString("latin1").split(`--${boundary}`)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0 || !/name="listing"/.test(part.slice(0, headerEnd))) continue;
    return JSON.parse(Buffer.from(part.slice(headerEnd + 4).replace(/\r\n$/, ""), "latin1").toString("utf8")) as J;
  }
  return {};
}

async function startMock(): Promise<Mock> {
  const installKey = "shk_check_market_companies";
  const requests: Req[] = [];
  const listings = new Map<string, MListing>();
  const orders = new Map<string, MOrder>();
  let nListing = 0;
  let nOrder = 0;

  const listingView = (l: MListing) => ({
    id: l.id,
    shopName: l.shopName,
    mine: l.own,
    shopRef: l.shopRef,
    title: l.f.title,
    description: l.f.description ?? null,
    kind: l.f.kind ?? "PART",
    condition: l.f.condition ?? "NEW",
    origin: l.f.origin ?? null,
    brand: l.f.brand ?? null,
    partNumber: l.f.partNumber ?? null,
    xpartId: null,
    fits: l.f.fits ?? null,
    priceCents: l.f.priceCents,
    currency: "USD",
    qty: l.qty,
    shippingCents: l.f.shippingCents ?? null,
    shippingNote: l.f.shippingNote ?? null,
    shipsFrom: l.f.shipsFrom ?? null,
    status: l.status,
    photos: [],
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    sellerId: l.own ? "inst_mock" : "inst_outside",
    sellerRating: null,
  });
  const orderView = (o: MOrder) => ({
    id: o.id,
    number: o.number,
    role: o.side,
    listingId: o.listingId,
    item: o.item,
    sellerShop: o.sellerShop,
    buyerShop: o.buyerShop,
    sellerShopRef: o.side === "seller" ? o.ourRef : null,
    buyerShopRef: o.side === "buyer" ? o.ourRef : null,
    qty: o.qty,
    unitPriceCents: o.unit,
    shippingCents: o.shipping,
    totalCents: o.unit * o.qty + (o.shipping ?? 0),
    currency: "USD",
    shipTo: o.shipTo,
    buyerNote: o.buyerNote,
    buyerContact: o.buyerContact,
    sellerContact: o.sellerContact,
    payInstructions: o.pay,
    status: o.status,
    buyerPaidNote: o.buyerPaidNote,
    paidAt: o.paidAt,
    carrier: o.carrier,
    tracking: o.tracking,
    trackingUrl: null,
    shippedAt: o.shippedAt,
    receivedAt: o.receivedAt,
    cancelReason: o.cancelReason,
    createdAt: o.events[0]?.at ?? o.updatedAt,
    updatedAt: o.updatedAt,
    events: o.events,
    ratings: o.ratings,
  });
  const event = (o: MOrder, by: "buyer" | "seller", action: string, note: string | null = null) => {
    o.events.push({ at: nowIso(), by, action, note });
    o.updatedAt = nowIso();
  };
  const newOrder = (o: Partial<MOrder> & Pick<MOrder, "listingId" | "side" | "ourRef" | "qty" | "sellerShop" | "buyerShop">, l: MListing): MOrder => {
    nOrder += 1;
    const full: MOrder = {
      id: `ord_${nOrder}`,
      number: `SH-${String(nOrder).padStart(6, "0")}`,
      item: { title: l.f.title, brand: l.f.brand ?? null, partNumber: l.f.partNumber ?? null, condition: l.f.condition ?? "NEW", origin: l.f.origin ?? null },
      unit: l.f.priceCents,
      shipping: l.f.shippingCents ?? null,
      shipTo: null,
      buyerNote: null,
      buyerContact: null,
      sellerContact: null,
      pay: null,
      status: "REQUESTED",
      buyerPaidNote: null,
      paidAt: null,
      carrier: null,
      tracking: null,
      shippedAt: null,
      receivedAt: null,
      cancelReason: null,
      events: [],
      ratings: { buyer: null, seller: null },
      clientId: null,
      updatedAt: nowIso(),
      ...o,
    };
    orders.set(full.id, full);
    event(full, "buyer", "requested");
    return full;
  };
  const restock = (o: MOrder) => {
    const l = listings.get(o.listingId);
    if (!l) return;
    l.qty += o.qty;
    if (l.status === "SOLD_OUT") l.status = "ACTIVE";
    l.updatedAt = nowIso();
  };

  class Refuse extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  const sameCompany = (acting: string | undefined, rowRef: string | null, what: string) => {
    if (acting && rowRef && acting !== rowRef) throw new Refuse(403, `That ${what} belongs to another company on your StitchBench.`);
  };

  /** One step of an order, as the hub does it (StitchHub src/market.mjs). */
  function step(o: MOrder, action: string, acting: string | undefined, body: J): MOrder {
    sameCompany(acting, o.ourRef, "order");
    const mine = o.side;
    const need = (role: "buyer" | "seller" | "either", from: string[] | null) => {
      if (role !== "either" && mine !== role) throw new Refuse(409, role === "seller" ? "Only the seller can do that." : "Only the buyer can do that.");
      if (from && !from.includes(o.status)) throw new Refuse(409, `This order is ${o.status.toLowerCase()}, so that can't be done now.`);
    };
    const l = listings.get(o.listingId);
    switch (action) {
      case "accept": {
        need("seller", ["REQUESTED"]);
        let shipping = o.shipping;
        if (body.shippingCents !== undefined && body.shippingCents !== null) shipping = Number(body.shippingCents);
        if (shipping == null) throw new Refuse(400, "Enter the shipping cost for this order (the listing has no flat rate).");
        if (!l || l.status === "REMOVED") throw new Refuse(409, "That listing was removed.");
        if (l.qty < o.qty) throw new Refuse(409, `Only ${l.qty} left on the listing.`);
        l.qty -= o.qty;
        if (l.qty === 0) l.status = "SOLD_OUT";
        l.updatedAt = nowIso();
        o.shipping = shipping;
        o.status = "ACCEPTED";
        o.sellerContact = body.sellerContact ?? null;
        o.pay = body.payInstructions ?? null;
        event(o, mine, "accepted");
        break;
      }
      case "decline":
        need("seller", ["REQUESTED"]);
        o.status = "DECLINED";
        o.cancelReason = body.reason ?? null;
        event(o, mine, "declined", o.cancelReason);
        break;
      case "buyer-paid":
        need("buyer", ["ACCEPTED"]);
        o.buyerPaidNote = body.note ?? "payment sent";
        event(o, mine, "buyer-paid", o.buyerPaidNote);
        break;
      case "paid":
        need("seller", ["ACCEPTED"]);
        o.status = "PAID";
        o.paidAt = nowIso();
        event(o, mine, "paid");
        break;
      case "ship":
        need("seller", ["ACCEPTED", "PAID"]);
        if (!body.carrier || !body.tracking) throw new Refuse(400, "Enter the carrier and the tracking number.");
        o.status = "SHIPPED";
        o.carrier = body.carrier;
        o.tracking = body.tracking;
        o.shippedAt = nowIso();
        event(o, mine, "shipped", `${o.carrier} ${o.tracking}`);
        break;
      case "received":
        need("buyer", ["SHIPPED"]);
        o.status = "RECEIVED";
        o.receivedAt = nowIso();
        event(o, mine, "received");
        break;
      case "cancel":
        need("either", OPEN);
        if (o.status !== "REQUESTED") restock(o);
        o.status = "CANCELLED";
        o.cancelReason = body.reason ?? null;
        event(o, mine, "cancelled", o.cancelReason);
        break;
      case "message":
        need("either", null);
        if (!body.text) throw new Refuse(400, "Write a message.");
        event(o, mine, "message", body.text);
        break;
      case "rate": {
        const stars = Number(body.stars);
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Refuse(400, "Give 1 to 5 stars.");
        const answering = mine === "buyer" && o.ratings.seller != null;
        if (!["PAID", "SHIPPED", "RECEIVED"].includes(o.status) && !answering) {
          throw new Refuse(409, mine === "buyer" ? "You can rate the seller once the order is paid." : "You can rate the buyer once they've paid.");
        }
        o.ratings[mine] = { stars, comment: body.comment ?? null, at: nowIso() };
        event(o, mine, "rated", `${stars} star${stars === 1 ? "" : "s"}`);
        break;
      }
      default:
        throw new Refuse(404, "Not found");
    }
    return o;
  }

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
    const method = req.method ?? "GET";
    const shop = (req.headers["x-shop-ref"] as string | undefined)?.trim() || undefined;
    const multipart = (req.headers["content-type"] ?? "").startsWith("multipart/");
    let body: J = {};
    if (multipart) body = { listing: listingField(raw, req.headers["content-type"] ?? "") };
    else if (raw.length) {
      try {
        body = JSON.parse(raw.toString("utf8")) as J;
      } catch {
        body = {};
      }
    }
    requests.push({ method, path: p, shop, body });
    try {
      // What the sync asks
      if (p === "/v1/me") return send(200, { hubName: "Mock hub", scope: "member" });
      if (p === "/v1/changes") return send(200, { links: [], posts: [], figures: [], xparts: [], listings: [], next: "0", more: false });
      if (p === "/v1/orders" && method === "GET") return send(200, { orders: [...orders.values()].map(orderView), next: String(nOrder) });

      if (p === "/v1/listings" && method === "POST") {
        const f = body.listing as J;
        if (f.shopRef && shop && f.shopRef !== shop) throw new Refuse(403, "That listing belongs to another company on your StitchBench.");
        nListing += 1;
        const l: MListing = {
          id: `lst_${nListing}`,
          own: true,
          shopRef: shop ?? f.shopRef ?? null,
          shopName: f.shopName ?? "Install",
          f,
          qty: f.qty,
          status: "ACTIVE",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        listings.set(l.id, l);
        return send(200, listingView(l));
      }
      const lm = /^\/v1\/listings\/([^/]+)$/.exec(p);
      if (lm && (method === "PUT" || method === "DELETE")) {
        const l = listings.get(lm[1]);
        if (!l) throw new Refuse(404, "No such listing.");
        if (!l.own) throw new Refuse(403, "Only the shop that listed it can change it.");
        sameCompany(shop, l.shopRef, "listing");
        if (method === "DELETE") {
          l.status = "REMOVED";
          l.updatedAt = nowIso();
          return send(200, { ok: true });
        }
        if (l.status === "REMOVED") throw new Refuse(409, "That listing was removed.");
        if (body.qty !== undefined && body.expectedQty !== undefined && body.expectedQty !== l.qty) {
          throw new Refuse(409, `Orders changed how many are left on this listing (now ${l.qty}) since the page was opened. Check the quantity and save again.`);
        }
        for (const k of ["title", "description", "shippingNote", "shipsFrom", "condition", "priceCents", "shippingCents"]) if (k in body) l.f[k] = body[k];
        if (body.qty !== undefined) l.qty = body.qty;
        if (body.status !== undefined) l.status = body.status;
        if (l.qty === 0) l.status = "SOLD_OUT";
        else if (l.status === "SOLD_OUT") l.status = "ACTIVE";
        l.updatedAt = nowIso();
        return send(200, listingView(l));
      }

      if (p === "/v1/orders" && method === "POST") {
        const buyerRef: string = body.shopRef ?? "";
        if (body.clientId) {
          const had = [...orders.values()].find((o) => o.clientId === body.clientId && o.side === "buyer");
          if (had) return send(200, orderView(had));
        }
        const l = listings.get(String(body.listingId ?? ""));
        if (!l || l.status === "REMOVED") throw new Refuse(404, "That listing isn't on the hub.");
        if (l.own) {
          throw new Refuse(
            409,
            l.shopRef && l.shopRef !== buyerRef ? "That listing is another company's on your own StitchBench: arrange it with them directly." : "You can't order your own listing.",
          );
        }
        if (!body.shipTo) throw new Refuse(400, "Give the address to ship to.");
        if (l.status !== "ACTIVE") throw new Refuse(409, l.status === "SOLD_OUT" ? "That listing is sold out." : "That listing is paused right now.");
        if (body.qty > l.qty) throw new Refuse(409, `Only ${l.qty} left on that listing.`);
        const o = newOrder(
          { listingId: l.id, side: "buyer", ourRef: buyerRef || null, qty: body.qty, sellerShop: l.shopName, buyerShop: body.shopName ?? "Install", clientId: body.clientId ?? null },
          l,
        );
        o.shipTo = body.shipTo;
        o.buyerNote = body.buyerNote ?? null;
        o.buyerContact = body.buyerContact ?? null;
        return send(200, orderView(o));
      }
      const om = /^\/v1\/orders\/([^/]+)\/([a-z-]+)$/.exec(p);
      if (om && method === "POST") {
        const o = orders.get(om[1]);
        if (!o) throw new Refuse(404, "No such order.");
        return send(200, orderView(step(o, om[2], (body.shopRef as string | undefined) ?? shop, body)));
      }
      return send(404, { error: "Not found" });
    } catch (e) {
      if (e instanceof Refuse) return send(e.status, { error: e.message });
      return send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    installKey,
    requests,
    listings,
    orders,
    addOutsideListing(o) {
      nListing += 1;
      const l: MListing = {
        id: `lst_${nListing}`,
        own: false,
        shopRef: "outside-1",
        shopName: "Outside Sewing",
        f: { title: o.title, priceCents: 1000, shippingCents: o.shippingCents === undefined ? 500 : o.shippingCents, partNumber: o.partNumber ?? null, condition: "NEW" },
        qty: o.qty,
        status: "ACTIVE",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      listings.set(l.id, l);
      return l;
    },
    outsideStep(orderId, action) {
      const o = orders.get(orderId);
      assert.ok(o && o.side === "buyer", "outside steps are on orders this install placed");
      // The outside seller is another install: its steps are the seller's.
      const l = listings.get(o.listingId);
      if (action === "accept") {
        assert.ok(l && l.qty >= o.qty);
        l.qty -= o.qty;
        o.status = "ACCEPTED";
        o.shipping = o.shipping ?? 0;
        o.pay = "Outside pays";
        event(o, "seller", "accepted");
      } else if (action === "paid") {
        o.status = "PAID";
        o.paidAt = nowIso();
        event(o, "seller", "paid");
      } else {
        o.status = "SHIPPED";
        o.carrier = "USPS";
        o.tracking = "9400";
        o.shippedAt = nowIso();
        event(o, "seller", "shipped", "USPS 9400");
      }
    },
    incoming(listingId, qty, o = {}) {
      const l = listings.get(listingId);
      assert.ok(l && l.own, "an incoming order is on this install's listing");
      const order = newOrder({ listingId: l.id, side: "seller", ourRef: o.withRef === false ? null : l.shopRef, qty, sellerShop: l.shopName, buyerShop: o.buyer ?? "Outside Buyer" }, l);
      order.shipTo = "9 Outside Rd";
      order.buyerContact = { name: o.buyer ?? "Outside Buyer", email: "buyer@outside.test" };
      return order;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---------- main ----------

const asRole = (u: CurrentUser, role: CurrentUser["role"], id: string, name: string): CurrentUser => ({ ...u, id, role, name });

async function main() {
  const savedHub = await hubState();
  const mock = await startMock();
  const a: CheckShop = await checkShop({ repair: true });
  const b: CheckShop = await checkShop({ repair: true });
  const orderIds: string[] = [];
  try {
    const joined = { url: mock.url, installId: "inst_mock", installKey: mock.installKey, joinedAt: new Date(), scope: "member", lastError: null, cursor: "0", orderCursor: "0" };
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...joined }, update: joined });
    const techA = await db.user.create({ data: { shopId: a.shopId, email: `check-${RUN}-techa@stitchbench.test`, name: "Tech A", role: "TECH", passwordHash: "x" }, select: { id: true } });
    const techB = await db.user.create({ data: { shopId: b.shopId, email: `check-${RUN}-techb@stitchbench.test`, name: "Tech B", role: "TECH", passwordHash: "x" }, select: { id: true } });
    const tA = asRole(a.user, "TECH", techA.id, "Tech A");
    const tB = asRole(b.user, "TECH", techB.id, "Tech B");
    await db.shop.update({ where: { id: a.shopId }, data: { address: "1 Alpha Street" } });
    await db.shop.update({ where: { id: b.shopId }, data: { address: null } });
    const last = () => mock.requests[mock.requests.length - 1];
    // A sync follows an accept or a cancel (syncSoon): the step is the last one that was an order step.
    const accept = () => [...mock.requests].reverse().find((r) => /^\/v1\/orders\/[^/]+\/accept$/.test(r.path))!;
    const calls = () => mock.requests.length;
    const listingRow = (id: string) => db.listing.findUnique({ where: { id } });
    const orderRow = (id: string) => db.marketOrder.findUnique({ where: { id } });
    const partOf = (shopId: string, number: string) => db.part.findFirst({ where: { shopId, partNumber: number } });
    const hubOrder = (id: string) => mock.orders.get(id)!;

    // ---------- 1. two companies list under their own names ----------
    const partA = await db.part.create({ data: { shopId: a.shopId, partNumber: "BC-700", description: "Bobbin case", numberKeys: ["BC700"], qtyOnHand: 5, priceCents: 1600 } });
    await db.part.create({ data: { shopId: b.shopId, partNumber: "BC-700", description: "Bobbin case", numberKeys: ["BC700"], qtyOnHand: 7, priceCents: 1700 } });
    const listA = await as(a.user, () => market.createListing(form({ title: "Bobbin case from A", price: "12.50", qty: "3", partNumber: "BC-700", shipping: "4.00" })));
    assert.equal(listA.redirect, "/market/lst_1");
    assert.deepEqual(
      { path: last().path, shop: last().shop, ref: last().body.listing.shopRef, name: last().body.listing.shopName },
      { path: "/v1/listings", shop: a.shopId, ref: a.shopId, name: a.name },
    );
    const listB = await as(b.user, () => market.createListing(form({ title: "Bobbin case from B", price: "13.00", qty: "2", partNumber: "BC-700", shipping: "4.00" })));
    assert.equal(listB.redirect, "/market/lst_2");
    assert.deepEqual({ shop: last().shop, ref: last().body.listing.shopRef, name: last().body.listing.shopName }, { shop: b.shopId, ref: b.shopId, name: b.name });
    const LA = "lst_1";
    const LB = "lst_2";
    assert.equal((await listingRow(LA))?.shopId, a.shopId);
    assert.equal((await listingRow(LB))?.shopId, b.shopId);
    assert.equal((await listingRow(LA))?.shopName, a.name, "the listing is shown under company A's name, not B's");
    assert.equal((await listingRow(LB))?.shopName, b.name);
    for (const [who_, id] of [
      [a, LA],
      [b, LB],
    ] as const) {
      const mine = await db.listing.findMany({ where: { mine: true, shopId: who_.shopId, id: { in: [LA, LB] } }, select: { id: true } });
      assert.deepEqual(
        mine.map((x) => x.id),
        [id],
        "each company's own list holds its own listing only",
      );
    }
    // The part's "Offer this part": a second listing for A; B can't offer A's part
    const offered = await as(a.user, () => market.offerPart(partA.id, form({ market: "on", title: "Bobbin case again", partNumber: "BC-700", price: "11.00", qty: "1", shipping: "3.00" })));
    assert.equal(offered.error, undefined);
    assert.deepEqual({ shop: last().shop, ref: last().body.listing.shopRef, name: last().body.listing.shopName }, { shop: a.shopId, ref: a.shopId, name: a.name });
    const LA2 = "lst_3";
    assert.equal((await listingRow(LA2))?.shopId, a.shopId);
    await mustFail("B offers A's part", b.user, () => market.offerPart(partA.id, form({ market: "on", title: "x", price: "1.00", qty: "1" })), /Part not found/);
    await mustFail("no title", a.user, () => market.createListing(form({ price: "1.00", qty: "1" })), /title/);
    await mustFail("1.5 of them", a.user, () => market.createListing(form({ title: "t", price: "1.00", qty: "1.5" })), /whole number/);
    ok("two companies list under their own names: the hub row and the copy here are each company's, each list holds its own; a part's offer is its company's");

    // ---------- 2. two companies buy under their own names ----------
    const X = mock.addOutsideListing({ title: "Outside bobbin case", qty: 10, partNumber: "BC-700" });
    const buyA = await as(a.user, () => market.placeOrder(X.id, form({ qty: "2", clientId: "form-a1" })));
    assert.match(buyA.redirect ?? "", /^\/market\/orders\/ord_1$/);
    const oA = "ord_1";
    orderIds.push(oA);
    assert.deepEqual({ shop: last().shop, ref: last().body.shopRef, name: last().body.shopName }, { shop: a.shopId, ref: a.shopId, name: a.name });
    assert.equal(hubOrder(oA).buyerShop, a.name, "the hub's order names company A as the buyer");
    assert.equal(hubOrder(oA).shipTo, "1 Alpha Street", "shipped to the company's own address by default");
    assert.equal((hubOrder(oA).buyerContact as J).name, `${a.user.name}, ${a.name}`);
    assert.deepEqual({ shopId: (await orderRow(oA))?.shopId, role: (await orderRow(oA))?.role }, { shopId: a.shopId, role: "buyer" });
    // B has no address on file: it must say where to ship
    await mustFail("no address", b.user, () => market.placeOrder(X.id, form({ qty: "1", clientId: "form-b1" })), /address to ship to/);
    const buyB = await as(b.user, () => market.placeOrder(X.id, form({ qty: "1", shipTo: "2 Beta Road", clientId: "form-b1" })));
    const oB = "ord_2";
    orderIds.push(oB);
    assert.equal(buyB.redirect, `/market/orders/${oB}`);
    assert.deepEqual({ shop: last().shop, buyer: hubOrder(oB).buyerShop, ship: hubOrder(oB).shipTo }, { shop: b.shopId, buyer: b.name, ship: "2 Beta Road" });
    assert.equal((await orderRow(oB))?.shopId, b.shopId);
    // A retried form is the same order
    const again = await as(a.user, () => market.placeOrder(X.id, form({ qty: "2", clientId: "form-a1" })));
    assert.equal(again.redirect, `/market/orders/${oA}`);
    assert.equal(mock.orders.size, 2);
    assert.equal(await db.marketOrder.count({ where: { id: { in: [oA, oB] } } }), 2);
    // The hub's refusals in words
    await mustFail("2 on your own install", a.user, () => market.placeOrder(LB, form({ qty: "1", clientId: "form-a2" })), /another company's on your own StitchBench/);
    await mustFail("own listing", a.user, () => market.placeOrder(LA, form({ qty: "1", clientId: "form-a3" })), /can't order your own listing/);
    await mustFail("too many", a.user, () => market.placeOrder(X.id, form({ qty: "99", clientId: "form-a4" })), /Only 10 left/);
    await mustFail("1.5", a.user, () => market.placeOrder(X.id, form({ qty: "1.5" })), /whole number/);
    assert.equal(mock.orders.size, 2, "none of the refused orders was made");
    ok("two companies buy under their own names: buyer, contact and address, each order is its company's; a retried form is one order; own-install and quantity refusals in words");

    // ---------- 3. the buyer's side: paid, received into stock, rated, cancelled ----------
    await mustFail("received too early", a.user, () => market.orderAction(oA, "received", form({})), /requested, so that can't be done now/);
    await mustFail("buyer-paid before accepting", a.user, () => market.orderAction(oA, "buyer-paid", form({})), /requested, so that can't be done now/);
    await mustFail("rate before payment (B's order)", b.user, () => market.orderAction(oB, "rate", form({ stars: "5" })), /once the order is paid/);
    mock.outsideStep(oA, "accept");
    await mustWork("buyer-paid", a.user, () => market.orderAction(oA, "buyer-paid", form({})));
    assert.equal(last().shop, a.shopId);
    assert.equal(hubOrder(oA).buyerPaidNote, "Payment sent");
    mock.outsideStep(oA, "paid");
    await mustFail("stars 7", a.user, () => market.orderAction(oA, "rate", form({ stars: "7" })), /1 to 5 stars/);
    await mustWork("rate", a.user, () => market.orderAction(oA, "rate", form({ stars: "5", comment: "Fast" })));
    assert.deepEqual({ shop: last().shop, ref: last().body.shopRef, stars: last().body.stars }, { shop: a.shopId, ref: a.shopId, stars: 5 });
    assert.equal(hubOrder(oA).ratings.buyer?.stars, 5);
    assert.equal(((await orderRow(oA))?.data as unknown as J).ratings.buyer.stars, 5, "the copy here has the rating");
    mock.outsideStep(oA, "ship");
    assert.equal(await partOf(b.shopId, "BC-700 (own)"), null);
    await mustWork("received into stock", a.user, () => market.orderAction(oA, "received", form({ addToStock: "on" })));
    assert.equal((await orderRow(oA))?.status, "RECEIVED");
    // A already has BC-700 in stock (5) in the same condition: the 2 go onto it; B's stock is untouched
    assert.equal((await partOf(a.shopId, "BC-700"))?.qtyOnHand, 7, "A's stock took the 2");
    assert.equal((await partOf(b.shopId, "BC-700"))?.qtyOnHand, 7, "B's stock of the same number is untouched");
    const note = orderStockNote({ number: hubOrder(oA).number, role: "buyer", sellerShop: "Outside Sewing", buyerShop: a.name });
    assert.equal(await db.stockMove.count({ where: { shopId: a.shopId, note } }), 1);
    assert.equal(await db.stockMove.count({ where: { shopId: b.shopId, note } }), 0);
    await mustFail("stock twice", a.user, () => market.orderStock(oA), /already in your parts stock/);
    // Cancel: before the seller accepted (no units move), then after (they go back on the listing)
    await mustWork("B cancels while requested", b.user, () => market.orderAction(oB, "cancel", form({ reason: "Changed my mind" })));
    assert.equal(hubOrder(oB).status, "CANCELLED");
    assert.equal(hubOrder(oB).cancelReason, "Changed my mind");
    assert.equal(mock.listings.get(X.id)!.qty, 8, "a cancelled request never took units off the listing");
    const buyB2 = await as(b.user, () => market.placeOrder(X.id, form({ qty: "3", shipTo: "2 Beta Road", clientId: "form-b2" })));
    const oB2 = (buyB2.redirect ?? "").split("/").pop()!;
    orderIds.push(oB2);
    mock.outsideStep(oB2, "accept");
    assert.equal(mock.listings.get(X.id)!.qty, 5);
    await mustWork("B cancels after accepting", b.user, () => market.orderAction(oB2, "cancel", form({})));
    assert.equal(mock.listings.get(X.id)!.qty, 8, "the 3 went back on the listing");
    await mustFail("cancel twice", b.user, () => market.orderAction(oB2, "cancel", form({})), /cancelled, so that can't be done now/);
    ok("the buyer's side: paid, rated 1 to 5, received into the buyer's stock only and never twice, cancel before and after the seller accepted");

    // ---------- 4. the seller's side ----------
    const sA1 = mock.incoming(LA, 2);
    const sA2 = mock.incoming(LA, 1);
    const sB1 = mock.incoming(LB, 1);
    orderIds.push(sA1.id, sA2.id, sB1.id);
    await syncHub();
    assert.deepEqual(
      [(await orderRow(sA1.id))?.shopId, (await orderRow(sA2.id))?.shopId, (await orderRow(sB1.id))?.shopId],
      [a.shopId, a.shopId, b.shopId],
      "an order lands with the company that listed the item",
    );
    assert.equal((await orderRow(sA1.id))?.role, "seller");
    // Decline: the listing keeps its units
    await mustWork("decline", a.user, () => market.orderAction(sA2.id, "decline", form({ reason: "Sold elsewhere" })));
    assert.equal(hubOrder(sA2.id).status, "DECLINED");
    assert.equal(mock.listings.get(LA)!.qty, 3);
    await mustFail("accept after decline", a.user, () => market.orderAction(sA2.id, "accept", form({ payInstructions: "x" })), /declined, so that can't be done now/);
    // A refused accept leaves the shop's payment instructions as they were (they are saved only once the hub takes the step).
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).payInstructions, null);
    await mustFail("buyer step by the seller", a.user, () => market.orderAction(sA1.id, "buyer-paid", form({})), /Only the buyer can do that/);
    // Accept: how to pay, the listing's units go down; the first instructions typed are kept for the company
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).payInstructions, null);
    await mustWork("accept", a.user, () => market.orderAction(sA1.id, "accept", form({ payInstructions: "PayPal alpha@example.test", shipping: "3.00" })));
    assert.deepEqual(
      { shop: accept().shop, ref: accept().body.shopRef, pay: accept().body.payInstructions, ship: accept().body.shippingCents },
      { shop: a.shopId, ref: a.shopId, pay: "PayPal alpha@example.test", ship: 300 },
    );
    assert.equal((accept().body.sellerContact as J).name, a.name, "the seller contact is the company's");
    assert.equal(mock.listings.get(LA)!.qty, 1);
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).payInstructions, "PayPal alpha@example.test");
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: b.shopId } })).payInstructions, null, "B's shop didn't get A's instructions");
    // Ship before payment: allowed by the hub from ACCEPTED; carrier and tracking are asked for; the stock comes off with it
    await mustFail("no carrier", a.user, () => market.orderAction(sA1.id, "ship", form({ tracking: "T1" })), /Pick the carrier/);
    await mustFail("no tracking", a.user, () => market.orderAction(sA1.id, "ship", form({ carrier: "USPS" })), /tracking number/);
    assert.equal(hubOrder(sA1.id).status, "ACCEPTED");
    await mustWork("ship before payment, from stock", a.user, () => market.orderAction(sA1.id, "ship", form({ carrier: "USPS", tracking: "9400111", takeFromStock: "on" })));
    assert.deepEqual({ status: hubOrder(sA1.id).status, paid: hubOrder(sA1.id).paidAt }, { status: "SHIPPED", paid: null });
    assert.equal((await orderRow(sA1.id))?.status, "SHIPPED");
    assert.equal((await partOf(a.shopId, "BC-700"))?.qtyOnHand, 5, "A's 7 became 5");
    assert.equal((await partOf(b.shopId, "BC-700"))?.qtyOnHand, 7, "B's stock of the same number was not sold from");
    const soldNote = orderStockNote({ number: sA1.number, role: "seller", sellerShop: a.name, buyerShop: "Outside Buyer" });
    const move = await db.stockMove.findMany({ where: { note: soldNote } });
    assert.deepEqual(
      move.map((m) => [m.shopId, m.qty, m.reason]),
      [[a.shopId, -2, "ADJUSTED"]],
    );
    await mustFail("stock twice", a.user, () => market.orderStock(sA1.id), /already in your parts stock/);
    // An accepted order cancelled puts the units back; a shipped one can't be cancelled
    await mustFail("cancel a shipped order", a.user, () => market.orderAction(sA1.id, "cancel", form({})), /shipped, so that can't be done now/);
    await mustFail("B's order, no instructions yet (owner)", b.user, () => market.orderAction(sB1.id, "accept", form({})), /Say how the buyer should pay you/);
    await mustWork("B accepts with its own instructions", b.user, () => market.orderAction(sB1.id, "accept", form({ payInstructions: "Zelle beta@example.test" })));
    assert.equal(accept().shop, b.shopId);
    assert.equal(mock.listings.get(LB)!.qty, 1);
    await mustWork("B cancels after accepting", b.user, () => market.orderAction(sB1.id, "cancel", form({ reason: "Out of stock after all" })));
    assert.equal(mock.listings.get(LB)!.qty, 2, "the unit went back on B's listing");
    assert.equal(hubOrder(sB1.id).cancelReason, "Out of stock after all");
    // A message and a paid step on a seller order
    await mustWork("message", a.user, () => market.orderAction(sA1.id, "message", form({ text: "On its way" })));
    await mustFail("empty message", a.user, () => market.orderAction(sA1.id, "message", form({})), /Write a message first/);
    await mustFail("unknown step", a.user, () => market.orderAction(sA1.id, "refund" as never, form({})), /Unknown order step/);
    // A sold item with no part of that number in stock: the stock button says so
    const sA3 = mock.incoming(LA2, 1);
    orderIds.push(sA3.id);
    await syncHub();
    await mustWork("accept A3", a.user, () => market.orderAction(sA3.id, "accept", form({})));
    await mustWork("paid", a.user, () => market.orderAction(sA3.id, "paid", form({})));
    await db.part.update({ where: { id: partA.id }, data: { numberKeys: ["OTHER1"], partNumber: "OTHER-1" } });
    // The box ticked but no part here has the number: the step goes through (it is the hub's), nothing comes off any stock, and the stock button says why.
    await mustWork("ship, no part of that number", a.user, () => market.orderAction(sA3.id, "ship", form({ carrier: "UPS", tracking: "1Z", takeFromStock: "on" })));
    await mustFail("the stock button, no part", a.user, () => market.orderStock(sA3.id), /No part in your stock has the number BC-700/);
    assert.equal(hubOrder(sA3.id).status, "SHIPPED", "the hub has the step");
    assert.equal((await partOf(a.shopId, "OTHER-1"))?.qtyOnHand, 5);
    await db.part.update({ where: { id: partA.id }, data: { numberKeys: ["BC700"], partNumber: "BC-700" } });
    await mustWork("the stock button, again", a.user, () => market.orderStock(sA3.id));
    assert.equal((await partOf(a.shopId, "BC-700"))?.qtyOnHand, 4);
    ok("the seller's side: orders reach the company that listed the item; decline, accept, ship before payment, take from stock (own part only, never twice), cancel restocks");

    // ---------- 5. pausing and editing a listing ----------
    await mustFail("bad price", a.user, () => market.updateListing(LA, form({ price: "abc" })), /dollars and cents/);
    await mustFail("zero price", a.user, () => market.updateListing(LA, form({ price: "0" })), /Enter the price in dollars/);
    await mustFail("negative qty", a.user, () => market.updateListing(LA, form({ qty: "-1", qtyWas: "1" })), /whole number, 0 or more/);
    await mustFail("bad shipping", a.user, () => market.updateListing(LA, form({ shipping: "x" })), /Shipping/);
    await mustWork("pause and reprice", a.user, () => market.updateListing(LA, form({ price: "14.00", status: "PAUSED", title: "Bobbin case (paused)" })));
    assert.deepEqual({ shop: last().shop, priceCents: last().body.priceCents, status: last().body.status }, { shop: a.shopId, priceCents: 1400, status: "PAUSED" });
    let row = await listingRow(LA);
    assert.deepEqual({ status: row?.status, price: row?.priceCents, title: row?.title, shopId: row?.shopId }, { status: "PAUSED", price: 1400, title: "Bobbin case (paused)", shopId: a.shopId });
    // Another company's order can't be placed on a paused listing (the outside listing stands in: paused on the hub)
    mock.listings.get(X.id)!.status = "PAUSED";
    await mustFail("order a paused listing", b.user, () => market.placeOrder(X.id, form({ qty: "1", shipTo: "2 Beta Road", clientId: "form-b3" })), /paused right now/);
    mock.listings.get(X.id)!.status = "ACTIVE";
    // A quantity typed over a number that changed since the page opened is the hub's to refuse (orders accepted in between)
    await mustFail("stale quantity", a.user, () => market.updateListing(LA, form({ qty: "9", qtyWas: "3" })), /Orders changed how many are left on this listing \(now 1\)/);
    assert.equal(mock.listings.get(LA)!.qty, 1);
    await mustWork("quantity with the number the page showed", a.user, () => market.updateListing(LA, form({ qty: "6", qtyWas: "1" })));
    assert.deepEqual({ qty: last().body.qty, expected: last().body.expectedQty }, { qty: 6, expected: 1 });
    assert.equal((await listingRow(LA))?.qty, 6);
    await mustWork("quantity unchanged is not sent", a.user, () => market.updateListing(LA, form({ qty: "6", qtyWas: "6", status: "ACTIVE" })));
    assert.equal("qty" in last().body, false);
    assert.equal((await listingRow(LA))?.status, "ACTIVE");
    await mustWork("sold out by hand", a.user, () => market.updateListing(LA, form({ qty: "0", qtyWas: "6" })));
    row = await listingRow(LA);
    assert.deepEqual({ qty: row?.qty, status: row?.status }, { qty: 0, status: "SOLD_OUT" });
    await mustWork("more in stock: active again", a.user, () => market.updateListing(LA, form({ qty: "4", qtyWas: "0" })));
    assert.equal((await listingRow(LA))?.status, "ACTIVE");
    assert.equal((await listingRow(LB))?.status, "ACTIVE", "B's listing was never touched");
    assert.equal((await listingRow(LB))?.priceCents, 1300);
    ok("a listing paused, repriced and edited: bad input refused before the hub, a stale quantity refused by the hub in words, sold out and active again, B's untouched");

    // ---------- 6. removing a listing with orders open ----------
    const listA3 = await as(a.user, () => market.createListing(form({ title: "Needle pack", price: "5.00", qty: "4", shipping: "2.00" })));
    const L3 = (listA3.redirect ?? "").split("/").pop()!;
    const open1 = mock.incoming(L3, 1);
    const open2 = mock.incoming(L3, 1);
    orderIds.push(open1.id, open2.id);
    await syncHub();
    await mustWork("accept one first", a.user, () => market.orderAction(open1.id, "accept", form({})));
    await mustFail("B removes A's listing", b.user, () => market.removeListing(L3), /isn't one of yours/);
    assert.equal(mock.listings.get(L3)!.status, "ACTIVE");
    const gone = await as(a.user, () => market.removeListing(L3));
    assert.equal(gone.redirect, "/market/mine");
    assert.deepEqual({ method: last().method, path: last().path, shop: last().shop }, { method: "DELETE", path: `/v1/listings/${L3}`, shop: a.shopId });
    assert.equal(await listingRow(L3), null, "the copy here is gone");
    assert.equal(mock.listings.get(L3)!.status, "REMOVED");
    // The orders already made stay A's and carry on: the accepted one ships, the waiting one can be declined but not accepted
    assert.equal((await orderRow(open1.id))?.shopId, a.shopId);
    await mustWork("ship the accepted order after removal", a.user, () => market.orderAction(open1.id, "ship", form({ carrier: "USPS", tracking: "T-open1" })));
    await mustFail("accept on a removed listing", a.user, () => market.orderAction(open2.id, "accept", form({})), /That listing was removed/);
    await mustWork("decline it", a.user, () => market.orderAction(open2.id, "decline", form({ reason: "No longer sold" })));
    // An order that reaches the install after the listing was removed here: the hub names the company
    const late = mock.incoming(L3, 1);
    orderIds.push(late.id);
    await syncHub();
    assert.equal((await orderRow(late.id))?.shopId, a.shopId, "a late order reaches the company that had listed it");
    await mustWork("A answers it", a.user, () => market.orderAction(late.id, "decline", form({})));
    // From a hub that doesn't name the company, with the listing gone and two companies here, it belongs to nobody
    const nameless = mock.incoming(L3, 1, { withRef: false });
    orderIds.push(nameless.id);
    await syncHub();
    assert.equal((await orderRow(nameless.id))?.shopId, null, "no company is named and the listing is gone: it is nobody's");
    await mustFail("A can't act on it", a.user, () => market.orderAction(nameless.id, "decline", form({})), /isn't one of yours/);
    await mustFail("B can't act on it", b.user, () => market.orderAction(nameless.id, "decline", form({})), /isn't one of yours/);
    ok("a listing removed with orders open: the orders stay the company's and carry on; a late order reaches its company; one naming no company reaches nobody");

    // ---------- 7. a tech ----------
    await db.shop.update({ where: { id: b.shopId }, data: { payInstructions: null } });
    const t1 = mock.incoming(LB, 1);
    const t2 = mock.incoming(LA, 1);
    orderIds.push(t1.id, t2.id);
    await syncHub();
    await mustFail(
      "tech accepts, shop has said nothing",
      tB,
      () => market.orderAction(t1.id, "accept", form({ payInstructions: "pay me at evil@example.test" })),
      /Ask the owner to add payment instructions/,
    );
    assert.equal(hubOrder(t1.id).status, "REQUESTED");
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: b.shopId } })).payInstructions, null, "the tech's typed instructions were not saved");
    await mustFail("tech sets the instructions", tB, () => settings.saveShop(form({ payInstructions: "pay me at evil@example.test" })), /Only the shop owner or an admin/);
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: b.shopId } })).payInstructions, null);
    await mustWork("owner sets them", b.user, () => settings.saveShop(form({ name: b.name, payInstructions: "Zelle beta@example.test" })));
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: b.shopId } })).payInstructions, "Zelle beta@example.test");
    await mustWork("tech accepts", tB, () => market.orderAction(t1.id, "accept", form({ payInstructions: "pay me at evil@example.test" })));
    assert.equal(accept().body.payInstructions, "Zelle beta@example.test", "the shop's saved instructions went out, not the tech's typing");
    assert.equal((accept().body.sellerContact as J).name, b.name);
    await mustWork("tech accepts at A (saved at A)", tA, () => market.orderAction(t2.id, "accept", form({ payInstructions: "something else" })));
    assert.equal(accept().body.payInstructions, "PayPal alpha@example.test");
    assert.equal(accept().shop, a.shopId);
    await mustFail("tech of A on B's order", tA, () => market.orderAction(t1.id, "message", form({ text: "hi" })), /isn't one of yours/);
    ok("a tech: accepts only with the shop's saved instructions (typed ones are ignored), is refused without them, can't set them; the owner can");

    // ---------- 8. the hub's 403 in plain words ----------
    // A copy here that disagrees with the hub (the row says A, the hub says B) is what the hub's check is for.
    const other = `That listing belongs to another company on this ${appName()}.`;
    await db.listing.update({ where: { id: LB }, data: { shopId: a.shopId } });
    const before = calls();
    assert.deepEqual(await as(a.user, () => market.removeListing(LB)), { error: other });
    assert.deepEqual(await as(a.user, () => market.updateListing(LB, form({ price: "9.00" }))), { error: other });
    assert.equal(calls() - before, 2, "both reached the hub, which refused");
    assert.deepEqual({ method: mock.requests[before].method, shop: mock.requests[before].shop }, { method: "DELETE", shop: a.shopId });
    assert.equal(mock.listings.get(LB)!.status, "ACTIVE");
    assert.equal((await listingRow(LB))?.priceCents, 1300, "the refused edit changed nothing here");
    assert.ok(await listingRow(LB), "the refused removal kept the copy");
    await db.listing.update({ where: { id: LB }, data: { shopId: b.shopId } });
    await db.marketOrder.update({ where: { id: sB1.id }, data: { shopId: a.shopId } });
    assert.deepEqual(await as(a.user, () => market.orderAction(sB1.id, "message", form({ text: "hello" }))), { error: `That order belongs to another company on this ${appName()}.` });
    assert.deepEqual({ shop: last().shop, ref: last().body.shopRef }, { shop: a.shopId, ref: a.shopId });
    await db.marketOrder.update({ where: { id: sB1.id }, data: { shopId: b.shopId } });
    ok("the hub's 403 for another company's listing or order reaches the person as a plain message, and changes nothing here");

    // ---------- 9. tenant ----------
    const snapA = await snapshot(a.shopId, ["Part", "Listing", "MarketOrder", "StockMove"]);
    const snapHub = JSON.stringify([...mock.listings.values(), ...mock.orders.values()]);
    const reqs = calls();
    await mustFail("B updates A's listing", b.user, () => market.updateListing(LA, form({ price: "1.00", status: "PAUSED" })), /isn't one of yours/);
    await mustFail("B removes A's listing", b.user, () => market.removeListing(LA), /isn't one of yours/);
    await mustFail("B withdraws A's listing from A's part", b.user, () => market.withdrawOffer(partA.id, "market", LA), /Part not found/);
    await mustFail("B offers A's part", b.user, () => market.offerPart(partA.id, form({ market: "on", title: "x", price: "1.00", qty: "1" })), /Part not found/);
    for (const action of ["accept", "decline", "buyer-paid", "paid", "ship", "received", "cancel", "message", "rate"] as const) {
      await mustFail(
        `B: ${action} on A's sale`,
        b.user,
        () => market.orderAction(sA1.id, action, form({ carrier: "UPS", tracking: "1", stars: "5", text: "x", payInstructions: "x", takeFromStock: "on", addToStock: "on" })),
        /isn't one of yours/,
      );
      await mustFail(
        `B: ${action} on A's purchase`,
        b.user,
        () => market.orderAction(oA, action, form({ carrier: "UPS", tracking: "1", stars: "5", text: "x", addToStock: "on" })),
        /isn't one of yours/,
      );
    }
    await mustFail("B's stock button on A's order", b.user, () => market.orderStock(sA1.id), /isn't one of yours/);
    await mustFail("A acts on B's order", a.user, () => market.orderAction(sB1.id, "message", form({ text: "x" })), /isn't one of yours/);
    await mustFail("A updates B's listing", a.user, () => market.updateListing(LB, form({ price: "1.00" })), /isn't one of yours/);
    assert.equal(calls(), reqs, "none of the refused calls reached the hub");
    assert.equal(JSON.stringify([...mock.listings.values(), ...mock.orders.values()]), snapHub, "the hub is as it was");
    assertUnchanged("tenant", snapA, await snapshot(a.shopId, ["Part", "Listing", "MarketOrder", "StockMove"]));
    ok("tenant: B's calls with A's listings, orders and parts (every step) are refused, reach no hub endpoint and change nothing of A's");
  } finally {
    await db.marketOrder.deleteMany({ where: { id: { in: [...orderIds, ...mock.orders.keys()] } } }).catch(() => undefined);
    await db.listing.deleteMany({ where: { id: { in: [...mock.listings.keys()] } } }).catch(() => undefined);
    if (savedHub) {
      const { id: _id, ...data } = savedHub;
      void _id;
      await db.hubState.update({ where: { id: 1 }, data }).catch((e) => console.error("restoring HubState:", e));
    } else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => undefined);
    await cleanup();
    await mock.close();
  }
  console.log(`market-companies.check: ${steps} groups passed (mock hub ${mock.url})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
