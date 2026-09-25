import "server-only";
// This install's connection to StitchHub, the community server (see the stitchhub project).
// Sync pushes what this shop shared, then pulls every change since last time into the local copy
// (ManualLink, HubPost, HubPhoto, HubFigure). Pictures are fetched the first time someone looks at them.
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
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

async function reach(url: string, init: RequestInit) {
  try {
    return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  } catch {
    throw new UserError("Couldn't reach the community hub. Check the internet connection and try again.");
  }
}

async function failure(r: Response) {
  let msg = `The community hub answered ${r.status}.`;
  try {
    const j = (await r.json()) as { error?: string };
    if (j.error) msg = j.error;
  } catch {
    /* not JSON */
  }
  return new UserError(msg);
}

export async function hubFetch(path: string, init: RequestInit & { json?: unknown } = {}) {
  const s = await hubState();
  if (!s?.url || !s.installKey) throw new UserError("Join the community hub first (Settings → Community hub).");
  const { json, ...rest } = init;
  const r = await reach(s.url + path, {
    ...rest,
    headers: { Authorization: `Bearer ${s.installKey}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
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
  const base = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(base)) throw new UserError("The hub address starts with https://");
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
  const r = await reach(`${base}/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ joinKey: joinKey.trim(), name: shopName, contact }),
  });
  if (!r.ok) throw await failure(r);
  const j = (await r.json()) as { installId: string; installKey: string; hubName: string };
  const data = { url: base, hubName: j.hubName, installId: j.installId, installKey: j.installKey, joinedAt: new Date(), cursor: "0", lastError: null, scope: "member" };
  await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  return j;
}

export async function leaveHub() {
  // Partner shops talk through the hub too: leaving only stops the community part while partnerships are active.
  if (await db.partnerLink.count({ where: { status: "ACTIVE" } })) {
    throw new UserError("Your partner shops are connected through this hub. End those partnerships first (Partners), then leave.");
  }
  await db.hubState.updateMany({
    where: { id: 1 },
    data: { url: null, installId: null, installKey: null, cursor: null, discordUrl: null, scope: "member", partnerCursor: null },
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
    const meta = { kind: ph.kind, caption: ph.caption, mime: ph.mime, sortOrder: ph.sortOrder };
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
  await db.listing.upsert({ where: { id: l.id }, create: { id: l.id, ...row }, update: row });
}

export async function saveOrder(o: HubOrder) {
  const row = { number: o.number, role: o.role, status: o.status, data: o, updatedAt: new Date(o.updatedAt) };
  await db.marketOrder.upsert({ where: { id: o.id }, create: { id: o.id, ...row }, update: row });
}

async function pullOrders(cursor: string | null) {
  let since = cursor ?? "0";
  for (let page = 0; page < 100; page++) {
    const r = (await (await hubFetch(`/v1/orders?since=${since}`)).json()) as { orders: HubOrder[]; next: string | number };
    for (const o of r.orders) await saveOrder(o);
    const next = String(r.next);
    if (next !== since) await db.hubState.update({ where: { id: 1 }, data: { orderCursor: next } });
    if (!r.orders.length || next === since) break;
    since = next;
  }
}

let lastUsagePush = 0;

/** The next sync reports usage even if it did within the hour (a person pressed "Sync now"). */
export function reportUsageNextSync() {
  lastUsagePush = 0;
}

/** Tell the hub how many of each part this shop used this month and last (counts only), for the community's most-used list. */
async function pushUsage() {
  if (Date.now() - lastUsagePush < 3600_000) return;
  const now = new Date();
  for (const back of [0, 1]) {
    const start = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - back + 1, 1);
    const rows = await db.$queryRaw<{ number: string; brand: string | null; qty: bigint; tickets: bigint }[]>`
      SELECT p."partNumber" AS number, p.brand, SUM(-sm.qty) AS qty, COUNT(DISTINCT sm."ticketId") AS tickets
      FROM "StockMove" sm JOIN "Part" p ON p.id = sm."partId"
      WHERE sm.reason IN ('USED', 'RETURNED') AND sm."createdAt" >= ${start} AND sm."createdAt" < ${end}
      GROUP BY p."partNumber", p.brand`;
    const items = rows
      .map((r) => ({ number: r.number, brand: r.brand ?? "", qty: Math.round(Number(r.qty)), tickets: Number(r.tickets) }))
      .filter((i) => i.qty > 0)
      .slice(0, 5000);
    const month = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
    await hubFetch("/v1/usage", { method: "POST", json: { month, items } });
  }
  lastUsagePush = Date.now();
}

/** Send notes this shop shared that the hub doesn't have yet. */
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
        photos: p.photos.map((ph) => ({ kind: ph.kind, caption: ph.caption })),
      }),
    );
    for (const ph of p.photos) fd.append("photo", new Blob([new Uint8Array(ph.data)], { type: ph.mime }), "photo.jpg");
    const { id } = (await (await hubFetch("/v1/posts", { method: "POST", body: fd })).json()) as { id: string };
    await db.sharedPost.update({ where: { id: p.id }, data: { hubId: id } });
  }
  return pending.length;
}

export type SyncResult = { pushed: number; links: number; posts: number; figures: number } | { skipped: true };

async function doSync(): Promise<SyncResult> {
  const s = await hubState();
  if (!s?.url || !s.installKey) return { skipped: true };
  try {
    // The hub's name and Discord link can change; keep them current.
    const me = (await (await hubFetch("/v1/me")).json()) as { hubName?: string; discordInvite?: string | null; scope?: string };
    // The hub's Discord link wins when it has one; otherwise keep the one that came with the invite.
    await db.hubState.update({
      where: { id: 1 },
      data: { hubName: me.hubName ?? null, scope: me.scope ?? "member", ...(me.discordInvite ? { discordUrl: me.discordInvite } : {}) },
    });
    // On the hub for partner shops only: nothing of the community's to sync.
    if (me.scope === "partner") {
      await db.hubState.update({ where: { id: 1 }, data: { lastSyncAt: new Date(), lastError: null } });
      return { skipped: true };
    }
    const pushed = await pushPending();
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
      await saveLinks(ch.links);
      for (const p of ch.posts) await savePost(p);
      await saveXParts(ch.xparts ?? []);
      for (const l of ch.listings ?? []) await saveListing(l);
      if (ch.figures.length) await db.hubFigure.createMany({ data: ch.figures.map((id) => ({ id })), skipDuplicates: true });
      n.links += ch.links.length;
      n.posts += ch.posts.length;
      n.figures += ch.figures.length;
      since = String(ch.next);
      await db.hubState.update({ where: { id: 1 }, data: { cursor: since } });
      if (!ch.more) break;
    }
    await pullOrders(s.orderCursor);
    // An older hub may not have usage yet; that mustn't stop the sync.
    await pushUsage().catch((e) => console.error("community hub usage:", e instanceof Error ? e.message : e));
    await db.hubState.update({ where: { id: 1 }, data: { lastSyncAt: new Date(), lastError: null } });
    return n;
  } catch (e) {
    await db.hubState.update({ where: { id: 1 }, data: { lastError: e instanceof Error ? e.message : String(e) } }).catch(() => {});
    throw e;
  }
}

let running: Promise<SyncResult> | null = null;

/** One sync at a time; a second caller waits for the one already running. */
export function syncHub(): Promise<SyncResult> {
  running ??= doSync().finally(() => {
    running = null;
  });
  return running;
}

/** A picture from the hub (note photo, figure snapshot or listing photo), kept locally after the first look. */
export async function hubPicture(kind: "photo" | "figure" | "listing", id: string): Promise<{ mime: string; data: Uint8Array } | null> {
  if (kind === "listing") {
    const have = await db.listingPhoto.findUnique({ where: { id } });
    if (have) return { mime: have.mime, data: have.data };
    const r = await hubFetch(`/v1/listing-photos/${id}`);
    const mime = r.headers.get("content-type") ?? "image/jpeg";
    const data = new Uint8Array(await r.arrayBuffer());
    await db.listingPhoto.upsert({ where: { id }, create: { id, mime, data }, update: {} });
    return { mime, data };
  }
  if (kind === "photo") {
    const p = await db.hubPhoto.findUnique({ where: { id }, select: { mime: true, data: true } });
    if (!p) return null;
    if (p.data) return { mime: p.mime, data: p.data };
    const r = await hubFetch(`/v1/photos/${id}`);
    const data = new Uint8Array(await r.arrayBuffer());
    await db.hubPhoto.update({ where: { id }, data: { data } });
    return { mime: p.mime, data };
  }
  const f = await db.hubFigure.findUnique({ where: { id } });
  if (!f) return null;
  if (f.data && f.mime) return { mime: f.mime, data: f.data };
  const r = await hubFetch(`/v1/figures/${id}`);
  const mime = r.headers.get("content-type") ?? "image/jpeg";
  const data = new Uint8Array(await r.arrayBuffer());
  await db.hubFigure.update({ where: { id }, data: { mime, data } });
  return { mime, data };
}

/** Offer a figure snapshot this install made to the hub (ignored when not joined). */
export async function shareFigure(id: string, mime: string, data: Uint8Array, width?: number, height?: number) {
  if (!(await hubJoined())) return;
  const bytes = new Uint8Array(data);
  await hubFetch(`/v1/figures/${id}?w=${width ?? ""}&h=${height ?? ""}`, { method: "PUT", body: new Blob([bytes], { type: mime }), headers: { "Content-Type": mime } });
  await db.hubFigure.upsert({ where: { id }, create: { id, mime, data: bytes }, update: {} });
}
