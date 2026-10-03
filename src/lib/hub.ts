import "server-only";
// This install's connection to StitchHub, the community server (see the stitchhub project).
// Sync pushes what this shop shared, then pulls every change since last time into the local copy
// (ManualLink, HubPost, HubPhoto, HubFigure). Pictures are fetched the first time someone looks at them.
import { AsyncLocalStorage } from "node:async_hooks";
import { actingCompany, asCompany } from "@/lib/acting-company";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { applyMovedOut, applyStanding, movedAnswer, type StandingAnswer } from "@/lib/hub-standing";
import { MOVE_CANCEL_PENDING } from "@/lib/move/format";
import { baseNumber } from "@/lib/parts";
import { readUpTo } from "@/lib/read-body";
import { appName, programVersion, shopKindOf } from "@/lib/shops";
import { monthPeriod } from "@/lib/time-zone";
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
  // The company on the sharing install (hubs from before per-company identity don't send it), and its id in the hub's
  // shops table once it has claimed itself; shopName is then the company's current name
  shopRef?: string | null;
  shopId?: string | null;
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

/**
 * The community's hub, compiled in (hub-accounts-billing-design.md 2.2): where an install that never joined any hub
 * goes when its owner starts a StitchHub account, and where a partner code without an address points. A self-hosted
 * hub still needs its invite. DEFAULT_HUB_URL overrides it for a test hub on this computer.
 */
export function hubDefaultUrl() {
  return (process.env.DEFAULT_HUB_URL ?? "https://stitchhub-production.up.railway.app").replace(/\/+$/, "");
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

/**
 * The hub address this install has stored, under the same rule as when one is entered (checkHubUrl, and join-hub.mjs):
 * https, or http only for this computer. Every request carries the install key, so one stored another way (typed into
 * the database, an old install with a plain-http address) is refused rather than sent in the clear.
 */
function storedHubUrl(url: string) {
  try {
    return checkHubUrl(url);
  } catch {
    throw new UserError(`The stored hub address (${url}) isn't https. Join the hub again from Settings → Community hub.`);
  }
}

/**
 * Who is making a change on the hub (a link, a cross-reference entry): the person, and which company on this install
 * (a hosted install holds several), so the hub's history shows the company rather than the install. An older hub
 * ignores the two extra fields.
 */
export async function byWhom(user: { shopId: string; name: string }) {
  const shop = await db.shop.findUnique({ where: { id: user.shopId }, select: { name: true } });
  return { byName: user.name, shopRef: user.shopId, shopName: shop?.name ?? null };
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

/**
 * Sync work: always tries the hub in full, whatever happened last time, and speaks for the install, not for the company
 * whose action set it off (a sync started by one company's click pushes every company's notes and claims).
 */
export function inBackground<T>(fn: () => Promise<T>) {
  return net.background.run(true, () => asCompany(null, fn));
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

/**
 * Someone is waiting on the hub. Known to be down: one short check, shared for 15 seconds, before anyone waits on a
 * full request. Not heard from lately: the same short check first, so a line that just went dead costs 4 seconds
 * here, not the 30 a full request would wait.
 */
async function quickCheck(base: string) {
  if (net.offlineSince && Date.now() - net.checkedAt < 15_000) throw new UserError(OFFLINE);
  if (net.offlineSince || Date.now() - net.lastOk > 90_000) {
    net.checkedAt = Date.now();
    const up = await fetch(`${base}/health`, { redirect: "manual", signal: AbortSignal.timeout(4000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (!up) {
      wentOffline("no answer to a quick check");
      throw new UserError(OFFLINE);
    }
    heardFromHub();
  }
}

/** Before a sync a person asked for ("Sync now", "Check for updates"): says there's no connection in seconds. */
export async function hubReachable() {
  const s = await hubState();
  if (s?.url && s.installKey) await quickCheck(storedHubUrl(s.url));
}

/** quick: someone is waiting on a page for this (a picture, ratings): give up sooner. */
async function reach(url: string, init: RequestInit & { quick?: boolean }, base: string) {
  const { quick, ...rest } = init;
  if (!net.background.getStore()) await quickCheck(base);
  let r: Response;
  try {
    // Never follow a redirect: the hub has no reason to send one, and following it would let a hub (or whoever took
    // over its address) make this server fetch any address, the shop's own network or the cloud's included.
    r = await fetch(url, { ...rest, redirect: "manual", signal: rest.signal ?? AbortSignal.timeout(quick ? 8000 : 30_000) });
    heardFromHub();
  } catch (e) {
    wentOffline(e instanceof Error ? e.name : "error");
    throw new UserError(OFFLINE);
  }
  if (r.status >= 300 && r.status < 400) {
    await r.body?.cancel().catch(() => {});
    throw new HubError("The community hub answered with a move to another address, which this program doesn't follow. Check the hub address with the hub admin.", 502);
  }
  return r;
}

/** The hub said no; status tells a refusal for good (most 4xx) from a busy or broken moment (429, 5xx). */
export class HubError extends UserError {
  readonly hubError = true;
  constructor(
    message: string,
    public status: number,
    /** The hub's answer as it came (JSON), for the few refusals that carry more than words (410 moved: to, at). */
    public detail: Record<string, unknown> | null = null,
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
  let detail: Record<string, unknown> | null = null;
  try {
    const j = (await r.json()) as { error?: string };
    if (j && typeof j === "object" && !Array.isArray(j)) detail = j as Record<string, unknown>;
    if (j.error) msg = j.error;
  } catch {
    /* not JSON */
  }
  // The hub refused a change to a row of another company on this same install (it says so when the request named a
  // company, X-Shop-Ref): in the person's words, about this program.
  const other = r.status === 403 && /^That (\w[\w ]*?) belongs to another company/.exec(msg);
  if (other) msg = `That ${other[1]} belongs to another company on this ${appName()}.`;
  return new HubError(msg, r.status, detail);
}

/**
 * The company a hub call speaks for: the one given, else the one acting (the signed-in person's, set by safe() for the
 * whole action); none in background work. `shopRef: null` says "the install itself" on purpose.
 */
function companyHeader(shopRef: string | null | undefined): Record<string, string> {
  const ref = shopRef === undefined ? actingCompany() : shopRef;
  return ref ? { "X-Shop-Ref": ref } : {};
}

/**
 * A JSON request to a hub this install may not be on yet (starting a StitchHub account from a never-joined install),
 * under the same rules as hubFetch: the address checked, no redirects followed, the hub's refusal as a HubError.
 * `key`: an install key to send (the one this install had on that hub before it left), or none.
 */
export async function hubRequest<T>(base: string, path: string, o: { method?: string; json?: unknown; key?: string | null; shopRef?: string | null } = {}): Promise<T> {
  const url = checkHubUrl(base);
  if (!path.startsWith("/v1/") || /[#?\\]|(^|\/)\.\.?(\/|$)/.test(path)) throw new UserError("That hub request isn't allowed.");
  const r = await reach(
    url + path,
    {
      method: o.method ?? "POST",
      headers: { "Content-Type": "application/json", ...(o.key ? { Authorization: `Bearer ${o.key}` } : {}), ...companyHeader(o.shopRef) },
      body: o.json === undefined ? undefined : JSON.stringify(o.json),
    },
    url,
  );
  if (!r.ok) throw await failure(r);
  return (await r.json()) as T;
}

/**
 * quick: a page is waiting on this (a picture, ratings); it gives up sooner when the hub is slow or down.
 * shopRef: the company this call speaks for (X-Shop-Ref) when it isn't the acting one (companyHeader): a page, or a
 * library function called outside an action, names it.
 */
export async function hubFetch(path: string, init: RequestInit & { json?: unknown; quick?: boolean; shopRef?: string | null } = {}) {
  const s = await hubState();
  if (!s?.url || !s.installKey) throw new UserError("Join the community hub first (Settings → Community hub).");
  // The install key goes with every request: only to an address the join rules allow (https, or http on this computer).
  const base = storedHubUrl(s.url);
  // Only API paths, and nothing in them that could climb out of the path (ids are checked by hubId too).
  const route = path.split("?")[0];
  if (!route.startsWith("/v1/") || /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|#/i.test(route) || path.includes("#")) {
    throw new UserError("That hub request isn't allowed.");
  }
  const { json, shopRef, ...rest } = init;
  const r = await reach(
    base + path,
    {
      ...rest,
      headers: { Authorization: `Bearer ${s.installKey}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...companyHeader(shopRef), ...(rest.headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    },
    base,
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
  // Back on the hub this install left: while the hub still knows the install, it is the same install again (the join
  // key makes it a member again), so the listings, orders and notes it had there stay its own. A hub that has
  // forgotten it (rebuilt from an older export, or the admin removed it) gets a new registration as before.
  const oldKey = cur?.formerUrl === base ? cur.formerInstallKey : null;
  const former = oldKey ? await formerInstall(base, oldKey) : null;
  let j: { installId: string; installKey: string; hubName: string };
  if (former && oldKey) {
    const r = await reach(
      `${base}/v1/upgrade`,
      { method: "POST", headers: { Authorization: `Bearer ${oldKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ joinKey: joinKey.trim() }) },
      base,
    );
    if (!r.ok) throw await failure(r);
    const u = (await r.json()) as { installId?: string; hubName?: string };
    j = { installId: u.installId ?? former.installId, installKey: oldKey, hubName: u.hubName ?? former.hubName ?? "" };
  } else {
    const r = await reach(
      `${base}/v1/register`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ joinKey: joinKey.trim(), name: shopName, contact }) },
      base,
    );
    if (!r.ok) throw await failure(r);
    j = (await r.json()) as typeof j;
  }
  // A different hub numbers its changes, orders and partner messages its own way: start every cursor over. (The same
  // hub again starts over too: what was synced before went when the install left.)
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
    formerUrl: null,
    formerInstallId: null,
    formerInstallKey: null,
  };
  await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  // What the old connection synced goes: the first sync brings this hub's copy from the start. Kept, a listing of the
  // shop's own would come back as another shop's (a new install is someone else to the hub), and one the new hub
  // doesn't have would stay on show with nothing behind it.
  await clearHubCopies();
  // The notes this shop shared went to the old connection; another hub (or this one rebuilt) doesn't have them, so
  // the first sync sends them again. Each carries its own id, so the same install on the same hub is answered with
  // the note it already holds, not a second copy. A hub that kept the old install's posts under a new install (one
  // moved whole to a new address) would hold them twice; a re-join like that is rare.
  await db.sharedPost.updateMany({ where: { hubId: { not: null } }, data: { hubId: null } });
  return j;
}

/**
 * Whether the hub at `base` still knows the install this program left, under its old key: its id, name and scope
 * there, or null when it doesn't (401; or a hub too old to answer /v1/me with an id). A hub that refuses the install
 * (the admin blocked it) says so: leaving and joining again doesn't slip past a block with a fresh install.
 */
export async function formerInstall(base: string, installKey: string) {
  const r = await reach(`${base}/v1/me`, { headers: { Authorization: `Bearer ${installKey}` } }, base);
  if (r.status === 401 || r.status === 404) {
    await r.body?.cancel().catch(() => {});
    return null;
  }
  if (!r.ok) throw await failure(r);
  const me = (await r.json().catch(() => ({}))) as { installId?: string; hubName?: string; scope?: string };
  return me.installId ? { installId: me.installId, hubName: me.hubName ?? null, scope: hubScope(me.scope) } : null;
}

/** The hub's word for an install's scope, as this program stores it: member, partner (partner channel only) or pending (an account not yet verified). */
export function hubScope(s: unknown): "member" | "partner" | "pending" {
  return s === "partner" || s === "pending" ? s : "member";
}

/**
 * This install is now the one the hub answered with (an account started from a never-joined install, section 2.2 of
 * hub-accounts-billing-design.md; or the install it had there before it left, taken back). Same bookkeeping as
 * joinHub: every cursor starts over and the old connection's synced copies go. Refuses to replace a connection someone
 * made meanwhile.
 */
export async function adoptInstall(a: { url: string; hubName: string | null; installId: string; installKey: string; scope: "member" | "partner" | "pending" }) {
  const fresh = await hubState();
  if (fresh?.installKey) throw new UserError("This program joined a hub a moment ago. Look at Settings → Community hub, then try again.");
  // An install that was never on any hub has no copies of a hub's to clear.
  const hadConnection = Boolean(fresh?.url || fresh?.formerUrl);
  const data = {
    url: a.url,
    hubName: a.hubName,
    installId: a.installId,
    installKey: a.installKey,
    joinedAt: new Date(),
    cursor: "0",
    orderCursor: null,
    partnerCursor: "0",
    lastError: null,
    scope: a.scope,
    formerUrl: null,
    formerInstallId: null,
    formerInstallKey: null,
  };
  await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  if (hadConnection) {
    await clearHubCopies();
    await db.sharedPost.updateMany({ where: { hubId: { not: null } }, data: { hubId: null } });
  }
}

/**
 * The synced copies of what the hub holds (links, notes, parts, listings, the figures it has), for a fresh start on
 * another connection. Figures this install shared are kept with its own copy (FigureImage); the rest are only the
 * hub's ids, and pictures fetched from it.
 */
async function clearHubCopies() {
  await db.$transaction([
    db.manualLink.deleteMany(),
    db.hubPost.deleteMany(),
    db.xPart.deleteMany(),
    db.removedXPart.deleteMany(),
    db.listing.deleteMany(),
    db.listingPhoto.deleteMany(),
    db.hubFigure.deleteMany(),
  ]);
}

export async function leaveHub() {
  // Partner shops talk through the hub too: leaving only stops the community part while partnerships are active.
  if (await db.partnerLink.count({ where: { status: "ACTIVE" } })) {
    throw new UserError("Your partner shops are connected through this hub. End those partnerships first (Partners), then leave.");
  }
  // An open order belongs to this connection: after leaving, nobody here could answer it. (A hub that's gone for good
  // doesn't hold anyone here.)
  const open = await db.marketOrder.count({ where: { status: { in: ["REQUESTED", "ACCEPTED", "PAID"] } } });
  if (open && !net.offlineSince) {
    throw new UserError(`${open === 1 ? "An order on the marketplace is" : `${open} orders on the marketplace are`} still open. Finish or cancel ${open === 1 ? "it" : "them"} (Marketplace → Orders), then leave.`);
  }
  // Listings still for sale would take orders nobody here sees: they come off the marketplace (when the hub answers).
  const selling = await db.listing.findMany({ where: { mine: true, status: { in: ["ACTIVE", "PAUSED"] } }, select: { id: true } });
  for (const l of selling) await hubFetch(`/v1/listings/${hubId(l.id)}`, { method: "DELETE" }).catch(() => {});
  // The figures known only as the hub's (ids, and pictures fetched from it) go with the connection: without it they
  // would show as stored and fail to open. The links and notes stay readable until another connection replaces them.
  await db.$transaction([db.listing.deleteMany(), db.listingPhoto.deleteMany(), db.hubFigure.deleteMany()]);
  // The install's key is kept aside: joining this same hub again keeps the install (joinHub), so its listings, orders
  // and shared notes there stay its own instead of becoming another shop's.
  const s = await hubState();
  await db.hubState.updateMany({
    where: { id: 1 },
    data: {
      url: null,
      installId: null,
      installKey: null,
      cursor: null,
      orderCursor: null,
      discordUrl: null,
      scope: "member",
      partnerCursor: null,
      formerUrl: s?.url ?? null,
      formerInstallId: s?.installId ?? null,
      formerInstallKey: s?.installKey ?? null,
    },
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
    shopRef: p.shopRef ?? null,
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
  // The company on the seller's install that listed it (hubs from before per-company identity don't send it), and its
  // id in the hub's shops table once it has claimed itself; shopName is then the company's current name
  shopRef?: string | null;
  shopId?: string | null;
  title: string;
  description: string | null;
  kind: string;
  condition: string;
  // GENUINE | COMPATIBLE | PRINTED; null = the seller's install didn't say (hubs from before this don't send it at all)
  origin?: string | null;
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
/** GET /v1/reputation/:installId?shopRef=: a shop's standing, with the company's current name and hub id once it has claimed itself. */
export type ReputationAnswer = {
  installId: string;
  shopRef: string | null;
  shopId?: string | null;
  shopName?: string | null;
  asSeller: Reputation;
  asBuyer: Reputation;
  recent: { stars: number; comment: string | null; role: string; at: string }[];
};
export type Rating = { stars: number; comment: string | null; at: string } | null;

export type HubOrder = {
  id: string;
  number: string;
  role: "buyer" | "seller";
  listingId: string;
  item: { title: string; brand: string | null; partNumber: string | null; condition: string; origin?: string | null };
  sellerShop: string;
  buyerShop: string;
  // Which company on each install (hubs from before per-company identity don't send them), and their ids in the hub's
  // shops table once claimed; sellerShop and buyerShop are then the companies' current names
  sellerShopRef?: string | null;
  buyerShopRef?: string | null;
  sellerShopId?: string | null;
  buyerShopId?: string | null;
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

/**
 * Removed entries are kept aside (name and numbers) so the cross-reference page can list them and put them back. One
 * merged into another has no numbers left of its own: there's nothing to put back.
 */
async function noteRemoved(xs: HubXPart[]) {
  const back = xs.filter((x) => !x.deleted).map((x) => x.id);
  const gone = xs.filter((x) => x.deleted && x.numbers.length);
  const ids = [...back, ...gone.map((x) => x.id)];
  if (ids.length) await db.removedXPart.deleteMany({ where: { id: { in: ids } } });
  if (gone.length) {
    await db.removedXPart.createMany({ data: gone.map((x) => ({ id: x.id, name: x.name, numbers: x.numbers, removedAt: new Date(x.updatedAt) })), skipDuplicates: true });
  }
}

async function saveXParts(xs: HubXPart[]) {
  await noteRemoved(xs);
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
  await noteRemoved([x]);
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
    origin: l.origin ?? null,
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
    sellerRef: l.shopRef ?? null,
  };
  // A listing of this install's belongs to the company the hub says listed it, so one whose answer was lost when it
  // was made still finds its company. From an older hub, the only company when there is just one; with several, it
  // stays as it was (the company that made it set it on creation).
  const shopId = l.mine ? await ownCompany(l.shopRef) : null;
  await db.listing.upsert({ where: { id: l.id }, create: { id: l.id, ...row, shopId }, update: { ...row, ...(shopId ? { shopId } : {}) } });
}

/** The company on this install a hub row names (its shopRef), else the only company when there is just one. */
async function ownCompany(shopRef: string | null | undefined) {
  if (shopRef) {
    const s = await db.shop.findUnique({ where: { id: shopRef }, select: { id: true } });
    if (s) return s.id;
  }
  return soleShopId();
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
  // The hub says which company on this install is the seller or the buyer (a sale on a listing already removed here,
  // an order whose answer was lost when it was placed).
  const ref = o.role === "seller" ? o.sellerShopRef : o.buyerShopRef;
  if (!owner && ref) owner = (await db.shop.findUnique({ where: { id: ref }, select: { id: true } }))?.id ?? null;
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

// Companies whose counts the hub was told to drop since this program started (once is enough).
const usageOff = new Set<string>();

/**
 * Tell the hub how many of each part each company used this month and last (counts only), for the community's
 * most-used list: only the companies that turned it on (Parts → Most used). The others' earlier reports, and what the
 * install sent before companies chose, are taken back. Months start and end on each company's own clock.
 */
async function pushUsage() {
  if (Date.now() - lastUsagePush < 3600_000) return;
  // Once an hour whether or not the hub takes it: a report it refuses isn't tried again every ten minutes.
  lastUsagePush = Date.now();
  // The hub refuses a month later than its own (UTC) month. For the first hours of a month east of UTC the company's
  // month has begun and the hub's hasn't: that month waits for a later report.
  const hubMonth = new Date().toISOString().slice(0, 7);
  type Item = { number: string; brand: string; qty: number; tickets: number };
  const offered: { id: string; name: string; months: { month: string; items: Item[] }[] }[] = [];
  // A company being moved (or moved) sends nothing from this copy: its counts come from the install it moves to, and an
  // "off" from here would take back the install's own older reports with it.
  for (const shop of await db.shop.findMany({ where: { movingAt: null }, select: { id: true, name: true, shareUsage: true, timeZone: true } })) {
    if (!shop.shareUsage) {
      if (usageOff.has(shop.id)) continue;
      // An older hub doesn't know "off" (400): it keeps what this install sent before, as it did.
      await hubFetch("/v1/usage", { method: "POST", json: { shopRef: shop.id, off: true } }).catch((e: unknown) => {
        if (hubStatus(e) !== 400) throw e;
      });
      usageOff.add(shop.id);
      continue;
    }
    usageOff.delete(shop.id);
    const months: { month: string; items: Item[] }[] = [];
    const thisMonth = monthPeriod(undefined, shop.timeZone);
    for (const { from, to, month } of [thisMonth, monthPeriod(thisMonth.prev, shop.timeZone)]) {
      if (month > hubMonth) continue;
      const rows = await db.$queryRaw<{ number: string; brand: string | null; qty: number; tickets: bigint }[]>`
        SELECT p."partNumber" AS number, p.brand, SUM(-sm.qty) AS qty, COUNT(DISTINCT sm."ticketId") AS tickets
        FROM "StockMove" sm JOIN "Part" p ON p.id = sm."partId"
        WHERE sm."shopId" = ${shop.id} AND sm.reason IN ('USED', 'RETURNED') AND sm."createdAt" >= ${from} AND sm."createdAt" < ${to}
          AND NOT p."ownNumber"
        GROUP BY p."partNumber", p.brand`;
      // The community counts a part by its number, not by how this shop tells its stock apart ("X (own)", "X (used)",
      // "X (Partner)"), and by the letters and digits of it: one with none ("-", a part named only in Chinese) would
      // make the hub refuse the whole month, so those stay out. A shop number (a part the maker gave none) isn't the
      // maker's number, so it is never reported.
      const byPart = new Map<string, { number: string; brand: string; qty: number; tickets: number }>();
      for (const r of rows) {
        const number = baseNumber(r.number).slice(0, 60);
        if (!key(number)) continue;
        const brand = r.brand ?? "";
        const k = `${key(number)}|${brand}`;
        const had = byPart.get(k) ?? { number, brand, qty: 0, tickets: 0 };
        had.qty += Number(r.qty);
        had.tickets += Number(r.tickets);
        byPart.set(k, had);
      }
      const items = [...byPart.values()].map((i) => ({ ...i, qty: Math.round(i.qty) })).filter((i) => i.qty > 0);
      months.push({ month, items: items.slice(0, 5000) });
    }
    offered.push({ id: shop.id, name: shop.name, months });
  }
  let refused: unknown = null;
  for (const shop of offered) {
    let perCompany = true;
    for (const { month, items } of shop.months) {
      try {
        const r = await hubFetch("/v1/usage", { method: "POST", json: { month, items, shopRef: shop.id, shopName: shop.name } });
        perCompany = !!((await r.json().catch(() => null)) as { shopRef?: string } | null)?.shopRef;
      } catch (e) {
        // A month the hub refuses mustn't keep the other month, or the other companies, from arriving.
        refused ??= e;
      }
    }
    // An older hub keeps one report per install and month, so each company's would replace the one before: it gets
    // every offering company's counts together instead, as one report.
    if (!perCompany) {
      const all = new Map<string, Map<string, Item>>();
      for (const s of offered)
        for (const { month, items } of s.months) {
          const sum = all.get(month) ?? new Map<string, Item>();
          all.set(month, sum);
          for (const it of items) {
            const k = `${key(it.number)}|${it.brand}`;
            const had = sum.get(k);
            if (had) {
              had.qty += it.qty;
              had.tickets += it.tickets;
            } else sum.set(k, { ...it });
          }
        }
      for (const [month, sum] of all) await hubFetch("/v1/usage", { method: "POST", json: { month, items: [...sum.values()].slice(0, 5000) } });
      return;
    }
  }
  if (refused) throw refused;
}

/** Report usage again on the next sync (a company just changed its setting). */
export function usageSettingChanged(shopId: string) {
  usageOff.delete(shopId);
  lastUsagePush = 0;
}

/**
 * Send notes this shop shared that the hub doesn't have yet. Each carries its own id, so a note the hub stored just as
 * the connection dropped isn't stored twice when it's sent again.
 */
async function pushPending() {
  const pending = await db.sharedPost.findMany({
    // Not from a company being moved: its notes go from the install it moves to (they travel in the move file).
    where: { hubId: null, shop: { movingAt: null } },
    include: { photos: { orderBy: { sortOrder: "asc" } }, author: { select: { name: true } }, shop: { select: { name: true } } },
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
        // The company that shared it, on an install that may hold several.
        shopRef: p.shopId,
        shopName: p.shop.name,
        clientId: p.id,
        photos: p.photos.map((ph) => ({ kind: ph.kind, caption: ph.caption })),
      }),
    );
    for (const ph of p.photos) fd.append("photo", new Blob([new Uint8Array(ph.data)], { type: ph.mime }), "photo.jpg");
    // Photos take a while on a slow connection.
    const { id } = (await (await hubFetch("/v1/posts", { method: "POST", body: fd, signal: AbortSignal.timeout(180_000) })).json()) as { id: string };
    // Removed here while it was on its way: it is on the hub now, so it comes down again (and the rest still go).
    const kept = await db.sharedPost.updateMany({ where: { id: p.id }, data: { hubId: id } });
    if (!kept.count) await hubFetch(`/v1/posts/${hubId(id)}`, { method: "DELETE" }).catch((e: unknown) => console.error("community hub: a removed note is still up:", e instanceof Error ? e.message : e));
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
    // Joined for partner shops only, the install stays that way whatever the hub says: only joinHub (a join key, from
    // someone allowed to join the whole install) makes it a member. Joined by starting a StitchHub account ("pending"),
    // it follows the hub: a member once the owner has opened the email and set a password.
    const scope = s.scope === "partner" || me.scope === "partner" ? "partner" : s.scope === "pending" && me.scope !== "member" ? "pending" : "member";
    // Not written while partner-only here: a join key being used right now (joinHub) may be making it a member.
    const still = await writeState(run, { hubName: me.hubName ?? null, ...(s.scope !== "partner" ? { scope } : {}), ...(me.discordInvite ? { discordUrl: me.discordInvite } : {}) });
    if (!still) return { skipped: true };
    // Every company says who it is and learns its standing, whatever the install's scope: a partner-only or pending
    // install still has an account and a key to keep (hub-accounts-billing-design.md 2.4).
    if (!(await claimShops(run))) return { skipped: true };
    // On the hub for partner shops only, or waiting for the account's email: nothing of the community's to sync.
    if (scope !== "member") {
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
        removedFigures?: string[];
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
      // A figure that comes again was redrawn: the copy kept here is fetched again. One the hub admin took down goes.
      if (ch.figures.length) {
        await db.hubFigure.updateMany({ where: { id: { in: ch.figures } }, data: { mime: null, data: null } });
        await db.hubFigure.createMany({ data: ch.figures.map((id) => ({ id })), skipDuplicates: true });
      }
      if (ch.removedFigures?.length) await db.hubFigure.deleteMany({ where: { id: { in: ch.removedFigures } } });
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

// Connections (install ids) whose hub is too old to know /v1/shops/claim (404): not asked again while this process runs.
const claimUnknown = ((globalThis as unknown as { __hubClaimUnknown?: Set<string> }).__hubClaimUnknown ??= new Set<string>());

/**
 * What the hub is told about one company at every sync (hub-accounts-billing-design.md 2.4): its name, what it does,
 * which program and version; `sole` on a one-company install, so what the install listed, ordered, was rated for and
 * shared before it named its company becomes that company's (its ratings carry over).
 */
function claimBody(shop: { id: string; name: string; doesRepair: boolean; sellsRetail: boolean }, sole: boolean) {
  return { shopRef: shop.id, shopName: shop.name, kind: shopKindOf(shop), program: appName(), version: programVersion(), sole };
}

/**
 * Every company on the install tells the hub who it is and learns its standing (and, when billing exists, its key):
 * the answer goes to the Shop row and the License table (hub-standing.ts). The first claim starts the company's trial.
 * False when the install moved to another hub (or left) meanwhile. An older hub doesn't know the route (404): nothing
 * is lost then, and it isn't asked again until the program restarts. Any other refusal is the sync's error.
 */
async function claimShops(run: SyncRun): Promise<boolean> {
  if (!run.installId || claimUnknown.has(run.installId)) return true;
  const shops = await db.shop.findMany({ select: { id: true, name: true, doesRepair: true, sellsRetail: true, movingAt: true, movedOutAt: true }, orderBy: { createdAt: "asc" } });
  for (const shop of shops) {
    // A company the hub has said moved to another install isn't this install's on the hub any more: not asked again.
    if (shop.movedOutAt) continue;
    let answer: StandingAnswer;
    try {
      answer = (await (await hubFetch("/v1/shops/claim", { method: "POST", json: claimBody(shop, shops.length === 1) })).json()) as StandingAnswer;
    } catch (e) {
      if (hubStatus(e) === 404) {
        claimUnknown.add(run.installId);
        return true;
      }
      // The company moved to another install (company-move-design.md 5.5): this copy learns where and when, stays
      // read-only and says so; the install's other companies carry on.
      const moved = movedAnswer(e);
      if (moved) {
        if (!(await sameHub(run))) return false;
        await applyMovedOut(shop.id, moved);
        continue;
      }
      throw e;
    }
    if (!(await sameHub(run))) return false;
    await applyStanding(shop.id, answer);
    if (!shop.movingAt) await forgetCancelledMove(shop.id);
  }
  return true;
}

/**
 * A move the owner cancelled while the hub was out of reach: its token is still good there, so the hub is told now
 * (company-move-design.md section 7). Quietly tried again next sync if it still doesn't answer.
 */
async function forgetCancelledMove(shopId: string) {
  const pending = await db.companyMove.findMany({ where: { shopId, direction: "export", hubError: MOVE_CANCEL_PENDING }, select: { id: true } });
  if (!pending.length) return;
  try {
    await hubFetch(`/v1/shops/${hubId(shopId)}/move-token`, { method: "DELETE", shopRef: shopId });
  } catch (e) {
    if (hubStatus(e) !== 404) return;
  }
  await db.companyMove.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { hubError: null } });
}

/** One company's claim and standing now (Settings → Account's "Check again"): the same request the sync makes. */
export async function claimShopNow(shopId: string): Promise<StandingAnswer> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true, doesRepair: true, sellsRetail: true } });
  if (!shop) throw new UserError("Company not found.");
  const sole = (await db.shop.count()) === 1;
  let answer: StandingAnswer;
  try {
    answer = (await (await hubFetch("/v1/shops/claim", { method: "POST", json: claimBody(shop, sole), shopRef: shop.id })).json()) as StandingAnswer;
  } catch (e) {
    const moved = movedAnswer(e);
    if (moved) await applyMovedOut(shop.id, moved);
    throw e;
  }
  await applyStanding(shop.id, answer);
  return answer;
}

/**
 * Sync after a person's change (a note shared, an order accepted): they wait for it while the hub answers, a few
 * seconds at most, and not at all once it's known to be down; the rest carries on in the background.
 */
export async function syncSoon(maxWait = 8000) {
  const run = syncHub().catch(() => undefined);
  if (net.offlineSince) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([run, new Promise((r) => (timer = setTimeout(r, maxWait)))]);
  clearTimeout(timer);
}

// One sync at a time, shared by every copy of this module Next loads; a second caller waits for the one running.
const shared = globalThis as unknown as { __hubSync?: Promise<SyncResult> | null };

export function syncHub(): Promise<SyncResult> {
  shared.__hubSync ??= inBackground(doSync).finally(() => {
    shared.__hubSync = null;
  });
  return shared.__hubSync;
}

// The hub's own limit for a figure or a photo is 2 MB. A picture past this isn't read further, kept, or shown: a hub that
// sends a huge body must not fill this program's memory and database.
const MAX_PICTURE = 3 * 1024 * 1024;

/** A picture from the hub (note photo, figure snapshot or listing photo), kept locally after the first look. */
export async function hubPicture(kind: "photo" | "figure" | "listing", id: string): Promise<{ mime: string; data: Uint8Array } | null> {
  id = hubId(id);
  if (kind === "listing") {
    const have = await db.listingPhoto.findUnique({ where: { id } });
    if (have) return { mime: safeImageType(have.mime), data: have.data };
    const r = await hubFetch(`/v1/listing-photos/${id}`, { quick: true });
    const mime = safeImageType(r.headers.get("content-type"));
    const data = await readUpTo(r, MAX_PICTURE);
    if (!data) return null;
    await db.listingPhoto.upsert({ where: { id }, create: { id, mime, data }, update: {} });
    return { mime, data };
  }
  if (kind === "photo") {
    const p = await db.hubPhoto.findUnique({ where: { id }, select: { mime: true, data: true } });
    if (!p) return null;
    if (p.data) return { mime: safeImageType(p.mime), data: p.data };
    const r = await hubFetch(`/v1/photos/${id}`, { quick: true });
    const data = await readUpTo(r, MAX_PICTURE);
    if (!data) return null;
    await db.hubPhoto.update({ where: { id }, data: { data } });
    return { mime: safeImageType(p.mime), data };
  }
  const f = await db.hubFigure.findUnique({ where: { id } });
  if (!f) return null;
  if (f.data && f.mime) return { mime: safeImageType(f.mime), data: f.data };
  const r = await hubFetch(`/v1/figures/${id}`, { quick: true });
  const mime = safeImageType(r.headers.get("content-type"));
  const data = await readUpTo(r, MAX_PICTURE);
  if (!data) return null;
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
