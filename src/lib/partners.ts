import "server-only";
// Partnerships between a repair shop (StitchBench) and the sewing / quilt shops (StitchShop) that work with it.
// Both shops keep their own copy of each shared record (repair jobs, orders, consignment, settlements) under the same
// id; they stay in step by sending each other messages through the hub (PartnerOutbox -> hub -> the other install).
//
// Who sends what:
//   sewing shop -> repair shop : job.new, job.reply, job.paid, job.pickedup, job.cancel, order.new, order.update
//                                (received/cancelled), consign.sale, consign.count, consign.return
//   repair shop -> sewing shop : job.update, catalog, order.update, consign.place, consign.return
//   either                     : terms.propose, terms.accept, settle.paid
//   hub                        : link.created, link.ended
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { hubFetch, hubState } from "@/lib/hub";
import { lineTotal } from "@/lib/ticket-math";
import { modelKey } from "@/lib/format";
import { normalizeTerms, repairCommission, termsKey, type Accepted, type PartnerTerms } from "@/lib/partner-terms";
import { Prisma } from "@/generated/prisma/client";

export const DEFAULT_HUB_URL = (process.env.DEFAULT_HUB_URL ?? "https://stitchhub-production.up.railway.app").replace(/\/+$/, "");
const FINAL = ["COLLECTED", "ABANDONED", "RETURNED_UNREPAIRED"];
const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);

type Json = Prisma.InputJsonValue;
type Obj = Record<string, unknown>;
const s = (v: unknown) => (v == null || v === "" ? null : String(v));
const n = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const arr = (v: unknown) => (Array.isArray(v) ? (v as Obj[]) : []);
const strings = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 200)).slice(0, 50) : []);

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
    try {
      const j = JSON.parse(Buffer.from(t.slice(14).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { url?: string; code?: string };
      if (j.code && j.url) return { code: j.code, url: j.url.replace(/\/+$/, "") };
    } catch {
      /* fall through */
    }
    throw new UserError("That partner code is damaged. Copy it again.");
  }
  const code = t.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 12) throw new UserError("A partner code has 12 letters and numbers, like 7KQP-M2XH-9TRD.");
  return { code, url: null };
}

export function longPartnerCode(url: string, code: string) {
  return "stitchpartner:" + Buffer.from(JSON.stringify({ url, code })).toString("base64url");
}

/** This shop makes a code for the shop it wants to partner with. Needs the hub (Settings -> Community hub). */
export async function createPartnerInvite(shopId: string, shopName: string, side: "repair" | "retail", terms: PartnerTerms) {
  const r = (await (await hubFetch("/v1/partners/invites", { method: "POST", json: { shopRef: shopId, shopName, side, terms } })).json()) as {
    code: string;
    expiresAt: string;
  };
  // Start listening for the partner redeeming it.
  await db.hubState.update({ where: { id: 1 }, data: { partnerCursor: (await hubState())?.partnerCursor ?? "0" } });
  const s0 = await hubState();
  return { ...r, long: longPartnerCode(s0!.url!, r.code) };
}

/** Enter a partner code: on the hub this install already uses, or (not on any hub yet) join the code's hub for partners only. */
export async function redeemPartnerCode(shopId: string, shopName: string, contact: string | null, text: string) {
  const { code, url } = parsePartnerCode(text);
  const st = await hubState();
  let out: { link: HubPartnerLink; side: "repair" | "retail" };
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
    const data = { url: base, hubName: j.hubName, installId: j.installId, installKey: j.installKey, joinedAt: new Date(), scope: "partner", partnerCursor: "0" };
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
  const l = (await (await hubFetch(`/v1/partners/links/${linkId}/end`, { method: "POST", json: { shopRef: shopId, note } })).json()) as HubPartnerLink;
  await db.partnerLink.update({ where: { shopId_id: { shopId, id: linkId } }, data: { status: l.status, endedAt: l.endedAt ? new Date(l.endedAt) : new Date() } });
}

/** The trade account a partner sewing shop's machines come in under (made the first time). */
async function tradeAccountFor(shopId: string, name: string, terms: PartnerTerms) {
  const found = await db.customer.findFirst({ where: { shopId, kind: "TRADE", name: { equals: name, mode: "insensitive" } } });
  if (found) {
    await db.customer.update({ where: { id: found.id }, data: { commissionPct: terms.repairCommissionPct } });
    return found.id;
  }
  const c = await db.customer.create({
    data: {
      shopId,
      kind: "TRADE",
      name,
      commissionPct: terms.repairCommissionPct,
      routeDay: terms.pickupDay,
      notes: "Partner shop: machines, orders and consignment come through the partner link (Partners).",
    },
  });
  return c.id;
}

export async function saveLinkFromHub(shopId: string, side: "repair" | "retail", l: HubPartnerLink) {
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
  // Linked again after ending: the new invite's terms start a new version that both accept again.
  const relinked = existing.status === "ENDED" && l.status === "ACTIVE";
  await db.partnerLink.update({
    where,
    data: {
      partnerName,
      status: l.status,
      endedAt,
      ...(relinked ? { terms, termsVersion: existing.termsVersion + 1, accepted: {}, proposedTerms: Prisma.DbNull, proposedBy: null } : {}),
    },
  });
}

// ---------- terms ----------

export async function proposeTerms(shopId: string, linkId: string, terms: PartnerTerms, byName: string) {
  const l = await partnerLink(shopId, linkId);
  const version = l.termsVersion + 1;
  const at = new Date().toISOString();
  await db.$transaction(async (tx) => {
    await tx.partnerLink.update({
      where: { shopId_id: { shopId, id: linkId } },
      data: { proposedTerms: { version, terms, by: { name: byName, at } } as Json, proposedBy: l.side },
    });
    await sendToPartner(shopId, linkId, "terms.propose", { version, terms, name: byName, at }, tx);
  });
}

/** This shop accepts the current terms, or the change the partner proposed. */
export async function acceptTerms(shopId: string, linkId: string, byName: string) {
  const l = await partnerLink(shopId, linkId);
  const at = new Date().toISOString();
  const accepted = { ...((l.accepted as Accepted) ?? {}) };
  const prop = l.proposedTerms as { version: number; terms: PartnerTerms; by: { name: string; at: string } } | null;
  let data: Prisma.PartnerLinkUpdateInput;
  let version = l.termsVersion;
  if (prop && l.proposedBy !== l.side) {
    version = prop.version;
    const other = l.side === "repair" ? "retail" : "repair";
    const next: Accepted = { [other]: { ...prop.by, version }, [l.side]: { name: byName, at, version } };
    data = { terms: normalizeTerms(prop.terms), termsVersion: version, accepted: next as Json, proposedTerms: Prisma.DbNull, proposedBy: null };
  } else {
    accepted[l.side as "repair" | "retail"] = { name: byName, at, version };
    data = { accepted: accepted as Json };
  }
  await db.$transaction(async (tx) => {
    await tx.partnerLink.update({ where: { shopId_id: { shopId, id: linkId } }, data });
    await sendToPartner(shopId, linkId, "terms.accept", { version, name: byName, at, key: termsKey(normalizeTerms(prop?.terms ?? l.terms)) }, tx);
  });
}

// ---------- repair side: what the sewing shop sees of each job, and the catalog ----------

type TicketForJob = Prisma.TicketGetPayload<{ include: { lines: true; payments: true } }>;

function jobSnapshot(job: { id: string; repairNote: string | null; commissionPct: number }, t: TicketForJob, terms: PartnerTerms) {
  const lines: JobLine[] = t.lines.map((l) => ({ description: l.description, qty: l.qty, amountCents: lineTotal(l), kind: l.kind }));
  const subtotal = lines.reduce((a, l) => a + l.amountCents, 0);
  const taxable = t.lines.filter((l) => l.taxable).reduce((a, l) => a + lineTotal(l), 0);
  const tax = Math.round((taxable * t.taxRatePct) / 100);
  const direct = t.payments.filter((p) => p.method !== "SHOP_COLLECTED");
  return {
    id: job.id,
    status: t.status,
    ticketNumber: t.number,
    lines,
    totalCents: subtotal + tax,
    taxCents: tax,
    commissionPct: terms.repairCommissionPct,
    commissionCents: repairCommission(lines, terms),
    repairNote: job.repairNote,
    paidCents: direct.length ? direct.reduce((a, p) => a + p.amountCents, 0) : null,
    paidAt: direct.length ? direct[direct.length - 1].paidAt.toISOString() : null,
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
    const t = await db.ticket.findUnique({ where: { id: job.ticketId! }, include: { lines: { orderBy: { createdAt: "asc" } }, payments: true } });
    const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId: job.shopId, id: job.linkId } } });
    if (!t || !link) continue;
    const snap = jobSnapshot(job, t, normalizeTerms(link.terms));
    const h = hash(snap);
    if (h === job.sentHash) continue;
    const events = (job.events as JobEvent[]) ?? [];
    if (snap.status !== job.status) events.push({ at: new Date().toISOString(), status: snap.status });
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
          events: events as Json,
          sentHash: h,
          ...(snap.paidCents && job.paidWhere !== "shop" ? { paidCents: snap.paidCents, paidAt: new Date(snap.paidAt!), paidWhere: "repair" } : {}),
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

async function pushOutbox() {
  const rows = await db.partnerOutbox.findMany({ where: { sentAt: null, tries: { lt: 50 } }, orderBy: { createdAt: "asc" }, take: 200 });
  let sent = 0;
  for (const m of rows) {
    try {
      await hubFetch(`/v1/partners/links/${m.linkId}/messages`, { method: "POST", json: { id: m.id, shopRef: m.shopId, type: m.type, data: m.data } });
      await db.partnerOutbox.update({ where: { id: m.id }, data: { sentAt: new Date(), error: null } });
      sent++;
    } catch (e) {
      await db.partnerOutbox.update({ where: { id: m.id }, data: { tries: { increment: 1 }, error: e instanceof Error ? e.message : String(e) } });
      // Keep the order: a later message mustn't overtake one that failed (an update before its job).
      break;
    }
  }
  return sent;
}

type HubMessage = {
  seq: string;
  id: string;
  linkId: string;
  fromSide: "repair" | "retail" | "hub";
  toSide: "repair" | "retail";
  toShopRef: string;
  type: string;
  data: Obj;
  createdAt: string;
};

async function pullMessages(cursor: string) {
  let since = cursor;
  let received = 0;
  for (let page = 0; page < 50; page++) {
    const r = (await (await hubFetch(`/v1/partners/messages?since=${since}&limit=200`)).json()) as { messages: HubMessage[]; next: string; more: boolean };
    for (const m of r.messages) {
      const key = `${m.linkId}:${m.fromSide}:${m.id}:${m.toSide}`;
      const seen = await db.partnerSeen.findUnique({ where: { shopId_key: { shopId: m.toShopRef, key } } });
      if (!seen) {
        try {
          await applyMessage(m);
        } catch (e) {
          // Stop here so nothing is skipped; the next sync tries this message again.
          await db.hubState.update({ where: { id: 1 }, data: { partnerCursor: since } });
          throw new Error(`partner message ${m.type} from ${m.fromSide}: ${e instanceof Error ? e.message : e}`);
        }
        if (await db.shop.findUnique({ where: { id: m.toShopRef }, select: { id: true } })) {
          await db.partnerSeen.create({ data: { shopId: m.toShopRef, key } }).catch(() => {});
        }
        received++;
      }
      since = m.seq;
    }
    await db.hubState.update({ where: { id: 1 }, data: { partnerCursor: r.next } });
    since = r.next;
    if (!r.more) break;
  }
  return received;
}

export type PartnerSyncResult = { sent: number; received: number } | { skipped: true };

async function doPartnerSync(): Promise<PartnerSyncResult> {
  const st = await hubState();
  if (!st?.url || !st.installKey) return { skipped: true };
  // Nothing to listen for until a code is made or used here.
  if (st.partnerCursor == null && !(await db.partnerLink.count())) return { skipped: true };
  try {
    await pushJobUpdates();
    await pushCatalogs();
    const sent = await pushOutbox();
    const received = await pullMessages(st.partnerCursor ?? "0");
    // Anything the messages just caused (a new job's first update) goes out now rather than next time.
    await pushJobUpdates();
    const more = await pushOutbox();
    await db.hubState.update({ where: { id: 1 }, data: { partnerSyncAt: new Date(), partnerError: null } });
    return { sent: sent + more, received };
  } catch (e) {
    await db.hubState.update({ where: { id: 1 }, data: { partnerError: e instanceof Error ? e.message : String(e) } }).catch(() => {});
    throw e;
  }
}

let running: Promise<PartnerSyncResult> | null = null;

export function syncPartners(): Promise<PartnerSyncResult> {
  running ??= doPartnerSync().finally(() => {
    running = null;
  });
  return running;
}

// ---------- applying what the partner sent ----------

async function applyMessage(m: HubMessage) {
  const shop = await db.shop.findUnique({ where: { id: m.toShopRef } });
  if (!shop) return; // that company isn't on this install any more
  const shopId = shop.id;
  const d = m.data ?? {};
  if (m.type === "link.created") return saveLinkFromHub(shopId, m.toSide, d as unknown as HubPartnerLink);
  let link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: m.linkId } } });
  if (!link) {
    // Missed the link.created (a restored backup): ask the hub for the link.
    const links = (await (await hubFetch("/v1/partners/links")).json()) as (HubPartnerLink & { side: "repair" | "retail"; shopRef: string })[];
    const l = links.find((x) => x.id === m.linkId && x.shopRef === shopId);
    if (!l) return;
    await saveLinkFromHub(shopId, l.side, l);
    link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: m.linkId } } });
    if (!link) return;
  }
  const lk = { shopId_id: { shopId, id: link.id } };
  const at = s(d.at) ? new Date(String(d.at)) : new Date(m.createdAt);

  switch (m.type) {
    case "link.ended":
      await db.partnerLink.update({ where: lk, data: { status: "ENDED", endedAt: at } });
      return;

    case "terms.propose": {
      const version = n(d.version) ?? link.termsVersion + 1;
      if (version <= link.termsVersion) return;
      await db.partnerLink.update({
        where: lk,
        data: { proposedTerms: { version, terms: normalizeTerms(d.terms), by: { name: s(d.name) ?? "", at: at.toISOString() } } as Json, proposedBy: m.fromSide },
      });
      return;
    }

    case "terms.accept": {
      const version = n(d.version) ?? link.termsVersion;
      const who = { name: s(d.name) ?? "", at: at.toISOString(), version };
      const prop = link.proposedTerms as { version: number; terms: PartnerTerms; by: { name: string; at: string } } | null;
      if (prop && prop.version === version && link.proposedBy === link.side) {
        // They accepted the change we offered.
        const accepted: Accepted = { [link.side]: { ...prop.by, version }, [m.fromSide]: who };
        await db.partnerLink.update({
          where: lk,
          data: { terms: normalizeTerms(prop.terms), termsVersion: version, accepted: accepted as Json, proposedTerms: Prisma.DbNull, proposedBy: null },
        });
      } else if (version === link.termsVersion) {
        await db.partnerLink.update({ where: lk, data: { accepted: { ...((link.accepted as Accepted) ?? {}), [m.fromSide]: who } as Json } });
      }
      return;
    }

    case "catalog":
      if (link.side !== "retail") return;
      await db.partnerLink.update({ where: lk, data: { catalog: arr(d.items) as Json, catalogAt: at } });
      return;

    case "job.new":
      if (link.side === "repair") await newJobFromPartner(shop, link, d, at);
      return;

    case "job.update": {
      if (link.side !== "retail") return;
      const job = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id: String(d.id) } } });
      if (!job) return;
      const status = s(d.status) ?? job.status;
      const events = (job.events as JobEvent[]) ?? [];
      if (status !== job.status) events.push({ at: at.toISOString(), status });
      if (s(d.repairNote) && s(d.repairNote) !== job.repairNote) events.push({ at: at.toISOString(), note: String(d.repairNote) });
      const paidDirect = n(d.paidCents);
      await db.repairJob.update({
        where: { shopId_id: { shopId, id: job.id } },
        data: {
          status,
          ticketNumber: n(d.ticketNumber),
          totalCents: n(d.totalCents),
          taxCents: n(d.taxCents),
          lines: arr(d.lines) as Json,
          commissionPct: n(d.commissionPct) ?? job.commissionPct,
          commissionCents: n(d.commissionCents),
          repairNote: s(d.repairNote),
          events: events as Json,
          ...(paidDirect && job.paidWhere !== "shop" ? { paidCents: paidDirect, paidAt: s(d.paidAt) ? new Date(String(d.paidAt)) : at, paidWhere: "repair" } : {}),
          ...(status === "COLLECTED" && !job.pickedUpAt ? { pickedUpAt: at } : {}),
        },
      });
      return;
    }

    case "job.reply": {
      const job = await repairSideJob(shopId, d.id);
      if (!job?.ticketId) return;
      const approval = d.approval === "DECLINED" ? "DECLINED" : "APPROVED";
      const approvedCents = n(d.approvedCents);
      const t = await db.ticket.findUnique({ where: { id: job.ticketId } });
      if (!t) return;
      const who = s(d.name) ? ` (${d.name})` : "";
      const line = `${at.toLocaleDateString("en-US")} ${link.partnerName}${who}: customer ${approval === "APPROVED" ? `approved${approvedCents != null ? ` up to $${(approvedCents / 100).toFixed(2)}` : ""}` : "declined the work"}${s(d.note) ? ` - ${d.note}` : ""}`;
      await db.$transaction([
        db.ticket.update({
          where: { id: t.id },
          data: {
            ...(approval === "APPROVED" && approvedCents != null ? { approvedCents } : {}),
            ...(approval === "APPROVED" && t.status === "WAITING_CUSTOMER_OK" ? { status: "ON_BENCH" } : {}),
            notes: [t.notes, line].filter(Boolean).join("\n"),
          },
        }),
        db.repairJob.update({
          where: { shopId_id: { shopId, id: job.id } },
          data: { approval, approvedCents, events: [...((job.events as JobEvent[]) ?? []), { at: at.toISOString(), note: line }] as Json },
        }),
      ]);
      return;
    }

    case "job.paid": {
      const job = await repairSideJob(shopId, d.id);
      if (!job?.ticketId) return;
      const amount = n(d.amountCents) ?? 0;
      await db.$transaction([
        db.payment.create({
          data: { ticketId: job.ticketId, method: "SHOP_COLLECTED", amountCents: amount, paidAt: at, note: `Paid at ${link.partnerName}${d.saleNumber ? `, sale #${d.saleNumber}` : ""}` },
        }),
        db.repairJob.update({ where: { shopId_id: { shopId, id: job.id } }, data: { paidCents: amount, paidAt: at, paidWhere: "shop" } }),
      ]);
      return;
    }

    case "job.pickedup": {
      const job = await repairSideJob(shopId, d.id);
      if (!job?.ticketId) return;
      const t = await db.ticket.findUnique({ where: { id: job.ticketId } });
      if (!t) return;
      await db.$transaction([
        db.ticket.update({
          where: { id: t.id },
          data: {
            status: "COLLECTED",
            closedAt: t.closedAt ?? at,
            warrantyUntil: t.warrantyUntil ?? new Date(at.getTime() + shop.warrantyDays * 86400000),
          },
        }),
        db.repairJob.update({ where: { shopId_id: { shopId, id: job.id } }, data: { pickedUpAt: at } }),
      ]);
      return;
    }

    case "job.cancel": {
      const job = await repairSideJob(shopId, d.id);
      if (!job?.ticketId) return;
      const t = await db.ticket.findUnique({ where: { id: job.ticketId } });
      if (!t) return;
      const line = `${at.toLocaleDateString("en-US")} ${link.partnerName}: customer took the machine back before pickup${s(d.note) ? ` - ${d.note}` : ""}`;
      await db.ticket.update({
        where: { id: t.id },
        data: {
          notes: [t.notes, line].filter(Boolean).join("\n"),
          ...(t.status === "AT_SHOP_AWAITING_PICKUP" ? { status: "RETURNED_UNREPAIRED", closedAt: at } : {}),
        },
      });
      return;
    }

    case "order.new": {
      if (link.side !== "repair") return;
      const id = String(d.id);
      if (await db.partnerOrder.findUnique({ where: { shopId_id: { shopId, id } } })) return;
      const lines = orderLines(d.lines);
      await db.partnerOrder.create({
        data: {
          id,
          shopId,
          linkId: link.id,
          side: "seller",
          number: s(d.number) ?? id.slice(-6),
          lines: lines as Json,
          totalCents: orderTotal(lines),
          note: s(d.note),
          events: [{ at: at.toISOString(), status: "PLACED", note: s(d.name) ? `by ${d.name}` : undefined }] as Json,
          createdAt: at,
        },
      });
      return;
    }

    case "order.update": {
      const o = await db.partnerOrder.findUnique({ where: { shopId_id: { shopId, id: String(d.id) } } });
      if (!o) return;
      const status = s(d.status) ?? o.status;
      const lines = d.lines ? orderLines(d.lines) : (o.lines as OrderLine[]);
      await db.partnerOrder.update({
        where: { shopId_id: { shopId, id: o.id } },
        data: {
          status,
          lines: lines as Json,
          totalCents: orderTotal(lines),
          sellerNote: d.sellerNote !== undefined ? s(d.sellerNote) : o.sellerNote,
          carrier: d.carrier !== undefined ? s(d.carrier) : o.carrier,
          tracking: d.tracking !== undefined ? s(d.tracking) : o.tracking,
          deliveredAt: status === "DELIVERED" ? (o.deliveredAt ?? at) : o.deliveredAt,
          receivedAt: status === "RECEIVED" ? (o.receivedAt ?? at) : o.receivedAt,
          events: [...((o.events as JobEvent[]) ?? []), { at: at.toISOString(), status, note: s(d.eventNote) ?? undefined }] as Json,
        },
      });
      return;
    }

    case "consign.place": {
      if (link.side !== "retail") return;
      for (const it of arr(d.items)) await receiveConsigned(shopId, link, it, at);
      return;
    }

    case "consign.return": {
      // Stock coming off the sewing shop's shelf, back to the repair shop (either side can record it).
      for (const it of arr(d.items)) await consignReturned(shopId, link, String(it.itemKey), n(it.qty) ?? 0, at);
      return;
    }

    case "consign.sale": {
      if (link.side !== "repair") return;
      const id = String(d.id);
      if (await db.consignSale.findUnique({ where: { shopId_id: { shopId, id } } })) return;
      const qty = n(d.qty) ?? 0;
      const itemKey = String(d.itemKey);
      await db.$transaction([
        db.consignSale.create({
          data: { id, shopId, linkId: link.id, itemKey, qty, priceCents: n(d.priceCents) ?? 0, saleNumber: n(d.saleNumber), soldAt: at },
        }),
        db.consignItem.updateMany({ where: { shopId, linkId: link.id, itemKey }, data: { sold: { increment: qty } } }),
      ]);
      return;
    }

    case "consign.count": {
      if (link.side !== "repair") return;
      for (const it of arr(d.items)) {
        await db.consignItem.updateMany({ where: { shopId, linkId: link.id, itemKey: String(it.itemKey) }, data: { countedQty: n(it.onHand), countedAt: at } });
      }
      return;
    }

    case "settle.paid": {
      const id = String(d.id);
      if (await db.settlement.findUnique({ where: { shopId_id: { shopId, id } } })) return;
      await db.settlement.create({
        data: {
          id,
          shopId,
          linkId: link.id,
          periodFrom: new Date(String(d.periodFrom)),
          periodTo: new Date(String(d.periodTo)),
          netCents: n(d.netCents) ?? 0,
          summary: (d.summary ?? {}) as Json,
          note: s(d.note),
          byName: s(d.name),
          paidAt: at,
        },
      });
      return;
    }
    default:
      // A newer version of the app on the other side; nothing to do here.
      console.warn(`partner message type ${m.type} isn't known to this version`);
  }
}

async function repairSideJob(shopId: string, id: unknown) {
  const job = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id: String(id) } } });
  return job?.side === "repair" ? job : null;
}

export function orderLines(v: unknown): OrderLine[] {
  return arr(v)
    .map((l) => ({
      itemKey: String(l.itemKey ?? ""),
      partNumber: String(l.partNumber ?? ""),
      description: String(l.description ?? ""),
      qty: Math.max(0, n(l.qty) ?? 0),
      unitCents: Math.max(0, Math.round(n(l.unitCents) ?? 0)),
    }))
    .filter((l) => l.itemKey && l.qty > 0);
}

export const orderTotal = (lines: OrderLine[]) => lines.reduce((a, l) => a + Math.round(l.qty * l.unitCents), 0);

/** A repair shop's machine that a sewing shop took in: a ticket on the repair shop's bench, in its route flow. */
async function newJobFromPartner(
  shop: { id: string },
  link: { id: string; partnerName: string; accountId: string | null; terms: unknown },
  d: Obj,
  at: Date,
) {
  const shopId = shop.id;
  const id = String(d.id);
  if (await db.repairJob.findUnique({ where: { shopId_id: { shopId, id } } })) return;
  const terms = normalizeTerms(link.terms);
  const brand = s(d.brand) ?? "Unknown";
  const model = s(d.model) ?? "Unknown";
  const serial = s(d.serial);
  const existing = serial ? await db.machine.findFirst({ where: { shopId, serial: { equals: serial, mode: "insensitive" }, modelKey: modelKey(model) } }) : null;
  const machine =
    existing ??
    (await db.machine.create({ data: { shopId, brand, model, modelKey: modelKey(model), serial, machineType: s(d.machineType) } }));
  const tag = s(d.tag) ?? "?";
  const customerName = s(d.customerName) ?? "Customer";
  await db.$transaction(async (tx) => {
    const sh = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
    let number = sh.nextTicketNumber;
    while (await tx.ticket.findFirst({ where: { shopId, number } })) number++;
    const t = await tx.ticket.create({
      data: {
        shopId,
        number,
        machineId: machine.id,
        viaAccountId: link.accountId,
        status: "AT_SHOP_AWAITING_PICKUP",
        serviceRequested: s(d.serviceRequested),
        problem: s(d.problem),
        preApprovedCents: n(d.preApprovedCents),
        accessories: strings(d.accessories),
        taxRatePct: sh.taxRatePct,
        intakeAt: at,
        notes: `From ${link.partnerName}: tag ${tag}, customer ${customerName}.${s(d.note) ? ` ${d.note}` : ""}`,
      },
    });
    await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: number + 1 } });
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
        machineType: s(d.machineType),
        problem: s(d.problem),
        serviceRequested: s(d.serviceRequested),
        accessories: strings(d.accessories),
        preApprovedCents: n(d.preApprovedCents),
        ticketId: t.id,
        ticketNumber: number,
        commissionPct: terms.repairCommissionPct,
        events: [{ at: at.toISOString(), status: "AT_SHOP_AWAITING_PICKUP", note: `Taken in at ${link.partnerName}` }] as Json,
        createdAt: at,
      },
    });
    for (const p of arr(d.photos).slice(0, 8)) {
      const mime = String(p.mime ?? "");
      const b64 = String(p.data ?? "");
      if (!IMAGE.has(mime) || !b64 || b64.length > 3_000_000) continue;
      await tx.machinePhoto.create({
        data: { shopId, machineId: machine.id, ticketId: t.id, kind: "CONDITION", caption: s(p.caption) ?? `At intake, ${link.partnerName}`, mime, data: Buffer.from(b64, "base64") },
      });
    }
  });
}

/** Consigned stock arriving on the sewing shop's shelf: its own inventory item, marked as the partner's. */
async function receiveConsigned(shopId: string, link: { id: string; partnerName: string }, it: Obj, at: Date) {
  const itemKey = String(it.itemKey);
  const qty = n(it.qty) ?? 0;
  if (!itemKey || qty <= 0) return;
  const price = Math.round(n(it.priceCents) ?? 0);
  let part = await db.part.findFirst({ where: { shopId, consignLinkId: link.id, consignItemKey: itemKey } });
  if (!part) {
    const number = String(it.partNumber ?? itemKey);
    // The shop may stock the same number itself; the consigned one gets its own entry.
    const taken = await db.part.findUnique({ where: { shopId_partNumber: { shopId, partNumber: number } } });
    const partNumber = taken ? `${number} (${link.partnerName.slice(0, 20)})` : number;
    const kind = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"].includes(String(it.kind)) ? String(it.kind) : "ACCESSORY";
    part = await db.part.create({
      data: {
        shopId,
        partNumber,
        description: String(it.description ?? number),
        brand: s(it.brand),
        kind: kind as "ACCESSORY",
        unit: s(it.unit),
        priceCents: price,
        altNumbers: taken ? [number] : [],
        numberKeys: [...new Set([partNumber, number].map((x) => x.toUpperCase().replace(/[^A-Z0-9]/g, "")))],
        consignLinkId: link.id,
        consignItemKey: itemKey,
        notes: `On consignment from ${link.partnerName}`,
      },
    });
  }
  await db.$transaction([
    db.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: qty }, priceCents: price || part.priceCents } }),
    db.stockMove.create({ data: { shopId, partId: part.id, qty, reason: "CONSIGNED", note: `Consignment from ${link.partnerName}`, createdAt: at } }),
    db.consignItem.upsert({
      where: { shopId_linkId_itemKey: { shopId, linkId: link.id, itemKey } },
      create: {
        shopId,
        linkId: link.id,
        side: "holder",
        itemKey,
        partId: part.id,
        partNumber: part.partNumber,
        description: part.description,
        priceCents: price,
        placed: qty,
      },
      update: { placed: { increment: qty }, priceCents: price || undefined, partId: part.id },
    }),
  ]);
}

/** Consigned stock going back to the repair shop. Each side moves its own stock. */
export async function consignReturned(shopId: string, link: { id: string; side: string; partnerName: string }, itemKey: string, qty: number, at: Date) {
  if (qty <= 0) return;
  const item = await db.consignItem.findUnique({ where: { shopId_linkId_itemKey: { shopId, linkId: link.id, itemKey } } });
  if (!item) return;
  const partId = link.side === "repair" ? itemKey : item.partId;
  const part = partId ? await db.part.findFirst({ where: { id: partId, shopId } }) : null;
  const sign = link.side === "repair" ? 1 : -1; // back on the repair shop's shelf; off the sewing shop's
  await db.$transaction([
    db.consignItem.update({ where: { id: item.id }, data: { returned: { increment: qty } } }),
    ...(part
      ? [
          db.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: sign * qty } } }),
          db.stockMove.create({
            data: { shopId, partId: part.id, qty: sign * qty, reason: "CONSIGNED", note: link.side === "repair" ? `Back from ${link.partnerName}` : `Returned to ${link.partnerName}`, createdAt: at },
          }),
        ]
      : []),
  ]);
}

// ---------- statements ----------

export type Statement = Awaited<ReturnType<typeof statementFor>>;

/**
 * What each shop owes the other for [from, to): repairs paid (at the sewing shop: it owes the repair shop the bill less
 * its commission; paid to the repair shop: the repair shop owes the commission), consigned stock sold (the sewing shop
 * keeps its share) and partner orders delivered. Plus the running balance: everything ever owed less settlements.
 * netCents > 0: the sewing shop pays the repair shop.
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
  const repairs = jobs.map((j) => {
    const total = j.paidCents ?? j.totalCents ?? 0;
    const commission = j.commissionCents ?? 0;
    return {
      id: j.id,
      tag: j.tag,
      ticketNumber: j.ticketNumber,
      customerName: j.customerName,
      machine: `${j.brand} ${j.model}`,
      paidAt: j.paidAt!,
      paidWhere: j.paidWhere ?? "shop",
      totalCents: total,
      commissionCents: commission,
      // + the sewing shop owes the repair shop
      owedCents: (j.paidWhere ?? "shop") === "shop" ? total - commission : -commission,
    };
  });
  const items = await db.consignItem.findMany({ where: { shopId, linkId } });
  const itemName = new Map(items.map((i) => [i.itemKey, `${i.partNumber} ${i.description}`]));
  const consign = sales.map((x) => {
    const gross = Math.round(x.qty * x.priceCents);
    const shopKeeps = Math.round((gross * terms.consignSharePct) / 100);
    return { id: x.id, item: itemName.get(x.itemKey) ?? x.itemKey, qty: x.qty, priceCents: x.priceCents, soldAt: x.soldAt, grossCents: gross, shopKeepsCents: shopKeeps, owedCents: gross - shopKeeps };
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
    db.repairJob.findMany({ where: { shopId, linkId, paidAt: { not: null } }, select: { paidCents: true, totalCents: true, commissionCents: true, paidWhere: true } }),
    db.consignSale.findMany({ where: { shopId, linkId }, select: { qty: true, priceCents: true } }),
    db.partnerOrder.aggregate({ where: { shopId, linkId, status: { in: ["DELIVERED", "RECEIVED"] } }, _sum: { totalCents: true } }),
    db.settlement.aggregate({ where: { shopId, linkId }, _sum: { netCents: true } }),
  ]);
  const repairs = jobs.reduce((a, j) => {
    const total = j.paidCents ?? j.totalCents ?? 0;
    const c = j.commissionCents ?? 0;
    return a + ((j.paidWhere ?? "shop") === "shop" ? total - c : -c);
  }, 0);
  const consign = sales.reduce((a, x) => {
    const gross = Math.round(x.qty * x.priceCents);
    return a + gross - Math.round((gross * terms.consignSharePct) / 100);
  }, 0);
  return repairs + consign + (orders._sum.totalCents ?? 0) - (settled._sum.netCents ?? 0);
}

/** Month boundaries for statements: "2026-09" -> [Sep 1, Oct 1). */
export function monthPeriod(month?: string | null) {
  const now = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  const y = m ? Number(m[1]) : now.getFullYear();
  const mo = m ? Number(m[2]) - 1 : now.getMonth();
  const from = new Date(y, mo, 1);
  const to = new Date(y, mo + 1, 1);
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return { from, to, month: key(from), prev: key(new Date(y, mo - 1, 1)), next: key(to) };
}
