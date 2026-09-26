import "server-only";
// Partnerships between a repair shop (StitchBench) and the sewing / quilt shops (StitchShop) that work with it.
// Both shops keep their own copy of each shared record (repair jobs, orders, consignment, settlements) under the same
// id; they stay in step by sending each other messages through the hub (PartnerOutbox -> hub -> the other install).
//
// Who sends what (anything else is ignored):
//   sewing shop -> repair shop : job.new, job.reply, job.paid, job.pickedup, job.cancel, order.new, order.update
//                                (received / cancelled), consign.sale, consign.count, consign.return
//   repair shop -> sewing shop : job.update, catalog, order.update (accepted / delivered / cancelled), consign.place
//   either                     : terms.propose, terms.accept, settle.paid
//   hub                        : link.created, link.ended
//
// The other shop may be careless or hostile, so every message is checked before it's applied: it must come from the
// side allowed to send it, on a link this shop is on, with sensible values. A message that can't be applied is set
// aside (PartnerFailure, shown on the Partners page) instead of stopping every message after it.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { checkHubUrl, hubFetch, hubId, hubState, hubStatus, inBackground } from "@/lib/hub";
import { lineTotal } from "@/lib/ticket-math";
import { modelKey } from "@/lib/format";
import { normalizeTerms, repairCommission, termsKey, type Accepted, type PartnerTerms } from "@/lib/partner-terms";
import { Prisma } from "@/generated/prisma/client";

export const DEFAULT_HUB_URL = (process.env.DEFAULT_HUB_URL ?? "https://stitchhub-production.up.railway.app").replace(/\/+$/, "");
const FINAL = ["COLLECTED", "ABANDONED", "RETURNED_UNREPAIRED"];
const READY = ["READY_IN_TRUCK", "READY_FOR_PICKUP", "RETURNED_UNREPAIRED"];
const STATUSES = ["AT_SHOP_AWAITING_PICKUP", "IN_TRUCK", "ON_BENCH", "WAITING_CUSTOMER_OK", "WAITING_PARTS", "READY_IN_TRUCK", "READY_FOR_PICKUP", "COLLECTED", "ABANDONED", "RETURNED_UNREPAIRED"];
const KINDS = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"];
const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_MONEY = 10_000_000; // $100,000 in cents: far above any real repair, order or statement
const MAX_QTY = 100_000;
const MAX_EVENTS = 200;

type Json = Prisma.InputJsonValue;
type Obj = Record<string, unknown>;
type Side = "repair" | "retail";

// ---------- checking what a partner sent ----------

/** The partner sent something that can't be applied as it is (bad or out-of-range data, wrong sender). */
class PartnerDataError extends Error {}

const bad = (msg: string): never => {
  throw new PartnerDataError(msg);
};
const obj = (v: unknown, what: string): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : bad(`${what} is missing`));
const idOf = (v: unknown, what: string) => {
  const t = String(v ?? "");
  return /^[A-Za-z0-9_-]{1,80}$/.test(t) ? t : bad(`${what} isn't a valid id`);
};
/** Text, trimmed and cut to max; null when empty. */
const text = (v: unknown, max: number) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
};
const need = (v: unknown, max: number, what: string) => text(v, max) ?? bad(`${what} is missing`);
const int = (v: unknown, min: number, max: number, what: string) => {
  const x = Number(v);
  return Number.isInteger(x) && x >= min && x <= max ? x : bad(`${what} is out of range`);
};
const optInt = (v: unknown, min: number, max: number, what: string) => (v == null || v === "" ? null : int(v, min, max, what));
const qtyOf = (v: unknown, what: string) => {
  const x = Number(v);
  return Number.isFinite(x) && Math.abs(x) <= MAX_QTY ? Math.round(x * 1000) / 1000 : bad(`${what} is out of range`);
};
const dateOf = (v: unknown, what: string) => {
  const d = new Date(String(v ?? ""));
  return Number.isNaN(d.getTime()) ? bad(`${what} isn't a date`) : d;
};
const arr = (v: unknown, max: number, what: string): unknown[] => {
  if (v == null) return [];
  if (!Array.isArray(v)) return bad(`${what} isn't a list`);
  return v.length > max ? bad(`${what} has too many entries`) : v;
};
const strings = (v: unknown) => arr(v, 50, "list").map((x) => String(x).trim().slice(0, 200)).filter(Boolean);
/** Something a partner sent, kept for reference: photos left out, and cut to a short preview when it's large. */
function storable(v: unknown, max = 20_000): Json {
  const json = JSON.stringify(v ?? {}, (k, x) => (k === "data" && typeof x === "string" && x.length > 200 ? "(photo)" : x)) ?? "{}";
  return json.length <= max ? (JSON.parse(json) as Json) : { preview: json.slice(0, 2000) };
}

/** Records keep a history, but never an endless one. */
function withEvent(events: unknown, e: JobEvent) {
  const list = Array.isArray(events) ? (events as JobEvent[]) : [];
  return [...list, e].slice(-MAX_EVENTS) as Json;
}

export type HubPartnerLink = {
  id: string;
  status: string;
  terms: unknown;
  repair: { installId: string; shopRef: string; name: string };
  retail: { installId: string; shopRef: string; name: string };
  createdAt: string;
  endedAt: string | null;
};

export type CatalogItem = {
  itemKey: string;
  partNumber: string;
  description: string;
  kind: string;
  brand: string | null;
  unit: string | null;
  wholesaleCents: number;
  retailCents: number | null;
  inStock: number;
};

export type JobEvent = { at: string; status?: string; note?: string };
export type JobLine = { description: string; qty: number; amountCents: number; kind: string };
export type OrderLine = { itemKey: string; partNumber: string; description: string; qty: number; unitCents: number };

export async function partnerLink(shopId: string, id: string) {
  const l = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id } } });
  if (!l) throw new UserError("That partnership isn't on this shop.");
  return l;
}

// ---------- sending ----------

let kickTimer: NodeJS.Timeout | null = null;

/** Sync with partners soon (a second or two), so what someone just did reaches the other shop quickly. */
export function kickPartnerSync() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    syncPartners().catch((e) => console.error("partner sync:", e instanceof Error ? e.message : e));
  }, 1500);
}

/** Queue a message for the partner on the other side of `linkId`; it goes out on the next partner sync. */
export async function sendToPartner(shopId: string, linkId: string, type: string, data: Json, tx: Prisma.TransactionClient = db) {
  await tx.partnerOutbox.create({ data: { shopId, linkId, type, data } });
  kickPartnerSync();
}

// ---------- joining ----------

/** A partner code as handed over: the short code, or "stitchpartner:..." carrying the hub's address too. */
export function parsePartnerCode(text: string): { code: string; url: string | null } {
  const t = text.trim();
  if (t.toLowerCase().startsWith("stitchpartner:")) {
    let j: { url?: string; code?: string } | null = null;
    try {
      j = JSON.parse(Buffer.from(t.slice(14).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { url?: string; code?: string };
    } catch {
      /* damaged */
    }
    if (!j?.code || !j.url) throw new UserError("That partner code is damaged. Copy it again.");
    const code = String(j.code).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 12) throw new UserError("That partner code is damaged. Copy it again.");
    return { code, url: checkHubUrl(String(j.url)) };
  }
  const code = t.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 12) throw new UserError("A partner code has 12 letters and numbers, like 7KQP-M2XH-9TRD.");
  return { code, url: null };
}

export function longPartnerCode(url: string, code: string) {
  return "stitchpartner:" + Buffer.from(JSON.stringify({ url, code })).toString("base64url");
}

/** This shop makes a code for the shop it wants to partner with. Needs the hub (Settings -> Community hub). */
export async function createPartnerInvite(shopId: string, shopName: string, side: Side, terms: PartnerTerms) {
  const r = (await (await hubFetch("/v1/partners/invites", { method: "POST", json: { shopRef: shopId, shopName, side, terms } })).json()) as {
    code: string;
    expiresAt: string;
  };
  // Start listening for the partner redeeming it.
  await db.hubState.update({ where: { id: 1 }, data: { partnerCursor: (await hubState())?.partnerCursor ?? "0" } });
  const s0 = await hubState();
  return { ...r, long: longPartnerCode(s0!.url!, r.code) };
}

/**
 * Enter a partner code: on the hub this install already uses, or (not on any hub yet) join the code's hub for partners
 * only. Joining a hub changes the whole install, so callers check who may do that (requireInstallAdmin).
 */
export async function redeemPartnerCode(shopId: string, shopName: string, contact: string | null, text: string) {
  const { code, url } = parsePartnerCode(text);
  const st = await hubState();
  let out: { link: HubPartnerLink; side: Side };
  if (st?.url && st.installKey) {
    if (url && url !== st.url) throw new UserError(`This install uses the hub at ${st.url}; that code is for ${url}. Ask for a code from the same hub.`);
    out = (await (await hubFetch("/v1/partners/redeem", { method: "POST", json: { code, shopRef: shopId, shopName } })).json()) as typeof out;
  } else {
    const base = url ?? DEFAULT_HUB_URL;
    let r: Response;
    try {
      r = await fetch(`${base}/v1/partners/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, shopRef: shopId, shopName, contact }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new UserError("Couldn't reach the hub. Check the internet connection and try again.");
    }
    const j = (await r.json().catch(() => ({}))) as { error?: string; installId?: string; installKey?: string; hubName?: string } & typeof out;
    if (!r.ok) throw new UserError(j.error ?? `The hub answered ${r.status}.`);
    // Someone else on this install joined a hub meanwhile: keep theirs (this code was used; ask for a new one).
    const fresh = await hubState();
    if (fresh?.installKey) throw new UserError("This install joined a hub a moment ago. Ask for a new partner code and enter it again.");
    const data = {
      url: base,
      hubName: j.hubName,
      installId: j.installId,
      installKey: j.installKey,
      joinedAt: new Date(),
      scope: "partner",
      cursor: null,
      orderCursor: null,
      partnerCursor: "0",
    };
    await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    out = j;
  }
  await saveLinkFromHub(shopId, out.side, out.link);
  const s1 = await hubState();
  if (s1?.partnerCursor == null) await db.hubState.update({ where: { id: 1 }, data: { partnerCursor: "0" } });
  kickPartnerSync();
  return out;
}

export async function endPartnership(shopId: string, linkId: string, note: string | null) {
  await partnerLink(shopId, linkId);
  const l = (await (await hubFetch(`/v1/partners/links/${hubId(linkId)}/end`, { method: "POST", json: { shopRef: shopId, note } })).json()) as HubPartnerLink;
  await db.partnerLink.update({ where: { shopId_id: { shopId, id: linkId } }, data: { status: l.status, endedAt: l.endedAt ? new Date(l.endedAt) : new Date() } });
}

/**
 * The trade account a partner sewing shop's machines come in under. An existing account of the same name is used only
 * if no other partnership already uses it, and its commission is left as the shop set it.
 */
async function tradeAccountFor(shopId: string, name: string, terms: PartnerTerms) {
  const found = await db.customer.findFirst({ where: { shopId, kind: "TRADE", name: { equals: name, mode: "insensitive" } } });
  if (found && !(await db.partnerLink.findFirst({ where: { shopId, accountId: found.id } }))) return found.id;
  const c = await db.customer.create({
    data: {
      shopId,
      kind: "TRADE",
      name: found ? `${name} (partner)` : name,
      commissionPct: terms.repairCommissionPct,
      routeDay: terms.pickupDay,
      notes: "Partner shop: machines, orders and consignment come through the partner link (Partners).",
    },
  });
  return c.id;
}

/** Checks a link record as the hub sends it (redeem answer, link.created). */
function hubLinkOf(v: unknown): HubPartnerLink {
  const l = obj(v, "link");
  const side = (x: unknown, what: string) => {
    const o = obj(x, what);
    return { installId: String(o.installId ?? ""), shopRef: String(o.shopRef ?? ""), name: need(o.name, 120, `${what} name`) };
  };
  return {
    id: idOf(l.id, "link id"),
    status: l.status === "ENDED" ? "ENDED" : "ACTIVE",
    terms: l.terms ?? {},
    repair: side(l.repair, "repair shop"),
    retail: side(l.retail, "sewing shop"),
    createdAt: String(l.createdAt ?? ""),
    endedAt: l.endedAt ? dateOf(l.endedAt, "endedAt").toISOString() : null,
  };
}

export async function saveLinkFromHub(shopId: string, side: Side, raw: HubPartnerLink) {
  const l = hubLinkOf(raw);
  const partnerName = side === "repair" ? l.retail.name : l.repair.name;
  const terms = normalizeTerms(l.terms);
  const where = { shopId_id: { shopId, id: l.id } };
  const existing = await db.partnerLink.findUnique({ where });
  const endedAt = l.endedAt ? new Date(l.endedAt) : null;
  if (!existing) {
    const accountId = side === "repair" ? await tradeAccountFor(shopId, partnerName, terms) : null;
    await db.partnerLink.create({ data: { id: l.id, shopId, side, partnerName, status: l.status, terms, accountId, endedAt } });
    return;
  }
  // The same two shops used a new code (after ending, or while still linked): its terms become a new version that both
  // accept again. Money already recorded keeps the rates it was recorded at.
  const newTerms = l.status === "ACTIVE" && termsKey(terms) !== termsKey(normalizeTerms(existing.terms));
  await db.partnerLink.update({
    where,
    data: {
      partnerName,
      status: l.status,
      endedAt,
      ...(newTerms ? { terms, termsVersion: existing.termsVersion + 1, accepted: {}, proposedTerms: Prisma.DbNull, proposedBy: null } : {}),
    },
  });
}

// ---------- terms ----------

type Proposal = { version: number; terms: PartnerTerms; by: { name: string; at: string } };

export async function proposeTerms(shopId: string, linkId: string, terms: PartnerTerms, byName: string) {
  const l = await partnerLink(shopId, linkId);
  const version = l.termsVersion + 1;
  const at = new Date().toISOString();
  await db.$transaction(async (tx) => {
    await tx.partnerLink.update({
      where: { shopId_id: { shopId, id: linkId } },
      data: { proposedTerms: { version, terms, by: { name: byName, at } } as Json, proposedBy: l.side },
    });
    await sendToPartner(shopId, linkId, "terms.propose", { version, terms, name: byName, at, key: termsKey(terms) }, tx);
  });
}

/** This shop accepts the current terms, or the change the partner proposed. */
export async function acceptTerms(shopId: string, linkId: string, byName: string) {
  const l = await partnerLink(shopId, linkId);
  const at = new Date().toISOString();
  const accepted = { ...((l.accepted as Accepted) ?? {}) };
  const prop = l.proposedTerms as Proposal | null;
  let data: Prisma.PartnerLinkUpdateInput;
  let version = l.termsVersion;
  let terms = normalizeTerms(l.terms);
  if (prop && l.proposedBy !== l.side) {
    version = prop.version;
    terms = normalizeTerms(prop.terms);
    const other = l.side === "repair" ? "retail" : "repair";
    const next: Accepted = { [other]: { ...prop.by, version }, [l.side]: { name: byName, at, version } };
    data = { terms, termsVersion: version, accepted: next as Json, proposedTerms: Prisma.DbNull, proposedBy: null };
  } else {
    accepted[l.side as Side] = { name: byName, at, version };
    data = { accepted: accepted as Json };
  }
  await db.$transaction(async (tx) => {
    await tx.partnerLink.update({ where: { shopId_id: { shopId, id: linkId } }, data });
    // The key lets the partner check these are the very terms it has; a mismatch is shown rather than recorded.
    await sendToPartner(shopId, linkId, "terms.accept", { version, name: byName, at, key: termsKey(terms) }, tx);
  });
}

// ---------- repair side: what the sewing shop sees of each job, and the catalog ----------

type TicketForJob = Prisma.TicketGetPayload<{ include: { lines: true; payments: true } }>;
type JobRow = Prisma.RepairJobGetPayload<object>;

/**
 * What the sewing shop hears about a job. Once a job is fully paid its commission and paid date are fixed: later
 * payments or new terms don't move a settled job to another month or change what it earned.
 */
function jobSnapshot(job: JobRow, t: TicketForJob, terms: PartnerTerms) {
  const lines: JobLine[] = t.lines.map((l) => ({ description: l.description, qty: l.qty, amountCents: lineTotal(l), kind: l.kind }));
  const subtotal = lines.reduce((a, l) => a + l.amountCents, 0);
  const taxable = t.lines.filter((l) => l.taxable).reduce((a, l) => a + lineTotal(l), 0);
  // A discount lowers the taxable amount in proportion (as at the register).
  const discount = -t.lines.filter((l) => l.kind === "DISCOUNT").reduce((a, l) => a + lineTotal(l), 0);
  const gross = subtotal + discount;
  const taxBase = gross > 0 ? Math.max(0, taxable - Math.round((discount * taxable) / gross)) : taxable;
  const tax = Math.round((taxBase * t.taxRatePct) / 100);
  const total = subtotal + tax;
  const direct = t.payments.filter((p) => p.method !== "SHOP_COLLECTED").reduce((a, p) => a + p.amountCents, 0);
  const atShop = t.payments.filter((p) => p.method === "SHOP_COLLECTED").reduce((a, p) => a + p.amountCents, 0);
  const paidAt = job.paidAt ?? (total > 0 && direct + atShop >= total ? new Date() : null);
  return {
    id: job.id,
    status: t.status,
    ticketNumber: t.number,
    lines,
    totalCents: total,
    taxCents: tax,
    commissionPct: job.paidAt ? job.commissionPct : terms.repairCommissionPct,
    commissionCents: job.paidAt && job.commissionCents != null ? job.commissionCents : repairCommission(lines, terms),
    repairNote: job.repairNote,
    repairPaidCents: direct || null,
    paidAt: paidAt?.toISOString() ?? null,
    readyAt: t.readyAt?.toISOString() ?? null,
  };
}

const hash = (v: unknown) => crypto.createHash("sha1").update(JSON.stringify(v)).digest("hex");

/** Queue a job.update for every partner job whose ticket changed since the sewing shop last heard. */
async function pushJobUpdates() {
  const since = new Date(Date.now() - 60 * 86400_000);
  const jobs = await db.repairJob.findMany({
    where: { side: "repair", ticketId: { not: null }, OR: [{ status: { notIn: FINAL } }, { updatedAt: { gte: since } }] },
  });
  for (const job of jobs) {
    const t = await db.ticket.findUnique({ where: { id: job.ticketId! }, include: { lines: { orderBy: { createdAt: "asc" } }, payments: { orderBy: { paidAt: "asc" } } } });
    const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId: job.shopId, id: job.linkId } } });
    if (!t || !link) continue;
    const snap = jobSnapshot(job, t, normalizeTerms(link.terms));
    // The hash leaves out the paid date so a not-yet-sent "paid now" doesn't make every sync send again.
    const h = hash({ ...snap, paidAt: snap.paidAt ? "paid" : null });
    if (h === job.sentHash) continue;
    const events = snap.status !== job.status ? withEvent(job.events, { at: new Date().toISOString(), status: snap.status }) : (job.events as Json);
    await db.$transaction(async (tx) => {
      await tx.repairJob.update({
        where: { shopId_id: { shopId: job.shopId, id: job.id } },
        data: {
          status: snap.status,
          ticketNumber: snap.ticketNumber,
          totalCents: snap.totalCents,
          taxCents: snap.taxCents,
          lines: snap.lines as Json,
          commissionPct: snap.commissionPct,
          commissionCents: snap.commissionCents,
          repairPaidCents: snap.repairPaidCents,
          events,
          sentHash: h,
          ...(snap.paidAt && !job.paidAt ? { paidAt: new Date(snap.paidAt), paidWhere: job.paidCents ? "split" : "repair" } : {}),
          ...(snap.status === "COLLECTED" && !job.pickedUpAt ? { pickedUpAt: new Date() } : {}),
        },
      });
      await tx.partnerOutbox.create({ data: { shopId: job.shopId, linkId: job.linkId, type: "job.update", data: { ...snap, at: new Date().toISOString() } } });
    });
  }
}

/** What a repair shop offers its partner shops: parts marked "offer to partner shops" with a partner price. */
export async function catalogFor(shopId: string): Promise<CatalogItem[]> {
  const parts = await db.part.findMany({
    where: { shopId, offerToPartners: true, wholesaleCents: { not: null }, consignLinkId: null },
    orderBy: [{ kind: "asc" }, { description: "asc" }],
    take: 5000,
  });
  return parts.map((p) => ({
    itemKey: p.id,
    partNumber: p.partNumber,
    description: p.description,
    kind: p.kind,
    brand: p.brand,
    unit: p.unit,
    wholesaleCents: p.wholesaleCents!,
    retailCents: p.priceCents,
    inStock: p.qtyOnHand,
  }));
}

async function pushCatalogs() {
  const links = await db.partnerLink.findMany({ where: { side: "repair", status: "ACTIVE" } });
  const byShop = new Map<string, { items: CatalogItem[]; h: string }>();
  for (const l of links) {
    if (!byShop.has(l.shopId)) {
      const items = await catalogFor(l.shopId);
      byShop.set(l.shopId, { items, h: hash(items) });
    }
    const c = byShop.get(l.shopId)!;
    if (c.h === l.catalogHash) continue;
    // Stock counts change with every sale; send at most every 10 minutes unless it's the first time.
    if (l.catalogHash && l.catalogAt && Date.now() - l.catalogAt.getTime() < 10 * 60_000) continue;
    await db.$transaction([
      db.partnerOutbox.create({ data: { shopId: l.shopId, linkId: l.id, type: "catalog", data: { items: c.items, at: new Date().toISOString() } as Json } }),
      db.partnerLink.update({ where: { shopId_id: { shopId: l.shopId, id: l.id } }, data: { catalogHash: c.h, catalogAt: new Date() } }),
    ]);
  }
}

// ---------- sync ----------

/**
 * Send what's waiting, oldest first per partnership. A message the hub refuses for good (bad data, unknown link) is set
 * aside and shown; one that fails because the hub or the internet is down waits and is tried again, never dropped,
 * and holds back every later message of the same partnership until it goes (an update must not overtake its job),
 * across syncs: a partnership whose oldest waiting message isn't due yet sends nothing.
 */
async function pushOutbox() {
  const now = Date.now();
  // The waiting list without the messages themselves (a job can carry photos); each is loaded when it's sent.
  const waiting = await db.partnerOutbox.findMany({
    where: { sentAt: null, deadAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, shopId: true, linkId: true, nextTryAt: true },
    take: 5000,
  });
  const held = new Set<string>();
  let sent = 0;
  let tried = 0;
  for (const w of waiting) {
    const key = `${w.shopId}|${w.linkId}`;
    if (held.has(key)) continue;
    if (w.nextTryAt && w.nextTryAt.getTime() > now) {
      held.add(key);
      continue;
    }
    if (++tried > 300) break; // the rest next time
    const m = await db.partnerOutbox.findUnique({ where: { id: w.id } });
    if (!m || m.sentAt || m.deadAt) continue;
    try {
      await hubFetch(`/v1/partners/links/${hubId(m.linkId)}/messages`, { method: "POST", json: { id: m.id, shopRef: m.shopId, type: m.type, data: m.data } });
      await db.partnerOutbox.update({ where: { id: m.id }, data: { sentAt: new Date(), error: null, nextTryAt: null } });
      sent++;
    } catch (e) {
      const status = hubStatus(e);
      const forGood = status >= 400 && status < 500 && status !== 408 && status !== 429;
      const tries = m.tries + 1;
      await db.partnerOutbox.update({
        where: { id: m.id },
        data: {
          tries,
          error: e instanceof Error ? e.message : String(e),
          ...(forGood ? { deadAt: new Date() } : { nextTryAt: new Date(Date.now() + Math.min(30 * 60_000, 15_000 * 2 ** Math.min(tries, 7))) }),
        },
      });
      if (!forGood) held.add(key);
    }
  }
  return sent;
}

type HubMessage = {
  seq: string;
  id: string;
  linkId: string;
  fromSide: "repair" | "retail" | "hub";
  toSide: Side;
  toShopRef: string;
  type: string;
  data: Obj;
  createdAt: string;
};

/**
 * Apply what partners sent, in order. A message with bad data is set aside at once; one whose apply keeps failing
 * (3 syncs) is set aside too, so nothing stops every later message. Until then a failure stops here and the cursor
 * stays just before it, and the message is tried again on the next sync.
 */
async function pullMessages(cursor: string) {
  let since = cursor;
  let received = 0;
  for (let page = 0; page < 50; page++) {
    const r = (await (await hubFetch(`/v1/partners/messages?since=${/^\d+$/.test(since) ? since : "0"}&limit=200`)).json()) as { messages: HubMessage[]; next: string; more: boolean };
    // A hub message goes to both shops when both are on this install: rows of one seq move the cursor together.
    let doneThrough = since;
    for (let i = 0; i < r.messages.length; i++) {
      const m = r.messages[i];
      const shop = typeof m.toShopRef === "string" ? await db.shop.findUnique({ where: { id: m.toShopRef }, select: { id: true } }) : null;
      if (shop) {
        const key = `${m.linkId}:${m.fromSide}:${m.id}:${m.toSide}`.slice(0, 300);
        const seen = await db.partnerSeen.findUnique({ where: { shopId_key: { shopId: shop.id, key } } });
        if (!seen) {
          try {
            await applyMessage(m);
            await db.partnerSeen.create({ data: { shopId: shop.id, key } }).catch(() => {});
            received++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const prior = await db.partnerFailure.findUnique({ where: { shopId_key: { shopId: shop.id, key } } });
            const tries = (prior?.tries ?? 0) + 1;
            const skip = e instanceof PartnerDataError || tries >= 3;
            const data = storable(m.data);
            await db.partnerFailure
              .upsert({
                where: { shopId_key: { shopId: shop.id, key } },
                create: { shopId: shop.id, key, linkId: String(m.linkId).slice(0, 80), type: String(m.type).slice(0, 40), data, error: msg.slice(0, 1000), skipped: skip },
                update: { tries, error: msg.slice(0, 1000), skipped: skip, at: new Date() },
              })
              .catch(() => ({ skipped: true }));
            if (skip) {
              await db.partnerSeen.create({ data: { shopId: shop.id, key } }).catch(() => {});
            } else {
              await db.hubState.update({ where: { id: 1 }, data: { partnerCursor: doneThrough } });
              throw new Error(`partner message ${m.type} from ${m.fromSide}: ${msg}`);
            }
          }
        }
      }
      if (r.messages[i + 1]?.seq !== m.seq) doneThrough = m.seq;
    }
    await db.hubState.update({ where: { id: 1 }, data: { partnerCursor: r.next } });
    since = r.next;
    if (!r.more) break;
  }
  return received;
}

export type PartnerSyncResult = { sent: number; received: number } | { skipped: true } | { busy: true };

/** One partner sync at a time on this install, even with several server processes (a lease on the HubState row). */
async function withSyncLease<T>(run: () => Promise<T>): Promise<T | null> {
  const got = await db.$executeRaw`UPDATE "HubState" SET "partnerLockUntil" = now() + interval '5 minutes'
    WHERE id = 1 AND ("partnerLockUntil" IS NULL OR "partnerLockUntil" < now())`;
  if (!got) return null;
  try {
    return await run();
  } finally {
    await db.$executeRaw`UPDATE "HubState" SET "partnerLockUntil" = NULL WHERE id = 1`.catch(() => {});
  }
}

async function doPartnerSync(): Promise<PartnerSyncResult> {
  const st = await hubState();
  if (!st?.url || !st.installKey) return { skipped: true };
  // Nothing to listen for until a code is made or used here.
  if (st.partnerCursor == null && !(await db.partnerLink.count())) return { skipped: true };
  const result = await withSyncLease(async () => {
    try {
      await pushJobUpdates();
      await pushCatalogs();
      const sent = await pushOutbox();
      const received = await pullMessages(st.partnerCursor ?? "0");
      // Anything the messages just caused (a new job's first update) goes out now rather than next time.
      await pushJobUpdates();
      const more = await pushOutbox();
      const stuck = await db.partnerOutbox.count({ where: { sentAt: null, OR: [{ deadAt: { not: null } }, { tries: { gte: 5 } }] } });
      await db.hubState.update({
        where: { id: 1 },
        data: { partnerSyncAt: new Date(), partnerError: stuck ? `${stuck} message${stuck === 1 ? "" : "s"} to partners couldn't be sent (see below).` : null },
      });
      return { sent: sent + more, received };
    } catch (e) {
      await db.hubState.update({ where: { id: 1 }, data: { partnerError: e instanceof Error ? e.message : String(e) } }).catch(() => {});
      throw e;
    }
  });
  // The lease is held by another copy of the server (a hosted install runs several): its sync is the one running.
  return result ?? { busy: true };
}

// One sync at a time, shared by every copy of this module Next loads (the timers and the pages each bundle their own):
// a person pressing "Sync now" while the background sync is out waits for that one and hears how it went.
const shared = globalThis as unknown as { __partnerSync?: Promise<PartnerSyncResult> | null };

export function syncPartners(): Promise<PartnerSyncResult> {
  shared.__partnerSync ??= inBackground(doPartnerSync).finally(() => {
    shared.__partnerSync = null;
  });
  return shared.__partnerSync;
}

// ---------- applying what the partner sent ----------

// Which side may send each type (the hub sends link.*).
const FROM: Record<string, "repair" | "retail" | "either" | "hub"> = {
  "link.created": "hub",
  "link.ended": "hub",
  "terms.propose": "either",
  "terms.accept": "either",
  "settle.paid": "either",
  catalog: "repair",
  "job.update": "repair",
  "consign.place": "repair",
  "job.new": "retail",
  "job.reply": "retail",
  "job.paid": "retail",
  "job.pickedup": "retail",
  "job.cancel": "retail",
  "order.new": "retail",
  "order.update": "either",
  "consign.sale": "retail",
  "consign.count": "retail",
  "consign.return": "retail",
};

// New work isn't taken from a partnership that has ended; updates and settlements still are (the last statement).
const NEW_WORK = new Set(["job.new", "order.new", "consign.place", "catalog"]);

async function applyMessage(m: HubMessage) {
  const shop = await db.shop.findUnique({ where: { id: m.toShopRef } });
  if (!shop) return; // that company isn't on this install any more
  const shopId = shop.id;
  const allowed = FROM[m.type];
  if (!allowed) return; // a newer version of the app on the other side; nothing to do here
  const toSide: Side = m.toSide === "repair" ? "repair" : "retail";
  const linkId = idOf(m.linkId, "link id");
  const d = m.data && typeof m.data === "object" ? m.data : {};

  if (allowed === "hub") {
    if (m.fromSide !== "hub") return bad(`${m.type} can only come from the hub`);
    if (m.type === "link.created") {
      const l = hubLinkOf(d);
      if (l.id !== linkId) return bad("link.created names another link");
      return saveLinkFromHub(shopId, toSide, l);
    }
    await db.partnerLink.updateMany({ where: { shopId, id: linkId }, data: { status: "ENDED", endedAt: d.endedAt ? dateOf(d.endedAt, "endedAt") : new Date() } });
    return;
  }

  let link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: linkId } } });
  if (!link) {
    // Missed the link.created (a restored backup): ask the hub for the link.
    const links = (await (await hubFetch("/v1/partners/links")).json()) as (HubPartnerLink & { side: Side; shopRef: string })[];
    const l = links.find((x) => x.id === linkId && x.shopRef === shopId);
    if (!l) return;
    await saveLinkFromHub(shopId, l.side, l);
    link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: linkId } } });
    if (!link) return;
  }
  const partnerSide: Side = link.side === "repair" ? "retail" : "repair";
  if (m.fromSide !== partnerSide) return bad(`${m.type} came from the wrong side`);
  if (allowed !== "either" && allowed !== partnerSide) return bad(`${m.type} can't come from the ${partnerSide === "repair" ? "repair shop" : "sewing shop"}`);
  if (link.status !== "ACTIVE" && NEW_WORK.has(m.type)) return; // ended: no new work
  const lk = { shopId_id: { shopId, id: link.id } };
  const at = d.at != null ? dateOf(d.at, "at") : new Date(m.createdAt);
  const terms = normalizeTerms(link.terms);

  switch (m.type) {
    case "terms.propose": {
      const version = int(d.version, 1, 100_000, "version");
      if (version <= link.termsVersion) return;
      const mine = link.proposedTerms as Proposal | null;
      // Both proposed the same version at once: the repair shop's proposal stands for both.
      if (mine && mine.version === version && link.proposedBy === link.side && link.side === "repair") return;
      await db.partnerLink.update({
        where: lk,
        data: { proposedTerms: { version, terms: normalizeTerms(d.terms), by: { name: text(d.name, 120) ?? "", at: at.toISOString() } } as Json, proposedBy: m.fromSide },
      });
      return;
    }

    case "terms.accept": {
      const version = int(d.version, 1, 100_000, "version");
      const who = { name: text(d.name, 120) ?? "", at: at.toISOString(), version };
      const prop = link.proposedTerms as Proposal | null;
      const key = text(d.key, 4000);
      if (prop && prop.version === version && link.proposedBy === link.side) {
        // They accepted the change we offered, if it is the same change.
        if (key && key !== termsKey(normalizeTerms(prop.terms))) return bad("the partner accepted different terms from the ones offered; propose them again");
        const accepted: Accepted = { [link.side]: { ...prop.by, version }, [m.fromSide]: who };
        await db.partnerLink.update({
          where: lk,
          data: { terms: normalizeTerms(prop.terms), termsVersion: version, accepted: accepted as Json, proposedTerms: Prisma.DbNull, proposedBy: null },
        });
      } else if (version === link.termsVersion) {
        if (key && key !== termsKey(terms)) return bad("the partner accepted different terms from these; propose them again");
        await db.partnerLink.update({ where: lk, data: { accepted: { ...((link.accepted as Accepted) ?? {}), [m.fromSide]: who } as Json } });
      }
      return;
    }

    case "catalog": {
      const items = arr(d.items, 5000, "catalog").map((x) => {
        const it = obj(x, "catalog item");
        return {
          itemKey: idOf(it.itemKey, "item"),
          partNumber: need(it.partNumber, 80, "part number"),
          description: text(it.description, 300) ?? "",
          kind: KINDS.includes(String(it.kind)) ? String(it.kind) : "PART",
          brand: text(it.brand, 80),
          unit: it.unit === "yd" ? "yd" : null,
          wholesaleCents: int(it.wholesaleCents, 0, MAX_MONEY, "partner price"),
          retailCents: optInt(it.retailCents, 0, MAX_MONEY, "retail price"),
          inStock: qtyOf(it.inStock ?? 0, "stock"),
        } satisfies CatalogItem;
      });
      await db.partnerLink.update({ where: lk, data: { catalog: items as Json, catalogAt: at } });
      return;
    }

    case "job.new":
      await newJobFromPartner(shopId, link, d, at);
      return;

    case "job.update": {
      const job = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id: idOf(d.id, "job") } } });
      if (!job || job.side !== "retail" || job.linkId !== link.id) return;
      // Each update is the repair shop's whole view of the job at its time: an older one arriving late changes nothing.
      if (job.snapshotAt && at <= job.snapshotAt) return;
      const status = STATUSES.includes(String(d.status)) ? String(d.status) : job.status;
      const lines = arr(d.lines, 200, "bill").map((x) => {
        const l = obj(x, "bill line");
        return { description: need(l.description, 300, "line"), qty: qtyOf(l.qty ?? 1, "qty"), amountCents: int(l.amountCents, -MAX_MONEY, MAX_MONEY, "amount"), kind: text(l.kind, 20) ?? "SERVICE" };
      });
      const note = text(d.repairNote, 2000);
      let events: Json = job.events as Json;
      if (status !== job.status) events = withEvent(events, { at: at.toISOString(), status });
      if (note && note !== job.repairNote) events = withEvent(events, { at: at.toISOString(), note });
      const repairPaid = optInt(d.repairPaidCents, 0, MAX_MONEY, "paid");
      const paidAt = d.paidAt ? dateOf(d.paidAt, "paidAt") : null;
      // The commission is worked out here from the bill and our copy of the terms, not taken from the partner; once the
      // job is paid it stays as it was.
      const commission = job.paidAt && job.commissionCents != null ? job.commissionCents : repairCommission(lines, terms);
      await db.repairJob.update({
        where: { shopId_id: { shopId, id: job.id } },
        data: {
          status,
          ticketNumber: optInt(d.ticketNumber, 0, 100_000_000, "ticket"),
          totalCents: optInt(d.totalCents, 0, MAX_MONEY, "total"),
          taxCents: optInt(d.taxCents, 0, MAX_MONEY, "tax"),
          lines: lines as Json,
          commissionPct: job.paidAt ? job.commissionPct : terms.repairCommissionPct,
          commissionCents: commission,
          repairNote: note,
          repairPaidCents: repairPaid,
          events,
          ...(paidAt && !job.paidAt ? { paidAt, paidWhere: job.paidCents ? "split" : "repair" } : {}),
          ...(status === "COLLECTED" && !job.pickedUpAt ? { pickedUpAt: at } : {}),
          snapshotAt: at,
        },
      });
      return;
    }

    case "job.reply": {
      const job = await repairSideJob(shopId, link.id, d.id);
      if (!job?.ticketId) return;
      const approval = d.approval === "APPROVED" || d.approval === "DECLINED" ? d.approval : bad("approval must be APPROVED or DECLINED");
      const approvedCents = approval === "APPROVED" ? optInt(d.approvedCents, 0, MAX_MONEY, "approved amount") : null;
      const t = await db.ticket.findUnique({ where: { id: job.ticketId } });
      if (!t) return;
      const who = text(d.name, 80);
      const line = `${at.toLocaleDateString("en-US")} ${link.partnerName}${who ? ` (${who})` : ""}: customer ${approval === "APPROVED" ? `approved${approvedCents != null ? ` up to $${(approvedCents / 100).toFixed(2)}` : ""}` : "declined the work"}${text(d.note, 500) ? ` - ${text(d.note, 500)}` : ""}`;
      await db.$transaction([
        db.ticket.update({
          where: { id: t.id },
          data: {
            ...(approval === "APPROVED" && approvedCents != null ? { approvedCents } : {}),
            ...(approval === "APPROVED" && t.status === "WAITING_CUSTOMER_OK" ? { status: "ON_BENCH" } : {}),
            notes: [t.notes, line].filter(Boolean).join("\n").slice(-20_000),
          },
        }),
        db.repairJob.update({ where: { shopId_id: { shopId, id: job.id } }, data: { approval, approvedCents, events: withEvent(job.events, { at: at.toISOString(), note: line }) } }),
      ]);
      return;
    }

    case "job.paid": {
      const job = await repairSideJob(shopId, link.id, d.id);
      if (!job?.ticketId) return;
      // Paid at the counter once; a repeat (or a changed amount) is recorded as a note, not as more money.
      if (job.paidWhere === "shop" || job.paidWhere === "split") return;
      const amount = int(d.amountCents, 0, MAX_MONEY, "amount");
      const saleNumber = optInt(d.saleNumber, 0, 100_000_000, "sale number");
      await db.$transaction([
        db.payment.create({
          data: { ticketId: job.ticketId, method: "SHOP_COLLECTED", amountCents: amount, paidAt: at, note: `Paid at ${link.partnerName}${saleNumber ? `, sale #${saleNumber}` : ""}` },
        }),
        db.repairJob.update({ where: { shopId_id: { shopId, id: job.id } }, data: { paidCents: amount, paidAt: job.paidAt ?? at, paidWhere: job.repairPaidCents ? "split" : "shop" } }),
      ]);
      return;
    }

    case "job.pickedup": {
      const job = await repairSideJob(shopId, link.id, d.id);
      if (!job?.ticketId) return;
      const t = await db.ticket.findUnique({ where: { id: job.ticketId } });
      // Only a machine that's back and ready can have been picked up.
      if (!t || !READY.includes(t.status)) return;
      await db.$transaction([
        db.ticket.update({
          where: { id: t.id },
          data: {
            status: t.status === "RETURNED_UNREPAIRED" ? t.status : "COLLECTED",
            closedAt: t.closedAt ?? at,
            warrantyUntil: t.status === "RETURNED_UNREPAIRED" ? t.warrantyUntil : (t.warrantyUntil ?? new Date(at.getTime() + shop.warrantyDays * 86400000)),
          },
        }),
        db.repairJob.update({ where: { shopId_id: { shopId, id: job.id } }, data: { pickedUpAt: at } }),
      ]);
      return;
    }

    case "job.cancel": {
      const job = await repairSideJob(shopId, link.id, d.id);
      if (!job?.ticketId) return;
      const t = await db.ticket.findUnique({ where: { id: job.ticketId } });
      if (!t) return;
      const line = `${at.toLocaleDateString("en-US")} ${link.partnerName}: customer took the machine back before pickup${text(d.note, 500) ? ` - ${text(d.note, 500)}` : ""}`;
      await db.ticket.update({
        where: { id: t.id },
        data: {
          notes: [t.notes, line].filter(Boolean).join("\n").slice(-20_000),
          ...(t.status === "AT_SHOP_AWAITING_PICKUP" ? { status: "RETURNED_UNREPAIRED", closedAt: at } : {}),
        },
      });
      return;
    }

    case "order.new": {
      const id = idOf(d.id, "order");
      if (await db.partnerOrder.findUnique({ where: { shopId_id: { shopId, id } } })) return;
      // Each line is rebuilt from our own item: its number, description and our partner price. Lines for items we
      // don't offer are left out, and a different price asked is noted.
      const asked = arr(d.lines, 500, "order").map((x) => obj(x, "order line"));
      const lines: OrderLine[] = [];
      const notes: string[] = [];
      for (const a of asked) {
        const part = await db.part.findFirst({ where: { id: String(a.itemKey ?? ""), shopId, offerToPartners: true, wholesaleCents: { not: null }, consignLinkId: null } });
        if (!part) {
          notes.push(`Left out: ${text(a.partNumber, 80) ?? "an item"} isn't offered any more.`);
          continue;
        }
        const raw = Math.abs(qtyOf(a.qty, "qty"));
        const qty = part.unit === "yd" ? raw : Math.round(raw);
        if (!(qty > 0)) continue;
        if (optInt(a.unitCents, 0, MAX_MONEY, "price") !== part.wholesaleCents) notes.push(`${part.partNumber}: the order showed a different price; your partner price is used.`);
        lines.push({ itemKey: part.id, partNumber: part.partNumber, description: part.description, qty, unitCents: part.wholesaleCents! });
      }
      if (!lines.length) return bad("the order has nothing we offer");
      await db.partnerOrder.create({
        data: {
          id,
          shopId,
          linkId: link.id,
          side: "seller",
          number: text(d.number, 30) ?? id.slice(-6),
          lines: lines as Json,
          totalCents: orderTotal(lines),
          note: [text(d.note, 1000), ...notes].filter(Boolean).join("\n") || null,
          events: [{ at: at.toISOString(), status: "PLACED", note: text(d.name, 80) ? `by ${text(d.name, 80)}` : undefined }] as Json,
          createdAt: at,
        },
      });
      return;
    }

    case "order.update": {
      const o = await db.partnerOrder.findUnique({ where: { shopId_id: { shopId, id: idOf(d.id, "order") } } });
      if (!o || o.linkId !== link.id) return;
      const to = String(d.status ?? "");
      // What each side may do to an order, from where it stands on our copy.
      const legal =
        m.fromSide === "retail"
          ? (o.status === "PLACED" && to === "CANCELLED") || (o.status === "DELIVERED" && to === "RECEIVED")
          : (o.status === "PLACED" && ["ACCEPTED", "DELIVERED", "CANCELLED"].includes(to)) || (o.status === "ACCEPTED" && ["DELIVERED", "CANCELLED"].includes(to));
      const who = m.fromSide === "retail" ? "the sewing shop" : "the repair shop";
      if (!legal) {
        if (to !== o.status) {
          await db.partnerOrder.update({
            where: { shopId_id: { shopId, id: o.id } },
            data: { events: withEvent(o.events, { at: at.toISOString(), note: `${who} marked it ${to.toLowerCase() || "?"}, but it was already ${o.status.toLowerCase()} here: sort it out with them` }) },
          });
        }
        return;
      }
      await db.partnerOrder.update({
        where: { shopId_id: { shopId, id: o.id } },
        data: {
          status: to,
          ...(m.fromSide === "repair" && d.sellerNote !== undefined ? { sellerNote: text(d.sellerNote, 1000) } : {}),
          ...(m.fromSide === "repair" && d.carrier !== undefined ? { carrier: text(d.carrier, 40) } : {}),
          ...(m.fromSide === "repair" && d.tracking !== undefined ? { tracking: text(d.tracking, 80) } : {}),
          ...(to === "DELIVERED" ? { deliveredAt: o.deliveredAt ?? at } : {}),
          ...(to === "RECEIVED" ? { receivedAt: o.receivedAt ?? at } : {}),
          events: withEvent(o.events, { at: at.toISOString(), status: to, note: text(d.eventNote, 500) ?? undefined }),
        },
      });
      return;
    }

    case "consign.place": {
      const items = arr(d.items, 500, "items").map((x) => obj(x, "item"));
      for (const it of items) await receiveConsigned(shopId, link, it, at);
      return;
    }

    case "consign.return": {
      // The sewing shop hands stock back; we put it back on our shelf, never more than is out there.
      for (const x of arr(d.items, 500, "items")) {
        const it = obj(x, "item");
        await consignReturned(shopId, link, idOf(it.itemKey, "item"), Math.abs(qtyOf(it.qty, "qty")), at);
      }
      return;
    }

    case "consign.sale": {
      const id = String(d.id ?? "");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return bad("sale id isn't valid");
      if (await db.consignSale.findUnique({ where: { shopId_id: { shopId, id } } })) return;
      const itemKey = idOf(d.itemKey, "item");
      const qty = qtyOf(d.qty, "qty");
      const priceCents = int(d.priceCents, 0, MAX_MONEY, "price");
      if (qty === 0) return;
      const item = await db.consignItem.findUnique({ where: { shopId_linkId_itemKey: { shopId, linkId: link.id, itemKey } } });
      if (!item) return bad("a consigned sale for an item that isn't on consignment");
      // A negative sale takes back sales we have: a void of one sale on their register ("<sale>-void"), or a customer's
      // return rung up at their counter. Never more than we've counted as sold of this item.
      if (qty < 0) {
        if (id.endsWith("-void")) {
          const original = await db.consignSale.findUnique({ where: { shopId_id: { shopId, id: id.slice(0, -5) } } });
          if (!original || original.itemKey !== itemKey || original.qty < -qty) return bad("a voided consigned sale doesn't match a sale");
        }
        if (item.sold < -qty) return bad("a consigned return is more than was sold");
      }
      const gross = Math.round(qty * priceCents);
      await db.$transaction([
        db.consignSale.create({
          data: {
            id,
            shopId,
            linkId: link.id,
            itemKey,
            qty,
            priceCents,
            saleNumber: optInt(d.saleNumber, 0, 100_000_000, "sale number"),
            soldAt: at,
            shopKeepsCents: Math.round((gross * terms.consignSharePct) / 100),
          },
        }),
        db.consignItem.update({ where: { id: item.id }, data: { sold: { increment: qty } } }),
      ]);
      return;
    }

    case "consign.count": {
      for (const x of arr(d.items, 5000, "items")) {
        const it = obj(x, "item");
        await db.consignItem.updateMany({
          where: { shopId, linkId: link.id, itemKey: idOf(it.itemKey, "item") },
          data: { countedQty: Math.abs(qtyOf(it.onHand, "count")), countedAt: at },
        });
      }
      return;
    }

    case "settle.paid": {
      const id = idOf(d.id, "payment");
      if (await db.settlement.findUnique({ where: { shopId_id: { shopId, id } } })) return;
      await db.settlement.create({
        data: {
          id,
          shopId,
          linkId: link.id,
          periodFrom: dateOf(d.periodFrom, "periodFrom"),
          periodTo: dateOf(d.periodTo, "periodTo"),
          netCents: int(d.netCents, -MAX_MONEY, MAX_MONEY, "amount"),
          summary: storable(d.summary && typeof d.summary === "object" ? d.summary : {}, 5000),
          note: text(d.note, 500),
          byName: text(d.name, 80),
          paidAt: at,
        },
      });
      return;
    }
  }
}

async function repairSideJob(shopId: string, linkId: string, id: unknown) {
  const job = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id: idOf(id, "job") } } });
  return job?.side === "repair" && job.linkId === linkId ? job : null;
}

export function orderLines(v: unknown): OrderLine[] {
  return (Array.isArray(v) ? (v as Obj[]) : [])
    .map((l) => ({
      itemKey: String(l.itemKey ?? ""),
      partNumber: String(l.partNumber ?? ""),
      description: String(l.description ?? ""),
      qty: Math.max(0, Number(l.qty) || 0),
      unitCents: Math.max(0, Math.round(Number(l.unitCents) || 0)),
    }))
    .filter((l) => l.itemKey && l.qty > 0);
}

export const orderTotal = (lines: OrderLine[]) => lines.reduce((a, l) => a + Math.round(l.qty * l.unitCents), 0);

/** A repair shop's machine that a sewing shop took in: a ticket on the repair shop's bench, in its route flow. */
async function newJobFromPartner(shopId: string, link: { id: string; partnerName: string; accountId: string | null; terms: unknown }, d: Obj, at: Date) {
  const id = idOf(d.id, "job");
  if (await db.repairJob.findUnique({ where: { shopId_id: { shopId, id } } })) return;
  const terms = normalizeTerms(link.terms);
  const brand = text(d.brand, 80) ?? "Unknown";
  const model = text(d.model, 80) ?? "Unknown";
  const serial = text(d.serial, 80);
  const tag = text(d.tag, 20) ?? "?";
  const customerName = text(d.customerName, 80) ?? "Customer";
  const photos = arr(d.photos, 8, "photos").map((x) => obj(x, "photo"));
  const existing = serial ? await db.machine.findFirst({ where: { shopId, serial: { equals: serial, mode: "insensitive" }, modelKey: modelKey(model) } }) : null;
  const machine = existing ?? (await db.machine.create({ data: { shopId, brand, model, modelKey: modelKey(model), serial, machineType: text(d.machineType, 60) } }));
  await db.$transaction(async (tx) => {
    // The next free ticket number, taken atomically (a tech may be checking a machine in at the same moment).
    let number = (await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: { increment: 1 } }, select: { nextTicketNumber: true } })).nextTicketNumber - 1;
    while (await tx.ticket.findFirst({ where: { shopId, number }, select: { id: true } })) {
      number = (await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: { increment: 1 } }, select: { nextTicketNumber: true } })).nextTicketNumber - 1;
    }
    const t = await tx.ticket.create({
      data: {
        shopId,
        number,
        machineId: machine.id,
        viaAccountId: link.accountId,
        status: "AT_SHOP_AWAITING_PICKUP",
        serviceRequested: text(d.serviceRequested, 200),
        problem: text(d.problem, 2000),
        preApprovedCents: optInt(d.preApprovedCents, 0, MAX_MONEY, "pre-approved"),
        accessories: strings(d.accessories),
        taxRatePct: (await tx.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true } })).taxRatePct,
        intakeAt: at,
        notes: `From ${link.partnerName}: tag ${tag}, customer ${customerName}.${text(d.note, 1000) ? ` ${text(d.note, 1000)}` : ""}`,
      },
    });
    await tx.repairJob.create({
      data: {
        id,
        shopId,
        linkId: link.id,
        side: "repair",
        tag,
        status: "AT_SHOP_AWAITING_PICKUP",
        machineId: machine.id,
        customerName,
        brand,
        model,
        serial,
        machineType: text(d.machineType, 60),
        problem: text(d.problem, 2000),
        serviceRequested: text(d.serviceRequested, 200),
        accessories: strings(d.accessories),
        preApprovedCents: optInt(d.preApprovedCents, 0, MAX_MONEY, "pre-approved"),
        ticketId: t.id,
        ticketNumber: number,
        commissionPct: terms.repairCommissionPct,
        events: [{ at: at.toISOString(), status: "AT_SHOP_AWAITING_PICKUP", note: `Taken in at ${link.partnerName}` }] as Json,
        createdAt: at,
      },
    });
    for (const p of photos) {
      const mime = String(p.mime ?? "");
      const b64 = String(p.data ?? "");
      if (!IMAGE.has(mime) || !b64 || b64.length > 3_000_000) continue;
      await tx.machinePhoto.create({
        data: { shopId, machineId: machine.id, ticketId: t.id, kind: "CONDITION", caption: text(p.caption, 200) ?? `At intake, ${link.partnerName}`, mime, data: Buffer.from(b64, "base64") },
      });
    }
  });
}

/** A part number not yet used on this shop, from `number` with a suffix when needed. */
async function freePartNumber(shopId: string, number: string, suffix: string) {
  if (!(await db.part.findUnique({ where: { shopId_partNumber: { shopId, partNumber: number } }, select: { id: true } }))) return number;
  for (let i = 1; i < 100; i++) {
    const candidate = `${number} (${suffix}${i > 1 ? ` ${i}` : ""})`;
    if (!(await db.part.findUnique({ where: { shopId_partNumber: { shopId, partNumber: candidate } }, select: { id: true } }))) return candidate;
  }
  return `${number} (${crypto.randomUUID().slice(0, 8)})`;
}

/** Consigned stock arriving on the sewing shop's shelf: its own inventory item, marked as the partner's. */
async function receiveConsigned(shopId: string, link: { id: string; partnerName: string }, it: Obj, at: Date) {
  const itemKey = idOf(it.itemKey, "item");
  const qty = qtyOf(it.qty, "qty");
  if (qty <= 0) return;
  const price = int(it.priceCents, 0, MAX_MONEY, "shelf price");
  const number = need(it.partNumber, 80, "part number");
  const unit = it.unit === "yd" ? "yd" : null;
  // The same item again, or the same number from this partner: one inventory entry.
  let part =
    (await db.part.findFirst({ where: { shopId, consignLinkId: link.id, consignItemKey: itemKey } })) ??
    (await db.part.findFirst({ where: { shopId, consignLinkId: link.id, OR: [{ partNumber: number }, { altNumbers: { has: number } }] } }));
  if (!part) {
    const partNumber = await freePartNumber(shopId, number, link.partnerName.slice(0, 20));
    const kind = KINDS.includes(String(it.kind)) ? String(it.kind) : "ACCESSORY";
    part = await db.part.create({
      data: {
        shopId,
        partNumber,
        description: text(it.description, 300) ?? number,
        brand: text(it.brand, 80),
        kind: kind as "ACCESSORY",
        unit,
        priceCents: price,
        altNumbers: partNumber !== number ? [number] : [],
        numberKeys: [...new Set([partNumber, number].map((x) => x.toUpperCase().replace(/[^A-Z0-9]/g, "")))].filter((k) => k.length >= 3),
        consignLinkId: link.id,
        consignItemKey: itemKey,
        notes: `On consignment from ${link.partnerName}`,
      },
    });
  }
  await db.$transaction([
    db.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: qty }, priceCents: price || part.priceCents, consignItemKey: itemKey } }),
    db.stockMove.create({ data: { shopId, partId: part.id, qty, reason: "CONSIGNED", note: `Consignment from ${link.partnerName}`, createdAt: at } }),
    db.consignItem.upsert({
      where: { shopId_linkId_itemKey: { shopId, linkId: link.id, itemKey } },
      create: { shopId, linkId: link.id, side: "holder", itemKey, partId: part.id, partNumber: part.partNumber, description: part.description, priceCents: price, placed: qty },
      update: { placed: { increment: qty }, priceCents: price || undefined, partId: part.id },
    }),
  ]);
}

/**
 * Consigned stock going back to the repair shop, recorded by the sewing shop (which hands it over) and applied on both
 * sides; never more than is still out on the shelf.
 */
export async function consignReturned(shopId: string, link: { id: string; side: string; partnerName: string }, itemKey: string, qty: number, at: Date) {
  if (!(qty > 0)) return 0;
  return db.$transaction(async (tx) => {
    const item = await tx.consignItem.findUnique({ where: { shopId_linkId_itemKey: { shopId, linkId: link.id, itemKey } } });
    if (!item) return 0;
    const onShelf = Math.max(0, item.placed - item.sold - item.returned);
    const back = Math.min(qty, onShelf);
    if (!(back > 0)) return 0;
    // Only counts if the shelf still had it when this ran (two returns at once can't both take the same units).
    const took = await tx.consignItem.updateMany({ where: { id: item.id, returned: item.returned }, data: { returned: { increment: back } } });
    if (!took.count) return 0;
    const partId = link.side === "repair" ? itemKey : item.partId;
    const part = partId ? await tx.part.findFirst({ where: { id: partId, shopId } }) : null;
    const sign = link.side === "repair" ? 1 : -1; // back on the repair shop's shelf; off the sewing shop's
    if (part) {
      await tx.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: sign * back } } });
      await tx.stockMove.create({
        data: { shopId, partId: part.id, qty: sign * back, reason: "CONSIGNED", note: link.side === "repair" ? `Back from ${link.partnerName}` : `Returned to ${link.partnerName}`, createdAt: at },
      });
    }
    return back;
  });
}

// ---------- statements ----------

export type Statement = Awaited<ReturnType<typeof statementFor>>;

/** What a paid job means between the shops: the sewing shop owes what it collected, less its commission. */
function jobOwed(j: { paidCents: number | null; commissionCents: number | null }) {
  return (j.paidCents ?? 0) - (j.commissionCents ?? 0);
}

/** The sewing shop's share of a consigned sale: fixed when it was sold (older sales without it use today's terms). */
function consignShare(x: { qty: number; priceCents: number; shopKeepsCents: number | null }, terms: PartnerTerms) {
  const gross = Math.round(x.qty * x.priceCents);
  const keeps = x.shopKeepsCents ?? Math.round((gross * terms.consignSharePct) / 100);
  return { gross, keeps, owed: gross - keeps };
}

/**
 * What each shop owes the other for [from, to): repairs fully paid in that period (the sewing shop owes what it
 * collected at its counter less its commission; when the customer paid the repair shop, the repair shop owes the
 * commission), consigned stock sold (the sewing shop keeps its share) and partner orders delivered. Plus the running
 * balance: everything ever owed less settlements. netCents > 0: the sewing shop pays the repair shop.
 */
export async function statementFor(shopId: string, linkId: string, from: Date, to: Date) {
  const link = await partnerLink(shopId, linkId);
  const terms = normalizeTerms(link.terms);
  const range = { gte: from, lt: to };
  const [jobs, sales, orders, settlements] = await Promise.all([
    db.repairJob.findMany({ where: { shopId, linkId, paidAt: range }, orderBy: { paidAt: "asc" } }),
    db.consignSale.findMany({ where: { shopId, linkId, soldAt: range }, orderBy: { soldAt: "asc" } }),
    db.partnerOrder.findMany({ where: { shopId, linkId, deliveredAt: range, status: { in: ["DELIVERED", "RECEIVED"] } }, orderBy: { deliveredAt: "asc" } }),
    db.settlement.findMany({ where: { shopId, linkId, paidAt: range }, orderBy: { paidAt: "asc" } }),
  ]);
  const repairs = jobs.map((j) => ({
    id: j.id,
    tag: j.tag,
    ticketNumber: j.ticketNumber,
    customerName: j.customerName,
    machine: `${j.brand} ${j.model}`,
    paidAt: j.paidAt!,
    paidWhere: j.paidWhere ?? "shop",
    totalCents: j.totalCents ?? (j.paidCents ?? 0) + (j.repairPaidCents ?? 0),
    shopCollectedCents: j.paidCents ?? 0,
    commissionCents: j.commissionCents ?? 0,
    // + the sewing shop owes the repair shop
    owedCents: jobOwed(j),
  }));
  const items = await db.consignItem.findMany({ where: { shopId, linkId } });
  const itemName = new Map(items.map((i) => [i.itemKey, `${i.partNumber} ${i.description}`]));
  const consign = sales.map((x) => {
    const c = consignShare(x, terms);
    return { id: x.id, item: itemName.get(x.itemKey) ?? x.itemKey, qty: x.qty, priceCents: x.priceCents, soldAt: x.soldAt, grossCents: c.gross, shopKeepsCents: c.keeps, owedCents: c.owed };
  });
  const orderRows = orders.map((o) => ({ id: o.id, number: o.number, deliveredAt: o.deliveredAt!, totalCents: o.totalCents, owedCents: o.totalCents }));
  const sum = (xs: { owedCents: number }[]) => xs.reduce((a, x) => a + x.owedCents, 0);
  const periodNet = sum(repairs) + sum(consign) + sum(orderRows);
  const balance = await runningBalance(shopId, linkId, terms);
  return {
    link,
    terms,
    from,
    to,
    repairs,
    consign,
    orders: orderRows,
    settlements,
    totals: {
      repairsCents: sum(repairs),
      consignCents: sum(consign),
      ordersCents: sum(orderRows),
      periodNetCents: periodNet,
      paidInPeriodCents: settlements.reduce((a, x) => a + x.netCents, 0),
    },
    balanceCents: balance,
  };
}

/** Everything owed since the partnership began, less what was settled. + = the sewing shop owes the repair shop. */
async function runningBalance(shopId: string, linkId: string, terms: PartnerTerms) {
  const [jobs, sales, orders, settled] = await Promise.all([
    db.repairJob.findMany({ where: { shopId, linkId, paidAt: { not: null } }, select: { paidCents: true, commissionCents: true } }),
    db.consignSale.findMany({ where: { shopId, linkId }, select: { qty: true, priceCents: true, shopKeepsCents: true } }),
    db.partnerOrder.aggregate({ where: { shopId, linkId, status: { in: ["DELIVERED", "RECEIVED"] } }, _sum: { totalCents: true } }),
    db.settlement.aggregate({ where: { shopId, linkId }, _sum: { netCents: true } }),
  ]);
  const repairs = jobs.reduce((a, j) => a + jobOwed(j), 0);
  const consign = sales.reduce((a, x) => a + consignShare(x, terms).owed, 0);
  return repairs + consign + (orders._sum.totalCents ?? 0) - (settled._sum.netCents ?? 0);
}

/** Month boundaries for statements, in the shop's time zone: "2026-09" -> [Sep 1, Oct 1). */
export function monthPeriod(month?: string | null, timeZone = "America/New_York") {
  const now = zonedParts(new Date(), timeZone);
  const m = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  const y = m ? Number(m[1]) : now.year;
  const mo = m ? Number(m[2]) - 1 : now.month - 1;
  const from = zonedMidnight(y, mo, 1, timeZone);
  const to = zonedMidnight(y, mo + 1, 1, timeZone);
  const key = (yy: number, mm: number) => {
    const d = new Date(Date.UTC(yy, mm, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  return { from, to, month: key(y, mo), prev: key(y, mo - 1), next: key(y, mo + 1) };
}

/** Year, month (1-12) and day of an instant, as the clock on the wall in `timeZone` shows it. */
export function zonedParts(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** The instant a day starts in `timeZone` (month is 0-based and may overflow, like Date). */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string) {
  const guess = new Date(Date.UTC(year, month, day));
  // How far the zone's wall clock is from UTC at that moment, applied twice to settle around a DST change.
  let t = guess.getTime();
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t));
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    t = guess.getTime() - (wall - t);
  }
  return new Date(t);
}
