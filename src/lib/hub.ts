import "server-only";
// This install's connection to StitchHub, the community server (see the stitchhub project).
// Sync pushes what this shop shared, then pulls every change since last time into the local copy
// (ManualLink, HubPost, HubPhoto, HubFigure). Pictures are fetched the first time someone looks at them.
import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import type { Prisma } from "@/generated/prisma/client";
import type { NoteKind, PhotoKind } from "@/generated/prisma/enums";

export type HubLink = {
  id: string;
  category: string | null;
  brand: string;
  models: string;
  modelKeys: string[];
  docType: string | null;
  title: string;
  fileName: string | null;
  url: string;
  source: string | null;
  status: string;
  httpStatus: number | null;
  checkedAt: string | null;
  deleted: boolean;
  updatedAt: string;
};

type HubPostIn = {
  id: string;
  shopName: string;
  authorName: string | null;
  brand: string;
  model: string;
  modelKey: string;
  kind: NoteKind;
  title: string;
  body: string;
  deleted: boolean;
  mine: boolean;
  createdAt: string;
  photos: { id: string; kind: PhotoKind; caption: string | null; mime: string; sortOrder: number }[];
};

export type LinkRevision = {
  id: string;
  action: string;
  brand: string;
  models: string;
  docType: string | null;
  title: string;
  url: string;
  byName: string | null;
  byShop: string | null;
  note: string | null;
  createdAt: string;
};

export async function hubState() {
  return db.hubState.findUnique({ where: { id: 1 } });
}

export async function hubJoined() {
  const s = await hubState();
  return Boolean(s?.url && s.installKey);
}

/** An id from the hub or a page, safe to put in a hub path (no "/", "..", "?" or "#" can steer the request). */
export function hubId(id: unknown): string {
  const s = String(id ?? "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(s)) throw new UserError("That isn't a valid id.");
  return s;
}

/** Picture types the app will store and serve from the hub; anything else is treated as a JPEG. */
export function safeImageType(mime: string | null | undefined): string {
  const m = String(mime ?? "").split(";")[0].trim().toLowerCase();
  return m === "image/png" || m === "image/webp" || m === "image/jpeg" ? m : "image/jpeg";
}

/** A hub address: https, or http only for this computer (a test hub). */
export function checkHubUrl(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UserError("The hub address starts with https://");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new UserError("The hub address starts with https://");
  if (u.username || u.password || u.search || u.hash) throw new UserError("That hub address doesn't look right.");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

// ---------- when the internet is down ----------
// Everything on this install works from its own database; only hub features (sharing, the marketplace, sending partner
// messages) wait for the connection. Once the hub stops answering, a person waiting on a page or a button gets an
// answer within seconds (one quick check, reused for 15 seconds) instead of sitting through a timeout. The background
// sync always tries in full: it is what notices the connection is back. Kept on globalThis so the pages, the actions
// and the background timers (which Next may load as separate copies of this module) share one state.
const net = ((globalThis as unknown as { __hubNet?: HubNet }).__hubNet ??= {
  offlineSince: null,
  checkedAt: 0,
  lastOk: 0,
  background: new AsyncLocalStorage<true>(),
});
type HubNet = { offlineSince: number | null; checkedAt: number; lastOk: number; background: AsyncLocalStorage<true> };

export const OFFLINE =
  "No connection to the community hub right now (the internet may be down). Everything else keeps working here; try this again when the connection is back.";

/** When the hub stopped answering (null while it answers). */
export function hubOfflineSince() {
  return net.offlineSince;
}

/** Sync work: always tries the hub in full, whatever happened last time. */
export function inBackground<T>(fn: () => Promise<T>) {
  return net.background.run(true, fn);
}

function wentOffline(why: string) {
  if (!net.offlineSince) console.log(`community hub: out of reach (${why}); local work carries on`);
  net.offlineSince ??= Date.now();
  net.checkedAt = Date.now();
}

function heardFromHub() {
  if (net.offlineSince) console.log("community hub: reachable again");
  net.offlineSince = null;
  net.lastOk = Date.now();
}

/** quick: someone is waiting on a page for this (a picture, ratings): give up sooner. */
async function reach(url: string, init: RequestInit & { quick?: boolean }, base: string) {
  const { quick, ...rest } = init;
  if (!net.background.getStore()) {
    // Someone is waiting on this. Known to be down: one short check, shared for 15 seconds, before anyone waits on a
    // full request. Not heard from lately: the same short check first, so a line that just went dead costs 4 seconds
    // here, not the 30 a full request would wait.
    if (net.offlineSince && Date.now() - net.checkedAt < 15_000) throw new UserError(OFFLINE);
    if (net.offlineSince || Date.now() - net.lastOk > 90_000) {
      net.checkedAt = Date.now();
      const up = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (!up) {
        wentOffline("no answer to a quick check");
        throw new UserError(OFFLINE);
      }
      heardFromHub();
    }
  }
  try {
    const r = await fetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(quick ? 8000 : 30_000) });
    heardFromHub();
    return r;
  } catch (e) {
    wentOffline(e instanceof Error ? e.name : "error");
    throw new UserError(OFFLINE);
  }
}

/** The hub said no; status tells a refusal for good (most 4xx) from a busy or broken moment (429, 5xx). */
export class HubError extends UserError {
  readonly hubError = true;
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "HubError";
  }
}

/** The status the hub answered with, from any copy of the code; 0 when the hub wasn't reached at all. */
export function hubStatus(e: unknown): number {
  if (e instanceof HubError) return e.status;
  const x = e as { hubError?: unknown; status?: unknown } | null;
  return typeof x === "object" && x !== null && x.hubError === true && typeof x.status === "number" ? x.status : 0;
}

async function failure(r: Response) {
  let msg = `The community hub answered ${r.status}.`;
  try {
    const j = (await r.json()) as { error?: string };
    if (j.error) msg = j.error;
  } catch {
    /* not JSON */
  }
  return new HubError(msg, r.status);
}

/** quick: a page is waiting on this (a picture, ratings); it gives up sooner when the hub is slow or down. */
export async function hubFetch(path: string, init: RequestInit & { json?: unknown; quick?: boolean } = {}) {
  const s = await hubState();
  if (!s?.url || !s.installKey) throw new UserError("Join the community hub first (Settings → Community hub).");
  // Only API paths, and nothing in them that could climb out of the path (ids are checked by hubId too).
  const route = path.split("?")[0];
  if (!route.startsWith("/v1/") || /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|#/i.test(route) || path.includes("#")) {
    throw new UserError("That hub request isn't allowed.");
  }
  const { json, ...rest } = init;
  const r = await reach(
    s.url + path,
    {
      ...rest,
      headers: { Authorization: `Bearer ${s.installKey}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    },
    s.url,
  );
  if (!r.ok) throw await failure(r);
  return r;
}

export type Invite = { url: string; joinKey: string; name?: string | null; discord?: string | null };

/** A member invite from the hub admin: the "stitchhub:..." code, or the .stitchhub file's contents. */
export function parseInvite(text: string): Invite {
  const t = text.trim();
  let json = t;
  if (t.startsWith("stitchhub:")) {
    try {
      json = Buffer.from(t.slice("stitchhub:".length).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
      throw new UserError("That invite code is damaged. Copy it again from the hub's invite.");
    }
  }
  let inv: Partial<Invite>;
  try {
    inv = JSON.parse(json) as Partial<Invite>;
  } catch {
    throw new UserError("That isn't a StitchHub invite. Paste the whole code (it starts with stitchhub:) or open the .stitchhub file.");
  }
  if (!inv.url || !inv.joinKey) throw new UserError("That invite is missing the hub address or join key.");
  const discord = inv.discord && /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(inv.discord) ? inv.discord : null;
  return { url: inv.url, joinKey: inv.joinKey, name: inv.name ?? null, discord };
}

export async function joinHub(url: string, joinKey: string, shopName: string, contact?: string | null) {
  const base = checkHubUrl(url.trim());
  // Already on this hub for partner shops only: the join key makes the same install a full member (partner links stay).
  const cur = await hubState();
  if (cur?.url === base && cur.installKey && cur.scope === "partner") {
    const r = (await (await hubFetch("/v1/upgrade", { method: "POST", json: { joinKey: joinKey.trim() } })).json()) as { installId: string; hubName: string };
    await db.hubState.update({ where: { id: 1 }, data: { scope: "member", hubName: r.hubName, cursor: "0", lastError: null } });
    return { installId: r.installId, installKey: cur.installKey, hubName: r.hubName };
  }
  if (cur?.installKey && (await db.partnerLink.count({ where: { status: "ACTIVE" } }))) {
    throw new UserError("This install's partner shops are connected through its current hub. End those partnerships before moving to another hub.");
  }
  const r = await reach(
    `${base}/v1/register`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ joinKey: joinKey.trim(), name: shopName, contact }) },
    base,
  );
  if (!r.ok) throw await failure(r);
  const j = (await r.json()) as { installId: string; installKey: string; hubName: string };
  // A different hub numbers its changes, orders and partner messages its own way: start every cursor over.
  const data = {
    url: base,
    hubName: j.hubName,
    installId: j.installId,
    installKey: j.installKey,
    joinedAt: new Date(),
    cursor: "0",
    orderCursor: null,
    partnerCursor: null,
    lastError: null,
    scope: "member",
  };
  await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  // The notes this shop shared went to the old connection; another hub (or this one rebuilt) doesn't have them, so
  // the first sync sends them again. The hub tells copies apart per install, so a hub that kept the old install's
  // posts (one moved whole to a new address) would hold them twice; a re-join like that is rare.
  await db.sharedPost.updateMany({ where: { hubId: { not: null } }, data: { hubId: null } });
  return j;
}

export async function leaveHub() {
  // Partner shops talk through the hub too: leaving only stops the community part while partnerships are active.
  if (await db.partnerLink.count({ where: { status: "ACTIVE" } })) {
    throw new UserError("Your partner shops are connected through this hub. End those partnerships first (Partners), then leave.");
  }
  await db.hubState.updateMany({
    where: { id: 1 },
    data: { url: null, installId: null, installKey: null, cursor: null, orderCursor: null, discordUrl: null, scope: "member", partnerCursor: null },
  });
}

function linkRow(l: HubLink) {
  return {
    category: l.category,
    brand: l.brand,
    models: l.models,
    modelKeys: l.modelKeys,
    docType: l.docType,
    title: l.title,
    fileName: l.fileName,
    url: l.url,
    source: l.source,
    status: l.status,
    httpStatus: l.httpStatus,
    checkedAt: l.checkedAt ? new Date(l.checkedAt) : null,
    updatedAt: new Date(l.updatedAt),
  };
}

/** Keep the local copy in step with a link the hub just returned. */
export async function saveLink(l: HubLink) {
  if (l.deleted) {
    await db.manualLink.deleteMany({ where: { id: l.id } });
    return;
  }
  await db.manualLink.upsert({ where: { id: l.id }, create: { id: l.id, ...linkRow(l) }, update: linkRow(l) });
}

async function savePost(p: HubPostIn) {
  if (p.deleted) {
    await db.hubPost.deleteMany({ where: { id: p.id } });
    return;
  }
  const row = {
    shopName: p.shopName,
    authorName: p.authorName,
    brand: p.brand,
    model: p.model,
    modelKey: p.modelKey,
    kind: p.kind,
    title: p.title,
    body: p.body,
    mine: p.mine,
    createdAt: new Date(p.createdAt),
  };
  await db.hubPost.upsert({ where: { id: p.id }, create: { id: p.id, ...row }, update: row });
  await db.hubPhoto.deleteMany({ where: { postId: p.id, id: { notIn: p.photos.map((ph) => ph.id) } } });
  for (const ph of p.photos) {
    const meta = { kind: ph.kind, caption: ph.caption, mime: safeImageType(ph.mime), sortOrder: ph.sortOrder };
    await db.hubPhoto.upsert({ where: { id: ph.id }, create: { id: ph.id, postId: p.id, ...meta }, update: meta });
  }
}

// ---------- parts cross-reference and marketplace (see the stitchhub docs/parts-and-marketplace.md) ----------

export type HubXPart = {
  id: string;
  name: string;
  kind: string;
  category: string | null;
  specs: string | null;
  notes: string | null;
  deleted: boolean;
  updatedAt: string;
  numbers: { brand: string; number: string }[];
  fits: { brand: string; model: string; modelKey: string; evidence: string; source?: string | null }[];
  sources: { id?: string; vendor: string; url?: string | null; priceCents?: number | null; currency?: string; note?: string | null; byShop?: string | null; updatedAt?: string }[];
};

export type HubListing = {
  id: string;
  shopName: string;
  mine: boolean;
  title: string;
  description: string | null;
  kind: string;
  condition: string;
  brand: string | null;
  partNumber: string | null;
  xpartId: string | null;
  fits: string | null;
  priceCents: number;
  currency: string;
  qty: number;
  shippingCents: number | null;
  shippingNote: string | null;
  shipsFrom: string | null;
  status: string;
  photos: { id: string; sortOrder: number }[];
  createdAt: string;
  updatedAt: string;
  sellerId?: string;
  sellerRating?: Reputation;
};

export type Reputation = { avg: number | null; count: number };
export type Rating = { stars: number; comment: string | null; at: string } | null;

export type HubOrder = {
  id: string;
  number: string;
  role: "buyer" | "seller";
  listingId: string;
  item: { title: string; brand: string | null; partNumber: string | null; condition: string };
  sellerShop: string;
  buyerShop: string;
  qty: number;
  unitPriceCents: number;
  shippingCents: number | null;
  totalCents: number;
  currency: string;
  shipTo: string | null;
  buyerNote: string | null;
  buyerContact: { name?: string | null; email?: string | null; phone?: string | null } | null;
  sellerContact: { name?: string | null; address?: string | null; email?: string | null; phone?: string | null } | null;
  payInstructions: string | null;
  status: string;
  buyerPaidNote: string | null;
  paidAt: string | null;
  carrier: string | null;
  tracking: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  events: { at: string; by: "buyer" | "seller"; action: string; note: string | null }[];
  // buyer = the buyer's rating of the seller; seller = the seller's rating of the buyer
  ratings?: { buyer: Rating; seller: Rating };
  sellerReputation?: Reputation;
  buyerReputation?: Reputation;
};

const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * A page of changed links or parts in one statement each (a first sync brings thousands; one upsert per row took
 * minutes). Deleted ones are removed.
 */
async function saveLinks(ls: HubLink[]) {
  const gone = ls.filter((l) => l.deleted).map((l) => l.id);
  if (gone.length) await db.manualLink.deleteMany({ where: { id: { in: gone } } });
  const rows = ls.filter((l) => !l.deleted).map((l) => ({ id: l.id, ...linkRow(l) }));
  if (!rows.length) return;
  await db.$executeRaw`
    INSERT INTO "ManualLink" (id, category, brand, models, "modelKeys", "docType", title, "fileName", url, source, status, "httpStatus", "checkedAt", "updatedAt")
    SELECT id, category, brand, models, "modelKeys", "docType", title, "fileName", url, source, status, "httpStatus", "checkedAt", "updatedAt"
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(id text, category text, brand text, models text, "modelKeys" text[], "docType" text,
      title text, "fileName" text, url text, source text, status text, "httpStatus" int, "checkedAt" timestamp, "updatedAt" timestamp)
    ON CONFLICT (id) DO UPDATE SET category = EXCLUDED.category, brand = EXCLUDED.brand, models = EXCLUDED.models, "modelKeys" = EXCLUDED."modelKeys",
      "docType" = EXCLUDED."docType", title = EXCLUDED.title, "fileName" = EXCLUDED."fileName", url = EXCLUDED.url, source = EXCLUDED.source,
      status = EXCLUDED.status, "httpStatus" = EXCLUDED."httpStatus", "checkedAt" = EXCLUDED."checkedAt", "updatedAt" = EXCLUDED."updatedAt"`;
}

function xpartRow(x: HubXPart) {
  return {
    name: x.name,
    kind: x.kind,
    category: x.category,
    specs: x.specs,
    notes: x.notes,
    numbers: x.numbers,
    numberKeys: [...new Set(x.numbers.map((n) => key(n.number)).filter(Boolean))],
    fits: x.fits,
    fitKeys: [...new Set(x.fits.map((f) => f.modelKey || key(f.model)).filter(Boolean))],
    sources: x.sources,
    updatedAt: new Date(x.updatedAt),
  };
}

async function saveXParts(xs: HubXPart[]) {
  const gone = xs.filter((x) => x.deleted).map((x) => x.id);
  if (gone.length) await db.xPart.deleteMany({ where: { id: { in: gone } } });
  const rows = xs.filter((x) => !x.deleted).map((x) => ({ id: x.id, ...xpartRow(x) }));
  if (!rows.length) return;
  await db.$executeRaw`
    INSERT INTO "XPart" (id, name, kind, category, specs, notes, numbers, "numberKeys", fits, "fitKeys", sources, "updatedAt")
    SELECT id, name, COALESCE(kind, 'PART'), category, specs, notes, numbers, "numberKeys", fits, "fitKeys", sources, "updatedAt"
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(id text, name text, kind text, category text, specs text, notes text, numbers jsonb,
      "numberKeys" text[], fits jsonb, "fitKeys" text[], sources jsonb, "updatedAt" timestamp)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, category = EXCLUDED.category, specs = EXCLUDED.specs,
      notes = EXCLUDED.notes, numbers = EXCLUDED.numbers, "numberKeys" = EXCLUDED."numberKeys", fits = EXCLUDED.fits, "fitKeys" = EXCLUDED."fitKeys",
      sources = EXCLUDED.sources, "updatedAt" = EXCLUDED."updatedAt"`;
}

export async function saveXPart(x: HubXPart) {
  if (x.deleted) {
    await db.xPart.deleteMany({ where: { id: x.id } });
    return;
  }
  const row = xpartRow(x);
  await db.xPart.upsert({ where: { id: x.id }, create: { id: x.id, ...row }, update: row });
}

export async function saveListing(l: HubListing) {
  if (l.status === "REMOVED") {
    await db.listing.deleteMany({ where: { id: l.id } });
    return;
  }
  const row = {
    shopName: l.shopName,
    mine: l.mine,
    title: l.title,
    description: l.description,
    kind: l.kind,
    condition: l.condition,
    brand: l.brand,
    partNumber: l.partNumber,
    numberKey: l.partNumber ? key(l.partNumber) : null,
    xpartId: l.xpartId,
    fits: l.fits,
    priceCents: l.priceCents,
    currency: l.currency,
    qty: l.qty,
    shippingCents: l.shippingCents,
    shippingNote: l.shippingNote,
    shipsFrom: l.shipsFrom,
    status: l.status,
    photoIds: [...l.photos].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.id),
    createdAt: new Date(l.createdAt),
    updatedAt: new Date(l.updatedAt),
    sellerId: l.sellerId ?? null,
    sellerAvg: l.sellerRating?.avg ?? null,
    sellerCount: l.sellerRating?.count ?? 0,
  };
  // A listing of this install's that arrives from the hub (e.g. after a restore onto a new PC) belongs to the only
  // company when there is just one; with several, it stays unassigned (the company that made it set it on creation).
  const shopId = l.mine ? await soleShopId() : null;
  await db.listing.upsert({ where: { id: l.id }, create: { id: l.id, ...row, shopId }, update: row });
}

/** The company's id when the install has exactly one (a single-shop desktop install); otherwise null. */
async function soleShopId() {
  const shops = await db.shop.findMany({ select: { id: true }, take: 2 });
  return shops.length === 1 ? shops[0].id : null;
}

/**
 * Keep the local copy of an order. shopId says which company on this install it belongs to: given when this install
 * places it, and for a sale, taken from the company that listed the item. It is never changed once set.
 */
export async function saveOrder(o: HubOrder, shopId?: string) {
  const row = { number: o.number, role: o.role, status: o.status, data: o, updatedAt: new Date(o.updatedAt) };
  const have = await db.marketOrder.findUnique({ where: { id: o.id }, select: { shopId: true } });
  let owner = have?.shopId ?? shopId ?? null;
  if (!owner && o.role === "seller") owner = (await db.listing.findUnique({ where: { id: o.listingId }, select: { shopId: true } }))?.shopId ?? null;
  owner ??= await soleShopId();
  await db.marketOrder.upsert({ where: { id: o.id }, create: { id: o.id, ...row, shopId: owner }, update: { ...row, shopId: owner } });
}

/** false when the install moved to another hub (or left) while this run was on: the rest of the run is dropped. */
async function pullOrders(cursor: string | null, run: SyncRun) {
  let since = cursor ?? "0";
  for (let page = 0; page < 100; page++) {
    const r = (await (await hubFetch(`/v1/orders?since=${since}`)).json()) as { orders: HubOrder[]; next: string | number };
    if (!(await sameHub(run))) return false;
    for (const o of r.orders) await saveOrder(o);
    const next = String(r.next);
    if (next !== since && !(await writeState(run, { orderCursor: next }))) return false;
    if (!r.orders.length || next === since) break;
    since = next;
  }
  return true;
}

let lastUsagePush = 0;

/** The next sync reports usage even if it did within the hour (a person pressed "Sync now"). */
export function reportUsageNextSync() {
  lastUsagePush = 0;
}

/** Tell the hub how many of each part this shop used this month and last (counts only), for the community's most-used list. */
async function pushUsage() {
  if (Date.now() - lastUsagePush < 3600_000) return;
  // Once an hour whether or not the hub takes it: a report it refuses isn't tried again every ten minutes.
  lastUsagePush = Date.now();
  const now = new Date();
  for (const back of [0, 1]) {
    const start = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - back + 1, 1);
    const rows = await db.$queryRaw<{ number: string; brand: string | null; qty: bigint; tickets: bigint }[]>`
      SELECT p."partNumber" AS number, p.brand, SUM(-sm.qty) AS qty, COUNT(DISTINCT sm."ticketId") AS tickets
      FROM "StockMove" sm JOIN "Part" p ON p.id = sm."partId"
      WHERE sm.reason IN ('USED', 'RETURNED') AND sm."createdAt" >= ${start} AND sm."createdAt" < ${end}
      GROUP BY p."partNumber", p.brand`;
    // The hub counts by the letters and digits of a number; one with none ("-", a part named only in Chinese) would
    // make it refuse the whole month, so those stay out.
    const items = rows
      .map((r) => ({ number: r.number, brand: r.brand ?? "", qty: Math.round(Number(r.qty)), tickets: Number(r.tickets) }))
      .filter((i) => i.qty > 0 && key(i.number))
      .slice(0, 5000);
    const month = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
    await hubFetch("/v1/usage", { method: "POST", json: { month, items } });
  }
}

/**
 * Send notes this shop shared that the hub doesn't have yet. Each carries its own id, so a note the hub stored just as
 * the connection dropped isn't stored twice when it's sent again.
 */
async function pushPending() {
  const pending = await db.sharedPost.findMany({
    where: { hubId: null },
    include: { photos: { orderBy: { sortOrder: "asc" } }, author: { select: { name: true } } },
    take: 50,
  });
  for (const p of pending) {
    const fd = new FormData();
    fd.set(
      "post",
      JSON.stringify({
        brand: p.brand,
        model: p.model,
        kind: p.kind,
        title: p.title,
        body: p.body,
        authorName: p.author?.name ?? null,
        clientId: p.id,
        photos: p.photos.map((ph) => ({ kind: ph.kind, caption: ph.caption })),
      }),
    );
    for (const ph of p.photos) fd.append("photo", new Blob([new Uint8Array(ph.data)], { type: ph.mime }), "photo.jpg");
    // Photos take a while on a slow connection.
    const { id } = (await (await hubFetch("/v1/posts", { method: "POST", body: fd, signal: AbortSignal.timeout(180_000) })).json()) as { id: string };
    await db.sharedPost.update({ where: { id: p.id }, data: { hubId: id } });
  }
  return pending.length;
}

export type SyncResult = { pushed: number; links: number; posts: number; figures: number } | { skipped: true };

// A sync run belongs to the hub connection it started with. Joining another hub (or leaving) while it runs gives the
// install a new id and starts the cursors over; a page that was fetched for the old hub must not put its rows or its
// numbers into the new connection's copy. Every write checks the connection is still the run's (in the database, so
// it holds across the server processes a hosted install runs); when it isn't, the run stops and the new connection's
// own sync takes over.
export type SyncRun = { installId: string | null };

export async function sameHub(run: SyncRun) {
  return (await db.hubState.count({ where: { id: 1, installId: run.installId } })) > 0;
}

/** Writes to this run's connection only; false (nothing written) once the install is on another hub or none. */
export async function writeState(run: SyncRun, data: Prisma.HubStateUpdateManyMutationInput) {
  return (await db.hubState.updateMany({ where: { id: 1, installId: run.installId }, data })).count > 0;
}

async function doSync(): Promise<SyncResult> {
  const s = await hubState();
  if (!s?.url || !s.installKey) return { skipped: true };
  const run: SyncRun = { installId: s.installId };
  try {
    // The hub's name and Discord link can change; keep them current.
    const me = (await (await hubFetch("/v1/me")).json()) as { hubName?: string; discordInvite?: string | null; scope?: string };
    // The hub's Discord link wins when it has one; otherwise keep the one that came with the invite.
    const still = await writeState(run, { hubName: me.hubName ?? null, scope: me.scope ?? "member", ...(me.discordInvite ? { discordUrl: me.discordInvite } : {}) });
    if (!still) return { skipped: true };
    // On the hub for partner shops only: nothing of the community's to sync.
    if (me.scope === "partner") {
      await writeState(run, { lastSyncAt: new Date(), lastError: null });
      return { skipped: true };
    }
    // A note that won't upload mustn't stop everything else from syncing; it's tried again next time.
    const pushed = await pushPending().catch((e) => {
      console.error("community hub: sending shared notes:", e instanceof Error ? e.message : e);
      return 0;
    });
    const n = { pushed, links: 0, posts: 0, figures: 0 };
    let since = s.cursor ?? "0";
    for (let page = 0; page < 500; page++) {
      const ch = (await (await hubFetch(`/v1/changes?since=${since}&limit=1000`)).json()) as {
        links: HubLink[];
        posts: HubPostIn[];
        figures: string[];
        xparts?: HubXPart[];
        listings?: HubListing[];
        next: string;
        more: boolean;
      };
      if (!(await sameHub(run))) return { skipped: true };
      await saveLinks(ch.links);
      for (const p of ch.posts) await savePost(p);
      await saveXParts(ch.xparts ?? []);
      for (const l of ch.listings ?? []) await saveListing(l);
      if (ch.figures.length) await db.hubFigure.createMany({ data: ch.figures.map((id) => ({ id })), skipDuplicates: true });
      n.links += ch.links.length;
      n.posts += ch.posts.length;
      n.figures += ch.figures.length;
      since = String(ch.next);
      if (!(await writeState(run, { cursor: since }))) return { skipped: true };
      if (!ch.more) break;
    }
    if (!(await pullOrders(s.orderCursor, run))) return { skipped: true };
    // A refused usage report mustn't stop the sync, but it's shown with the sync status rather than lost; an older hub
    // without usage at all (404) isn't worth reporting every time.
    const usage = await pushUsage().then(
      () => null,
      (e: unknown) => (hubStatus(e) === 404 ? null : `Usage report: ${e instanceof Error ? e.message : String(e)}`),
    );
    if (usage) console.error("community hub usage:", usage);
    await writeState(run, { lastSyncAt: new Date(), lastError: usage });
    return n;
  } catch (e) {
    await writeState(run, { lastError: e instanceof Error ? e.message : String(e) }).catch(() => {});
    throw e;
  }
}

// One sync at a time, shared by every copy of this module Next loads; a second caller waits for the one running.
const shared = globalThis as unknown as { __hubSync?: Promise<SyncResult> | null };

export function syncHub(): Promise<SyncResult> {
  shared.__hubSync ??= inBackground(doSync).finally(() => {
    shared.__hubSync = null;
  });
  return shared.__hubSync;
}

/** A picture from the hub (note photo, figure snapshot or listing photo), kept locally after the first look. */
export async function hubPicture(kind: "photo" | "figure" | "listing", id: string): Promise<{ mime: string; data: Uint8Array } | null> {
  id = hubId(id);
  if (kind === "listing") {
    const have = await db.listingPhoto.findUnique({ where: { id } });
    if (have) return { mime: safeImageType(have.mime), data: have.data };
    const r = await hubFetch(`/v1/listing-photos/${id}`, { quick: true });
    const mime = safeImageType(r.headers.get("content-type"));
    const data = new Uint8Array(await r.arrayBuffer());
    await db.listingPhoto.upsert({ where: { id }, create: { id, mime, data }, update: {} });
    return { mime, data };
  }
  if (kind === "photo") {
    const p = await db.hubPhoto.findUnique({ where: { id }, select: { mime: true, data: true } });
    if (!p) return null;
    if (p.data) return { mime: safeImageType(p.mime), data: p.data };
    const r = await hubFetch(`/v1/photos/${id}`, { quick: true });
    const data = new Uint8Array(await r.arrayBuffer());
    await db.hubPhoto.update({ where: { id }, data: { data } });
    return { mime: safeImageType(p.mime), data };
  }
  const f = await db.hubFigure.findUnique({ where: { id } });
  if (!f) return null;
  if (f.data && f.mime) return { mime: safeImageType(f.mime), data: f.data };
  const r = await hubFetch(`/v1/figures/${id}`, { quick: true });
  const mime = safeImageType(r.headers.get("content-type"));
  const data = new Uint8Array(await r.arrayBuffer());
  await db.hubFigure.update({ where: { id }, data: { mime, data } });
  return { mime, data };
}

/** Offer a figure snapshot this install made to the hub (ignored when not joined). */
export async function shareFigure(id: string, mime: string, data: Uint8Array, width?: number, height?: number) {
  if (!(await hubJoined())) return;
  const bytes = new Uint8Array(data);
  await hubFetch(`/v1/figures/${hubId(id)}?w=${Math.round(width ?? 0) || ""}&h=${Math.round(height ?? 0) || ""}`, { method: "PUT", body: new Blob([bytes], { type: mime }), headers: { "Content-Type": mime } });
  await db.hubFigure.upsert({ where: { id }, create: { id, mime, data: bytes }, update: {} });
}
