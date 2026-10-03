import "server-only";
// Partnerships between a repair shop (StitchBench) and the sewing / quilt shops (StitchShop) that work with it.
// Both shops keep their own copy of each shared record (repair jobs, orders, consignment, settlements) under the same
// id; they stay in step by sending each other messages through the hub (PartnerOutbox -> hub -> the other install).
//
// Who sends what (anything else is ignored):
//   sewing shop -> repair shop : job.new, job.reply, job.paid, job.pickedup, job.cancel, order.new, order.update
//                                (received / cancelled), consign.sale, consign.count, consign.return
//   repair shop -> sewing shop : job.update, catalog, order.update (accepted / delivered / cancelled), consign.place
//   either                     : terms.propose, terms.accept, settle.paid, pickup.plan (the run's owner), pickup.ok,
//                                pickup.cancel, pickup.done, caps.update (what the install can do)
//   hub                        : link.created, link.ended
//
// The other shop may be careless or hostile, so every message is checked before it's applied: it must come from the
// side allowed to send it, on a link this shop is on, with sensible values. A message that can't be applied is set
// aside (PartnerFailure, shown on the Partners page) instead of stopping every message after it.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { isUserError, UserError } from "@/lib/user-error";
import { checkHubUrl, formerInstall, hubDefaultUrl, hubFetch, hubId, hubState, hubStatus, inBackground } from "@/lib/hub";
import { lineTotal } from "@/lib/ticket-math";
import { inEighths } from "@/lib/register-math";
import { modelKey } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { normalizeTerms, repairCommission, termsKey, type Accepted, type PartnerTerms } from "@/lib/partner-terms";
import { Prisma } from "@/generated/prisma/client";
import { sameText } from "@/lib/input";
import { asCondition, asOrigin, labelFields } from "@/lib/part-labels";
import { hookContext, type HookCtx } from "@/lib/notices/context";
import { onJobsBack, onJobStatus } from "@/lib/notices/hooks";
import { changeTicketStatus } from "@/lib/ticket-status";
import { planOutcome, receivedList, type RunPlan, type Side as RunSide } from "@/lib/partner-runs";

/** The community's hub, for a partner code that names no address (the same default an account start uses: src/lib/hub.ts). */
export const DEFAULT_HUB_URL = hubDefaultUrl();
const FINAL = ["COLLECTED", "ABANDONED", "RETURNED_UNREPAIRED"];
const READY = ["READY_IN_TRUCK", "READY_FOR_PICKUP", "RETURNED_UNREPAIRED"];
const STATUSES = ["AT_SHOP_AWAITING_PICKUP", "IN_TRUCK", "ON_BENCH", "WAITING_CUSTOMER_OK", "WAITING_PARTS", "READY_IN_TRUCK", "READY_FOR_PICKUP", "COLLECTED", "ABANDONED", "RETURNED_UNREPAIRED"];
const KINDS = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"];
const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_MONEY = 10_000_000; // $100,000 in cents: far above any real repair, order or statement
export const MAX_QTY = 100_000;
const MAX_EVENTS = 200;
// A partnership brings in a few machines a day and a shelf of consigned stock at a time. Far more than that within an
// hour is a fault or an attack (each intake opens a ticket and can carry megabytes of photos, into the database every
// company on this install shares): the rest are set aside and shown on the Partners page rather than applied.
const MAX_INTAKES_PER_HOUR = 100;
const MAX_CONSIGN_ITEMS_PER_HOUR = 2000;
const MAX_INTAKE_PHOTO_CHARS = 3_600_000; // base64 of all photos in one intake; the sender keeps them under 2.6 MB raw

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
  // Postgres refuses a NUL in text, which would fail the whole message after it was checked.
  const t = String(v).replace(/\0/g, "").trim();
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
  if (!Number.isFinite(x) || Math.abs(x) > MAX_QTY) return bad(`${what} is out of range`);
  // Fabric is cut in eighths of a yard: within a millionth of an eighth is that eighth (as the register takes it);
  // anything else keeps thousandths.
  return inEighths(x) ? Math.round(x * 8) / 8 : Math.round(x * 1000) / 1000;
};
// Quantities are floats (0.7 - 0.4 isn't 0.3 exactly): a millionth of slack on every "no more than" check, as at the register.
const SLACK = 1e-6;
/** A date from 2000 to a year from now: JavaScript takes years like -100000, which the database refuses. */
const dateOf = (v: unknown, what: string) => {
  const d = new Date(String(v ?? ""));
  const t = d.getTime();
  return Number.isNaN(t) || t < Date.UTC(2000, 0, 1) || t > Date.now() + 366 * 86400_000 ? bad(`${what} isn't a date`) : d;
};
/**
 * A time the partner reports (when it sold, took payment, handed a machine over), as long as its clock is near the hub's:
 * up to an hour ahead of when the hub got the message, or 30 days behind it (messages queued through an outage). A PC
 * with a wrong clock, or a partner picking dates on purpose, would otherwise file money into the wrong month or year;
 * then the hub's time is used instead.
 */
const nearHub = (t: Date, hubAt: Date) => {
  const off = t.getTime() - hubAt.getTime();
  return off > 3600_000 || off < -30 * 86400_000 ? hubAt : t;
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
  // Left out when New / Genuine; installs from before these existed don't send them (see labelFields)
  condition?: string;
  origin?: string;
};

export type JobEvent = { at: string; status?: string; note?: string };
export type JobLine = { description: string; qty: number; amountCents: number; kind: string };
export type OrderLine = { itemKey: string; partNumber: string; description: string; qty: number; unitCents: number; condition?: string; origin?: string };

/** Order lines to compare, whatever order their keys are in (the database keeps a JSON column's keys in its own order). */
const linesKey = (lines: unknown) =>
  JSON.stringify(((lines as OrderLine[] | null) ?? []).map((l) => [l.itemKey, l.partNumber, l.description, l.qty, l.unitCents, l.condition ?? null, l.origin ?? null]));

/** What the customer still owes on a repair: the bill, less anything already paid to either shop (the register's figure). */
export function repairDue(j: { totalCents: number | null; repairPaidCents: number | null; paidCents: number | null }) {
  return Math.max(0, (j.totalCents ?? 0) - (j.repairPaidCents ?? 0) - (j.paidCents ?? 0));
}

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

// The hub limits partner codes and messages per install, and a hosted install serves many companies: each company
// gets its own share here, so one (or one of its users, clicking a form over and over) can't use up the others'. Kept
// per server process; the hub also counts per company.
const quotas = globalThis as unknown as { __partnerQuota?: Map<string, { n: number; since: number }> };
export function partnerQuota(shopId: string, what: string, perHour: number, message: string) {
  const map = (quotas.__partnerQuota ??= new Map());
  const now = Date.now();
  for (const [k, b] of map) if (now - b.since > 3600_000) map.delete(k);
  const key = `${what}:${shopId}`;
  const b = map.get(key) ?? { n: 0, since: now };
  if (b.n >= perHour) throw new UserError(message);
  b.n++;
  map.set(key, b);
}

/**
 * Queue a message for the partner on the other side of `linkId`; it goes out on the next partner sync. `limited: false`
 * for the record of a sale at the register (a consigned item sold, a repair paid): a busy counter is never turned away.
 */
export async function sendToPartner(shopId: string, linkId: string, type: string, data: Json, tx: Prisma.TransactionClient = db, limited = true) {
  if (limited) partnerQuota(shopId, "message", 600, "This company has sent its partners a lot in the last hour. Wait a while and try again.");
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
  const r = (await (await hubFetch("/v1/partners/invites", { method: "POST", json: { shopRef: shopId, shopName, side, terms }, shopRef: shopId })).json()) as {
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
    out = (await (await hubFetch("/v1/partners/redeem", { method: "POST", json: { code, shopRef: shopId, shopName }, shopRef: shopId })).json()) as typeof out;
  } else {
    const base = url ?? DEFAULT_HUB_URL;
    // The code's hub is the one this install left, and it still knows the install: the same install again, for its
    // partner shops only (the community part waits for a join key, as with any partner code), so what it had on the
    // hub stays its own. Otherwise the code alone gets it a new install there.
    const oldKey = st?.formerUrl === base ? st.formerInstallKey : null;
    const former = oldKey ? await formerInstall(base, oldKey) : null;
    if (former && oldKey) {
      const fresh = await hubState();
      if (fresh?.installKey) throw new UserError("This install joined a hub a moment ago. Enter the partner code again.");
      const data = {
        url: base,
        hubName: former.hubName,
        installId: former.installId,
        installKey: oldKey,
        joinedAt: new Date(),
        scope: "partner",
        cursor: null,
        orderCursor: null,
        partnerCursor: "0",
        lastError: null,
        formerUrl: null,
        formerInstallId: null,
        formerInstallKey: null,
      };
      await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
      out = (await (await hubFetch("/v1/partners/redeem", { method: "POST", json: { code, shopRef: shopId, shopName }, shopRef: shopId })).json()) as typeof out;
    } else {
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
        formerUrl: null,
        formerInstallId: null,
        formerInstallKey: null,
      };
      await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
      out = j;
    }
  }
  await saveLinkFromHub(shopId, out.side, out.link);
  const s1 = await hubState();
  if (s1?.partnerCursor == null) await db.hubState.update({ where: { id: 1 }, data: { partnerCursor: "0" } });
  kickPartnerSync();
  return out;
}

export async function endPartnership(shopId: string, linkId: string, note: string | null) {
  await partnerLink(shopId, linkId);
  const l = (await (await hubFetch(`/v1/partners/links/${hubId(linkId)}/end`, { method: "POST", json: { shopRef: shopId, note }, shopRef: shopId })).json()) as HubPartnerLink;
  await db.partnerLink.update({ where: { shopId_id: { shopId, id: linkId } }, data: { status: l.status, endedAt: l.endedAt ? new Date(l.endedAt) : new Date() } });
}

/**
 * The trade account a partner sewing shop's machines come in under. An existing account of the same name is used only
 * if no other partnership already uses it, and its commission is left as the shop set it.
 */
async function tradeAccountFor(shopId: string, name: string, terms: PartnerTerms, tx: Prisma.TransactionClient = db) {
  const found = await tx.customer.findFirst({ where: { shopId, kind: "TRADE", name: sameText(name) } });
  if (found && !(await tx.partnerLink.findFirst({ where: { shopId, accountId: found.id } }))) return found.id;
  const c = await tx.customer.create({
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

/** `tx`: inside the transaction that applies a hub message, so the link is written with the message's "seen" row. */
export async function saveLinkFromHub(shopId: string, side: Side, raw: HubPartnerLink, tx: Prisma.TransactionClient = db) {
  const l = hubLinkOf(raw);
  const partnerName = side === "repair" ? l.retail.name : l.repair.name;
  const terms = normalizeTerms(l.terms);
  const where = { shopId_id: { shopId, id: l.id } };
  const existing = await tx.partnerLink.findUnique({ where });
  const endedAt = l.endedAt ? new Date(l.endedAt) : null;
  if (!existing) {
    const accountId = side === "repair" ? await tradeAccountFor(shopId, partnerName, terms, tx) : null;
    await tx.partnerLink.create({ data: { id: l.id, shopId, side, partnerName, status: l.status, terms, accountId, endedAt } });
    return;
  }
  // The same two shops used a new code (after ending, or while still linked): its terms become a new version that both
  // accept again. Money already recorded keeps the rates it was recorded at.
  const newTerms = l.status === "ACTIVE" && termsKey(terms) !== termsKey(normalizeTerms(existing.terms));
  await tx.partnerLink.update({
    where,
    data: {
      partnerName,
      status: l.status,
      endedAt,
      ...(newTerms ? { terms, termsVersion: existing.termsVersion + 1, accepted: {}, proposedTerms: Prisma.DbNull, proposedBy: null, priorTerms: Prisma.DbNull, withdrawnTerms: Prisma.DbNull } : {}),
    },
  });
}

// ---------- terms ----------

type Proposal = { version: number; terms: PartnerTerms; by: { name: string; at: string } };
/** The terms in force before this shop took the partner's proposal `adoptedVersion` as agreed (PartnerLink.priorTerms). */
type PriorTerms = { terms: unknown; termsVersion: number; accepted: Accepted; adoptedVersion: number };
/** A proposal this shop accepted that the partner had already replaced (PartnerLink.withdrawnTerms). */
export type WithdrawnTerms = { version: number; terms: unknown; reason: string | null; at: string };

export async function proposeTerms(shopId: string, linkId: string, terms: PartnerTerms, byName: string) {
  const l = await partnerLink(shopId, linkId);
  // One more than anything either shop has put forward, so an answer to the partner's proposal (a counter-offer)
  // carries a higher number and isn't taken by the other side for the same proposal crossing in the post and dropped.
  const pending = l.proposedTerms as Proposal | null;
  const version = Math.max(l.termsVersion, pending?.version ?? 0) + 1;
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
export async function acceptTerms(shopId: string, linkId: string, byName: string, shown?: { version: number | null; key: string | null }) {
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
    // Taken as agreed here now; the partner's copy agrees once this acceptance reaches it. Should the partner have
    // replaced the proposal before then, it says so (msg.rejected) and the terms in force before are put back.
    const prior: PriorTerms = { terms: l.terms, termsVersion: l.termsVersion, accepted: (l.accepted as Accepted) ?? {}, adoptedVersion: version };
    data = { terms, termsVersion: version, accepted: next as Json, proposedTerms: Prisma.DbNull, proposedBy: null, priorTerms: prior as Json, withdrawnTerms: Prisma.DbNull };
  } else {
    accepted[l.side as Side] = { name: byName, at, version };
    data = { accepted: accepted as Json };
  }
  // Only what the person read: a newer proposal that arrived after the page was opened is shown to them first.
  if (shown && ((shown.version != null && shown.version !== version) || (shown.key != null && shown.key !== termsKey(terms)))) {
    throw new UserError("The terms changed since this page was opened. Read them again, then accept.");
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
 * payments or new terms don't move a settled job to another month or change what it earned. A job paid against a bill
 * that has since gone up isn't fully paid: its commission follows the bill until the rest is paid (the sewing shop
 * works it out the same way from the same lines).
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
  // Put on account (INVOICE) isn't money received, as in ticket-math.
  const direct = t.payments.filter((p) => p.method !== "SHOP_COLLECTED" && p.method !== "INVOICE").reduce((a, p) => a + p.amountCents, 0);
  const atShop = t.payments.filter((p) => p.method === "SHOP_COLLECTED").reduce((a, p) => a + p.amountCents, 0);
  const paidAt = job.paidAt ?? (total > 0 && direct + atShop >= total ? new Date() : null);
  // Frozen while it's paid in full, or while the bill is what it was when it was paid (a job paid before on-account
  // payments stopped counting as paid keeps what it earned); only a bill that went up afterwards is worked out again.
  const settled = job.paidAt != null && (direct + atShop >= total || total <= (job.totalCents ?? 0));
  return {
    id: job.id,
    status: t.status,
    ticketNumber: t.number,
    lines,
    totalCents: total,
    taxCents: tax,
    commissionPct: settled ? job.commissionPct : terms.repairCommissionPct,
    commissionCents: settled && job.commissionCents != null ? job.commissionCents : repairCommission(lines, terms),
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
    try {
      const t = await db.ticket.findUnique({ where: { id: job.ticketId! }, include: { lines: { orderBy: { createdAt: "asc" } }, payments: { orderBy: { paidAt: "asc" } } } });
      const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId: job.shopId, id: job.linkId } } });
      if (!t || !link) continue;
      const snap = jobSnapshot(job, t, normalizeTerms(link.terms));
      // The hash leaves out the paid date so a not-yet-sent "paid now" doesn't make every sync send again.
      const h = hash({ ...snap, paidAt: snap.paidAt ? "paid" : null });
      if (h === job.sentHash) continue;
      const events = snap.status !== job.status ? withEvent(job.events, { at: new Date().toISOString(), status: snap.status }) : (job.events as Json);
      // Asking for the customer's OK again (a second estimate): the last answer was to the first one.
      const askAgain = snap.status === "WAITING_CUSTOMER_OK" && job.status !== "WAITING_CUSTOMER_OK" && job.approval != null;
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
            ...(askAgain ? { approval: null, approvedCents: null } : {}),
            ...(snap.paidAt && !job.paidAt ? { paidAt: new Date(snap.paidAt), paidWhere: job.paidCents ? "split" : "repair" } : {}),
            ...(snap.status === "COLLECTED" && !job.pickedUpAt ? { pickedUpAt: new Date() } : {}),
          },
        });
        await tx.partnerOutbox.create({ data: { shopId: job.shopId, linkId: job.linkId, type: "job.update", data: { ...snap, at: new Date().toISOString() } } });
      });
    } catch (e) {
      // One ticket that can't be written down (a bill total past what the columns hold, from a barcode typed into a
      // qty box) mustn't stop every partner message on this install: it's skipped this time and noted in the log.
      console.error(`partner sync: ticket #${job.ticketNumber ?? "?"} couldn't be sent to the partner shop:`, e instanceof Error ? e.message : e);
    }
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
    // Stock gone below zero (sold before it was received) shows as none; the partner refuses counts past its range.
    inStock: Math.min(MAX_QTY, Math.max(0, p.qtyOnHand)),
    ...labelFields(p),
  }));
}

async function pushCatalogs() {
  const links = await db.partnerLink.findMany({ where: { side: "repair", status: "ACTIVE" } });
  const byShop = new Map<string, { items: CatalogItem[]; h: string }>();
  for (const l of links) {
    try {
      if (!byShop.has(l.shopId)) {
        const items = await catalogFor(l.shopId);
        // Prices and what's offered, then everything (stock counts too).
        byShop.set(l.shopId, { items, h: `${hash(items.map((i) => ({ ...i, inStock: 0 })))}:${hash(items)}` });
      }
      const c = byShop.get(l.shopId)!;
      if (c.h === l.catalogHash) continue;
      // Stock counts change with every sale; send at most every 10 minutes unless it's the first time. A price or an
      // item offered or taken off goes at once: the partner orders at the prices it has.
      const samePrices = l.catalogHash?.split(":")[0] === c.h.split(":")[0];
      if (samePrices && l.catalogAt && Date.now() - l.catalogAt.getTime() < 10 * 60_000) continue;
      await db.$transaction([
        // Only the newest catalog matters: one still waiting to go (the hub or the partner was away) is replaced, not
        // left to be sent and applied ahead of this one.
        db.partnerOutbox.deleteMany({ where: { shopId: l.shopId, linkId: l.id, type: "catalog", sentAt: null, deadAt: null } }),
        db.partnerOutbox.create({ data: { shopId: l.shopId, linkId: l.id, type: "catalog", data: { items: c.items, at: new Date().toISOString() } as Json } }),
        db.partnerLink.update({ where: { shopId_id: { shopId: l.shopId, id: l.id } }, data: { catalogHash: c.h, catalogAt: new Date() } }),
      ]);
    } catch (e) {
      // One shop's catalog that won't queue mustn't stop the other partnerships' messages.
      console.error(`partner sync: the catalog for ${l.partnerName} couldn't be queued:`, e instanceof Error ? e.message : e);
    }
  }
}

// ---------- sync ----------

const OUTBOX_KEPT_DAYS = 30; // as long as a message the partner refused stays listed on the Partners page
let outboxPrunedAt = 0;

/** Messages sent long ago go (catalogs and intakes with photos would otherwise fill the database and every backup). */
async function pruneOutbox() {
  if (Date.now() - outboxPrunedAt < 3600_000) return;
  outboxPrunedAt = Date.now();
  await db.partnerOutbox.deleteMany({ where: { sentAt: { lt: new Date(Date.now() - OUTBOX_KEPT_DAYS * 86400_000) } } }).catch(() => {});
}

/**
 * Send what's waiting, oldest first per partnership. A message the hub refuses for good (bad data, too large) is set
 * aside and shown; one that fails because the hub or the internet is down, or because the hub won't take anything from
 * this install or this partnership right now, waits and is tried again, never dropped, and holds back every later
 * message of the same partnership until it goes (an update must not overtake its job), across syncs: a partnership
 * whose oldest waiting message isn't due yet sends nothing.
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
    const json = { id: m.id, shopRef: m.shopId, type: m.type, data: m.data };
    try {
      // A machine intake carries photos (a few MB); on a slow shop connection that takes longer than the usual 30 s,
      // so the wait grows with the size: a minute more per MB, three minutes at most (as shared notes get).
      const timeout = 30_000 + Math.min(150_000, Math.round((JSON.stringify(json).length / 1_000_000) * 60_000));
      await hubFetch(`/v1/partners/links/${hubId(m.linkId)}/messages`, { method: "POST", json, signal: AbortSignal.timeout(timeout) });
      await db.partnerOutbox.update({ where: { id: m.id }, data: { sentAt: new Date(), error: null, nextTryAt: null } });
      sent++;
    } catch (e) {
      const status = hubStatus(e);
      // 401 / 403: the hub takes nothing from this install right now (it doesn't know it, or its admin blocked it);
      // 404: it doesn't know this partnership (restored from before it was made). Neither is this message's fault, so
      // nothing is set aside: everything waits and goes out by itself once the hub takes it again.
      const installRefused = status === 401 || status === 403;
      const forGood = status >= 400 && status < 500 && status !== 408 && status !== 429 && status !== 404 && !installRefused;
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
      if (installRefused) break; // every other partnership's messages would be refused the same way: next time
    }
  }
  return sent;
}

/** Every message the hub refused for a partnership (or for the whole shop) goes back in the queue, after the cause is fixed. */
export async function resendPartnerMessages(shopId: string, linkId?: string) {
  const r = await db.partnerOutbox.updateMany({
    where: { shopId, ...(linkId ? { linkId } : {}), sentAt: null, deadAt: { not: null } },
    data: { deadAt: null, nextTryAt: null, tries: 0 },
  });
  if (r.count) kickPartnerSync();
  return r.count;
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

/** A database refusal that will be the same every time (a value it can't store), not a moment's trouble (P1xxx: can't
 * reach it; a busy pool, a write conflict, a transaction that timed out). */
function refusedForGood(e: unknown) {
  if (e instanceof Prisma.PrismaClientValidationError) return true;
  return e instanceof Prisma.PrismaClientKnownRequestError && !e.code.startsWith("P1") && !["P2024", "P2028", "P2034", "P2037"].includes(e.code);
}

// Messages per page of the feed. A newer hub also cuts a page by size; an older one doesn't, and with messages of up
// to 4 MB a page of 200 can be more than it can build: a page that fails is asked for again one message at a time.
const PAGE = 50;
const MAX_REJECTS_PER_HOUR = 30; // "couldn't take it" answers to one partner: a flood of bad messages isn't echoed

/**
 * The partnership a message is about, on this shop; missed link.created (a restored backup): fetched from the hub. Done
 * before the message's transaction, so no transaction waits on the hub. Null when the hub doesn't know it either.
 */
async function linkFor(shopId: string, m: HubMessage) {
  if (m.fromSide === "hub" || !/^[A-Za-z0-9_-]{1,80}$/.test(String(m.linkId))) return null;
  const have = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: m.linkId } } });
  if (have) return have;
  const links = (await (await hubFetch("/v1/partners/links")).json()) as (HubPartnerLink & { side: Side; shopRef: string })[];
  const l = links.find((x) => x.id === m.linkId && x.shopRef === shopId);
  if (!l) return null;
  await saveLinkFromHub(shopId, l.side, l);
  return db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: m.linkId } } });
}

/**
 * Apply one message and write its "seen" row in one transaction: a crash between the two, or a second server process
 * pulling the same page, can't apply it twice (the seen row goes in first; one already there, once the other
 * transaction has committed, means it was applied, and nothing is done). False when it was applied already.
 */
async function applyOnce(shopId: string, key: string, m: HubMessage) {
  // applyMessage runs inside this transaction, and the notices hook a job.update calls must never open a second pool
  // connection inside it (with a pool of one that would wait forever): what the hook needs is loaded here, before the
  // transaction begins, and handed down.
  const ctx = m.type === "job.update" || RUN_TYPES.has(m.type) ? await hookContext(shopId) : null;
  return db.$transaction(
    async (tx) => {
      const fresh = await tx.partnerSeen.createMany({ data: [{ shopId, key }], skipDuplicates: true });
      if (!fresh.count) return false;
      await applyMessage(m, tx, ctx);
      return true;
    },
    // An intake can carry several MB of photos, which a busy PC takes a while to write.
    { timeout: 60_000, maxWait: 10_000 },
  );
}

/**
 * Apply what partners sent, in order. A message with bad data, or one the database can't store, is set aside at once
 * and the partner is told; one whose apply fails for a passing reason holds back only the rest of its own partnership
 * (everyone else's go on), and after 3 syncs it is set aside too, so nothing stops every later message. The cursor
 * stays just before the oldest message held back, so it comes again next time; those already applied are skipped.
 */
async function pullMessages(cursor: string) {
  let since = /^\d+$/.test(cursor) ? cursor : "0";
  let keep: string | null = null;
  const held = new Set<string>();
  let received = 0;
  let limit = PAGE;
  for (let page = 0; page < 50; page++) {
    let r: { messages: HubMessage[]; next: string; more: boolean };
    try {
      r = (await (await hubFetch(`/v1/partners/messages?since=${since}&limit=${limit}`, { signal: AbortSignal.timeout(120_000) })).json()) as typeof r;
    } catch (e) {
      const status = hubStatus(e);
      if (limit > 1 && !(status >= 400 && status < 500)) {
        limit = 1;
        continue;
      }
      throw e;
    }
    limit = Math.min(PAGE, limit * 2);
    const next = /^\d+$/.test(String(r.next)) ? String(r.next) : since;
    // A hub message goes to both shops when both are on this install: rows of one seq move the cursor together.
    let doneThrough = since;
    for (let i = 0; i < r.messages.length; i++) {
      const m = r.messages[i];
      const shop = typeof m.toShopRef === "string" ? await db.shop.findUnique({ where: { id: m.toShopRef }, select: { id: true } }) : null;
      const hold = `${shop?.id}|${m.linkId}`;
      if (shop && !held.has(hold)) {
        const key = `${m.linkId}:${m.fromSide}:${m.id}:${m.toSide}`.slice(0, 300);
        const seen = await db.partnerSeen.findUnique({ where: { shopId_key: { shopId: shop.id, key } } });
        if (!seen) {
          try {
            // The partnership first (it may have to come from the hub): not inside the message's transaction.
            await linkFor(shop.id, m);
            if (await applyOnce(shop.id, key, m)) received++;
            // An earlier try that failed is over with: it mustn't stay on the Partners page as still failing.
            await db.partnerFailure.deleteMany({ where: { shopId: shop.id, key } }).catch(() => {});
          } catch (e) {
            const { skip } = await noteFailure(shop.id, key, m, e);
            if (!skip) {
              // Everything else of this partnership waits behind it (an update mustn't overtake its job).
              held.add(hold);
              keep ??= doneThrough;
            }
          }
        }
      }
      if (r.messages[i + 1]?.seq !== m.seq) doneThrough = m.seq;
    }
    await db.hubState.update({ where: { id: 1 }, data: { partnerCursor: keep ?? next } });
    if (!r.more || next === since) break;
    since = next;
  }
  return received;
}

/**
 * A message that couldn't be applied: written down for the Partners page (with the message's number on the hub, so
 * it can be fetched whole and tried again). Bad data, or something the database refuses every time, is set aside at
 * once; a passing failure is set aside after 3 tries, or at once when `setAside` (a try someone asked for). A message
 * set aside counts as seen, so a feed that starts over doesn't apply it, and the partner is told.
 */
async function noteFailure(shopId: string, key: string, m: HubMessage, e: unknown, setAside = false) {
  const dataError = e instanceof PartnerDataError;
  const dbError = !dataError && refusedForGood(e);
  // The database's own words name source files and values: they go to the log, and the shop sees plain words.
  if (!dataError) console.error(`partner sync: ${m.type} from a partner couldn't be applied:`, e instanceof Error ? e.message : e);
  const msg = dataError ? (e as Error).message : dbError ? "this install couldn't store what was sent (a value out of range)" : "it couldn't be applied yet";
  const prior = await db.partnerFailure.findUnique({ where: { shopId_key: { shopId, key } } });
  const tries = (prior?.tries ?? 0) + 1;
  const skip = dataError || dbError || setAside || tries >= 3;
  const seq = /^\d{1,30}$/.test(String(m.seq)) ? String(m.seq) : null;
  await db.partnerFailure
    .upsert({
      where: { shopId_key: { shopId, key } },
      create: { shopId, key, linkId: String(m.linkId).slice(0, 80), type: String(m.type).slice(0, 40), data: storable(m.data), error: msg.slice(0, 1000), skipped: skip, tries, seq },
      update: { tries, error: msg.slice(0, 1000), skipped: skip, at: new Date(), ...(seq ? { seq } : {}) },
    })
    .catch(() => null);
  if (skip) {
    await db.partnerSeen.createMany({ data: [{ shopId, key }], skipDuplicates: true }).catch(() => {});
    await tellRejected(shopId, m, msg).catch(() => {});
  }
  return { skip, msg };
}

/**
 * The message a set-aside entry is about, from the hub again, whole (the copy kept here leaves photos out and is cut
 * short): by its number there, or, for an entry from before the number was kept, by the message's own key (the
 * partnership, the sender's side and the sender's id). Null when the hub doesn't have it, or is too old to look one up.
 */
async function fetchHubMessage(shopId: string, f: { key: string; seq: string | null }): Promise<HubMessage | null> {
  const parts = f.key.split(":"); // linkId:fromSide:id:toSide, as pullMessages builds it
  const byKey = parts.length === 4 && /^[A-Za-z0-9_-]{1,80}$/.test(parts[0]) && ["repair", "retail", "hub"].includes(parts[1]) && /^[A-Za-z0-9_-]{1,80}$/.test(parts[2]);
  const path = f.seq && /^\d{1,18}$/.test(f.seq) ? `/v1/partners/messages/${f.seq}` : byKey ? `/v1/partners/links/${parts[0]}/messages/${parts[1]}/${parts[2]}` : null;
  if (!path) return null;
  let r: Response;
  try {
    r = await hubFetch(path, { signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    if (hubStatus(e) === 404) return null;
    throw e;
  }
  const { messages } = (await r.json()) as { messages?: HubMessage[] };
  // The hub sends a copy per shop of this install the message is for: the one this entry belongs to.
  return (messages ?? []).find((m) => m.toShopRef === shopId && `${m.linkId}:${m.fromSide}:${m.id}:${m.toSide}`.slice(0, 300) === f.key) ?? null;
}

/**
 * Apply a message that was set aside once more (after the cause is fixed: a partnership restored, room made on the
 * disk): fetched from the hub again, then through the same path as the sync's, so it is applied whole or not at all
 * and never twice. One that fails again is set aside again, with the new reason.
 */
export async function retryPartnerMessage(shopId: string, key: string) {
  const f = await db.partnerFailure.findUnique({ where: { shopId_key: { shopId, key } } });
  if (!f) throw new UserError("That message isn't set aside any more.");
  if (!(await hubState())?.installKey) throw new UserError("This install isn't on a hub now; the message can't be fetched again.");
  const m = await fetchHubMessage(shopId, f);
  if (!m) throw new UserError("The hub doesn't have that message any more (it keeps them for a year), or it is an older hub that can't look one up. Ask the partner shop to send it again.");
  // A fresh start for it: the "seen" row written when it was set aside, and the entry itself, go first.
  await db.$transaction([db.partnerSeen.deleteMany({ where: { shopId, key } }), db.partnerFailure.deleteMany({ where: { shopId, key } })]);
  try {
    await linkFor(shopId, m);
    await applyOnce(shopId, key, m);
  } catch (e) {
    const { msg } = await noteFailure(shopId, key, m, e, true);
    throw new UserError(`It couldn't be applied this time either: ${msg}.`);
  }
  // Whatever it caused (a new job's first update, an order's copy back) goes out now rather than next time.
  kickPartnerSync();
}

/**
 * The partner sent something this shop can't take: tell it, so the sender sees it under "Messages that didn't get
 * through" instead of a job or order that silently never arrived. Not for the hub's own messages or another answer.
 */
async function tellRejected(shopId: string, m: HubMessage, reason: string) {
  if (m.fromSide === "hub" || m.type === "msg.rejected" || !/^[A-Za-z0-9_-]{1,80}$/.test(String(m.linkId))) return;
  if (!(await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: m.linkId } }, select: { id: true } }))) return;
  const lately = await db.partnerOutbox.count({ where: { shopId, linkId: m.linkId, type: "msg.rejected", createdAt: { gte: new Date(Date.now() - 3600_000) } } });
  if (lately >= MAX_REJECTS_PER_HOUR) return;
  await db.partnerOutbox.create({
    data: { shopId, linkId: m.linkId, type: "msg.rejected", data: { id: String(m.id).slice(0, 80), type: String(m.type).slice(0, 40), reason: reason.slice(0, 500), at: new Date().toISOString() } },
  });
}

export type PartnerSyncResult = { sent: number; received: number } | { skipped: true } | { busy: true };

/**
 * One partner sync at a time on this install, even with several server processes (a lease on the HubState row). The
 * lease is short and renewed every half minute while the sync runs, so a long sync (a backlog, big intakes) keeps it
 * and one that died mid-way (the server stopped) frees it within two minutes. The time it was set to is this run's
 * token: it's renewed and given back only while the row still holds it, never one another run took over meanwhile.
 */
async function withSyncLease<T>(run: () => Promise<T>): Promise<T | null> {
  let token = (
    await db.$queryRaw<{ lease: string }[]>`UPDATE "HubState" SET "partnerLockUntil" = now() + interval '2 minutes'
      WHERE id = 1 AND ("partnerLockUntil" IS NULL OR "partnerLockUntil" < now()) RETURNING "partnerLockUntil"::text AS lease`
  )[0]?.lease;
  if (!token) return null;
  let renewing: Promise<unknown> = Promise.resolve();
  const heartbeat = setInterval(() => {
    renewing = db.$queryRaw<{ lease: string }[]>`UPDATE "HubState" SET "partnerLockUntil" = now() + interval '2 minutes'
      WHERE id = 1 AND "partnerLockUntil"::text = ${token} RETURNING "partnerLockUntil"::text AS lease`
      .then((rows) => {
        if (rows[0]) token = rows[0].lease;
        else console.error("partner sync: the sync lease was lost to another server process; this run carries on without it");
      })
      .catch(() => {});
  }, 30_000);
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    await renewing; // a renewal still on its way would change the token under the release
    await db.$executeRaw`UPDATE "HubState" SET "partnerLockUntil" = NULL WHERE id = 1 AND "partnerLockUntil"::text = ${token}`.catch(() => {});
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
      await pushFeatures();
      const sent = await pushOutbox();
      const received = await pullMessages(st.partnerCursor ?? "0");
      // Anything the messages just caused (a new job's first update) goes out now rather than next time.
      await pushJobUpdates();
      const more = await pushOutbox();
      // This status line is one for the whole install, so it only says what concerns every company here (the hub out
      // of reach, a sync that broke off). Messages one company couldn't send are listed on that company's Partners page.
      await db.hubState.update({ where: { id: 1 }, data: { partnerSyncAt: new Date(), partnerError: null } });
      await pruneOutbox();
      return { sent: sent + more, received };
    } catch (e) {
      // Every company's Partners page shows this line: the hub's own words (out of reach, refused) are fine there; what
      // the database said may name one company's data, so that stays in the log.
      if (!isUserError(e)) console.error("partner sync stopped:", e);
      const plain = isUserError(e) ? e.message : "The sync stopped on an error. Try again in a minute; if it keeps happening, tell whoever runs this install.";
      await db.hubState.update({ where: { id: 1 }, data: { partnerError: plain } }).catch(() => {});
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
  "msg.rejected": "either",
  "pickup.plan": "either",
  "pickup.ok": "either",
  "pickup.cancel": "either",
  "pickup.done": "either",
  "caps.update": "either",
};

/** The run messages (applyRun checks the side rules of design 13.1 itself). */
const RUN_TYPES = new Set(["pickup.plan", "pickup.ok", "pickup.cancel", "pickup.done"]);

// New work isn't taken from a partnership that has ended; updates and settlements still are (the last statement).
const NEW_WORK = new Set(["job.new", "order.new", "consign.place", "catalog"]);

/** True the first time `key` is seen on this shop; recorded in the same transaction as whatever it guards. */
async function firstTime(tx: Prisma.TransactionClient, shopId: string, key: string) {
  return (await tx.partnerSeen.createMany({ data: [{ shopId, key: key.slice(0, 300) }], skipDuplicates: true })).count > 0;
}

/**
 * Everything a message changes goes through `tx`, the transaction its "seen" row is written in (applyOnce), so it is
 * applied whole or not at all, and never twice.
 */
async function applyMessage(m: HubMessage, tx: Prisma.TransactionClient, ctx: HookCtx | null = null) {
  const shop = await tx.shop.findUnique({ where: { id: m.toShopRef } });
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
      return saveLinkFromHub(shopId, toSide, l, tx);
    }
    // The note typed with the ending and who ended it are kept for the shop to read on the partner's page.
    const endNote = text(d.note, 500);
    const endedBy = text(d.endedBy, 120);
    await tx.partnerLink.updateMany({
      where: { shopId, id: linkId },
      data: { status: "ENDED", endedAt: d.endedAt ? dateOf(d.endedAt, "endedAt") : new Date(), ...(endNote ? { endNote } : {}), ...(endedBy ? { endedBy } : {}) },
    });
    return;
  }

  // Missed the link.created (a restored backup): linkFor asked the hub before this transaction; not there either: nothing to do.
  const link = await tx.partnerLink.findUnique({ where: { shopId_id: { shopId, id: linkId } } });
  if (!link) return;
  const partnerSide: Side = link.side === "repair" ? "retail" : "repair";
  if (m.fromSide !== partnerSide) return bad(`${m.type} came from the wrong side`);
  if (allowed !== "either" && allowed !== partnerSide) return bad(`${m.type} can't come from the ${partnerSide === "repair" ? "repair shop" : "sewing shop"}`);
  // Ended: no new work. Said so (set aside, and the sender told), except for a catalog still on its way.
  if (link.status !== "ACTIVE" && NEW_WORK.has(m.type)) return m.type === "catalog" ? undefined : bad(`the partnership has ended; ${m.type} isn't taken any more`);
  const lk = { shopId_id: { shopId, id: link.id } };
  const hubAt = dateOf(m.createdAt, "createdAt"); // when the hub got it: the one clock both shops can trust
  const at = d.at != null ? nearHub(dateOf(d.at, "at"), hubAt) : hubAt;
  const terms = normalizeTerms(link.terms);

  switch (m.type) {
    case "terms.propose": {
      const version = int(d.version, 1, 100_000, "version");
      if (version <= link.termsVersion) return;
      const mine = link.proposedTerms as Proposal | null;
      // Both proposed the same version at once: the repair shop's proposal stands for both.
      if (mine && mine.version === version && link.proposedBy === link.side && link.side === "repair") return;
      await tx.partnerLink.update({
        where: lk,
        data: { proposedTerms: { version, terms: normalizeTerms(d.terms), by: { name: text(d.name, 120) ?? "", at: at.toISOString() } } as Json, proposedBy: m.fromSide },
      });
      return;
    }

    case "terms.accept": {
      const version = int(d.version, 1, 100_000, "version");
      const who = { name: text(d.name, 120) ?? "", at: at.toISOString(), version };
      const prop = link.proposedTerms as Proposal | null;
      // The key is the JSON of every term, "also agreed" text included (up to 4,000 characters, escaped): read whole.
      // Cut short, a long clause could never be accepted, and the two shops would run on different terms.
      const key = text(d.key, 50_000);
      if (prop && prop.version === version && link.proposedBy === link.side) {
        // They accepted the change we offered, if it is the same change.
        if (key && key !== termsKey(normalizeTerms(prop.terms))) return bad("the partner accepted different terms from the ones offered; propose them again");
        const accepted: Accepted = { [link.side]: { ...prop.by, version }, [m.fromSide]: who };
        await tx.partnerLink.update({
          where: lk,
          data: { terms: normalizeTerms(prop.terms), termsVersion: version, accepted: accepted as Json, proposedTerms: Prisma.DbNull, proposedBy: null },
        });
      } else if (prop && link.proposedBy === link.side && version < prop.version && version > link.termsVersion) {
        // They accepted a proposal we had already replaced: nothing is agreed, and they're told (they have the new one).
        return bad(`the partner accepted version ${version}, which was replaced by version ${prop.version} before it arrived; accept that one instead`);
      } else if (version === link.termsVersion) {
        if (key && key !== termsKey(terms)) return bad("the partner accepted different terms from these; propose them again");
        await tx.partnerLink.update({ where: lk, data: { accepted: { ...((link.accepted as Accepted) ?? {}), [m.fromSide]: who } as Json } });
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
          ...labelFields(it),
        } satisfies CatalogItem;
      });
      await tx.partnerLink.update({ where: lk, data: { catalog: items as Json, catalogAt: at } });
      return;
    }

    case "job.new":
      await newJobFromPartner(shopId, link, d, at, tx);
      return;

    case "job.update": {
      const job = await tx.repairJob.findUnique({ where: { shopId_id: { shopId, id: idOf(d.id, "job") } } });
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
      const paidAt = d.paidAt ? nearHub(dateOf(d.paidAt, "paidAt"), hubAt) : null;
      const totalCents = optInt(d.totalCents, 0, MAX_MONEY, "total");
      // The commission is worked out here from the bill and our copy of the terms, not taken from the partner; once the
      // job is fully paid it stays as it was. Paid against a bill that has since gone up, it follows the bill until the
      // rest is paid, as the repair shop's does.
      const settled = job.paidAt != null && ((job.paidCents ?? 0) + (repairPaid ?? 0) >= (totalCents ?? 0) || (totalCents ?? 0) <= (job.totalCents ?? 0));
      const commission = settled && job.commissionCents != null ? job.commissionCents : repairCommission(lines, terms);
      // The repair shop asks for the customer's OK again (a second estimate): the last answer was to the first one, so
      // the question is shown again (the approval is reset and the history says so).
      const reopened = status === "WAITING_CUSTOMER_OK" && job.status !== "WAITING_CUSTOMER_OK" && job.approval != null;
      if (reopened) events = withEvent(events, { at: at.toISOString(), note: "New estimate: waiting for the customer's answer again" });
      // It was back at our counter and went to the repair shop again (not ready, not collected): the counter clock stops.
      const leftCounter = !!job.backAt && !READY.includes(status) && status !== "COLLECTED";
      await tx.repairJob.update({
        where: { shopId_id: { shopId, id: job.id } },
        data: {
          status,
          ticketNumber: optInt(d.ticketNumber, 0, 100_000_000, "ticket"),
          totalCents,
          taxCents: optInt(d.taxCents, 0, MAX_MONEY, "tax"),
          lines: lines as Json,
          commissionPct: settled ? job.commissionPct : terms.repairCommissionPct,
          commissionCents: commission,
          ...(reopened ? { approval: null, approvedCents: null } : {}),
          ...(leftCounter ? { backAt: null } : {}),
          repairNote: note,
          repairPaidCents: repairPaid,
          events,
          ...(paidAt && !job.paidAt ? { paidAt, paidWhere: job.paidCents ? "split" : "repair" } : {}),
          ...(status === "COLLECTED" && !job.pickedUpAt ? { pickedUpAt: at } : {}),
          snapshotAt: at,
        },
      });
      // The notices hook (ready notices and the like), in this transaction with the context applyOnce loaded before it.
      if (status !== job.status) {
        if (!ctx) throw new Error("job.update applied without a hook context (applyOnce loads it before the transaction)");
        await onJobStatus(
          tx,
          { id: job.id, shopId, linkId: link.id, customerId: job.customerId, status, backAt: leftCounter ? null : job.backAt, pickedUpAt: job.pickedUpAt ?? (status === "COLLECTED" ? at : null) },
          status,
          at,
          ctx,
        );
      }
      return;
    }

    case "job.reply": {
      const job = await repairSideJob(tx, shopId, link.id, d.id);
      if (!job?.ticketId) return;
      const approval = d.approval === "APPROVED" || d.approval === "DECLINED" ? d.approval : bad("approval must be APPROVED or DECLINED");
      const approvedCents = approval === "APPROVED" ? optInt(d.approvedCents, 0, MAX_MONEY, "approved amount") : null;
      const t = await tx.ticket.findUnique({ where: { id: job.ticketId } });
      if (!t) return;
      const who = text(d.name, 80);
      const line = `${at.toLocaleDateString("en-US", { timeZone: await shopTimeZone(shopId) })} ${link.partnerName}${who ? ` (${who})` : ""}: customer ${approval === "APPROVED" ? `approved${approvedCents != null ? ` up to $${(approvedCents / 100).toFixed(2)}` : ""}` : "declined the work"}${text(d.note, 500) ? ` - ${text(d.note, 500)}` : ""}`;
      await tx.ticket.update({
        where: { id: t.id },
        data: {
          ...(approval === "APPROVED" && approvedCents != null ? { approvedCents } : {}),
          ...(approval === "APPROVED" && t.status === "WAITING_CUSTOMER_OK" ? { status: "ON_BENCH" } : {}),
          notes: [t.notes, line].filter(Boolean).join("\n").slice(-20_000),
        },
      });
      await tx.repairJob.update({ where: { shopId_id: { shopId, id: job.id } }, data: { approval, approvedCents, events: withEvent(job.events, { at: at.toISOString(), note: line }) } });
      return;
    }

    case "job.paid": {
      const job = await repairSideJob(tx, shopId, link.id, d.id);
      if (!job?.ticketId) return;
      // Paid at the counter once; a repeat is not more money. The rest of a bill that went up after it was paid there
      // comes with everything paid there so far (paidCents): only what's new is added.
      const paidBefore = job.paidWhere === "shop" || job.paidWhere === "split" ? (job.paidCents ?? 0) : null;
      const amount = int(d.amountCents, 0, MAX_MONEY, "amount");
      const paidThere = d.paidCents == null ? null : int(d.paidCents, 0, MAX_MONEY, "paid");
      const adds = paidBefore == null ? amount : paidThere == null ? 0 : paidThere - paidBefore;
      if (adds <= 0) return;
      const saleNumber = optInt(d.saleNumber, 0, 100_000_000, "sale number");
      await tx.payment.create({
        data: { ticketId: job.ticketId, method: "SHOP_COLLECTED", amountCents: adds, paidAt: at, note: `Paid at ${link.partnerName}${saleNumber ? `, sale #${saleNumber}` : ""}` },
      });
      await tx.repairJob.update({ where: { shopId_id: { shopId, id: job.id } }, data: { paidCents: (paidBefore ?? 0) + adds, paidAt: job.paidAt ?? at, paidWhere: job.repairPaidCents ? "split" : "shop" } });
      return;
    }

    case "job.pickedup": {
      const job = await repairSideJob(tx, shopId, link.id, d.id);
      if (!job?.ticketId) return;
      const t = await tx.ticket.findUnique({ where: { id: job.ticketId } });
      // Only a machine that's back and ready can have been picked up.
      if (!t || !READY.includes(t.status)) return;
      await tx.ticket.update({
        where: { id: t.id },
        data: {
          status: t.status === "RETURNED_UNREPAIRED" ? t.status : "COLLECTED",
          closedAt: t.closedAt ?? at,
          pickupReadyAt: null, // off the pickup shelf: no more uncollected-machine notices
          // The warranty runs from the hub's time, never the partner's clock: the ticket and invoice show it.
          warrantyUntil: t.status === "RETURNED_UNREPAIRED" ? t.warrantyUntil : (t.warrantyUntil ?? new Date(hubAt.getTime() + shop.warrantyDays * 86400000)),
        },
      });
      await tx.repairJob.update({ where: { shopId_id: { shopId, id: job.id } }, data: { pickedUpAt: at } });
      return;
    }

    case "job.cancel": {
      const job = await repairSideJob(tx, shopId, link.id, d.id);
      if (!job?.ticketId) return;
      const t = await tx.ticket.findUnique({ where: { id: job.ticketId } });
      if (!t) return;
      const line = `${at.toLocaleDateString("en-US", { timeZone: await shopTimeZone(shopId) })} ${link.partnerName}: customer took the machine back before pickup${text(d.note, 500) ? ` - ${text(d.note, 500)}` : ""}`;
      await tx.ticket.update({
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
      if (await tx.partnerOrder.findUnique({ where: { shopId_id: { shopId, id } } })) return;
      // Each line is rebuilt from our own item: its number, description and our partner price. Lines for items we
      // don't offer are left out, and a different price asked is noted.
      const asked = arr(d.lines, 500, "order").map((x) => obj(x, "order line"));
      const lines: OrderLine[] = [];
      const notes: string[] = [];
      for (const a of asked) {
        const part = await tx.part.findFirst({ where: { id: String(a.itemKey ?? ""), shopId, offerToPartners: true, wholesaleCents: { not: null }, consignLinkId: null } });
        if (!part) {
          notes.push(`Left out: ${text(a.partNumber, 80) ?? "an item"} isn't offered any more.`);
          continue;
        }
        const raw = Math.abs(qtyOf(a.qty, "qty"));
        const qty = part.unit === "yd" ? raw : Math.round(raw);
        if (!(qty > 0)) continue;
        if (optInt(a.unitCents, 0, MAX_MONEY, "price") !== part.wholesaleCents) notes.push(`${part.partNumber}: the order showed a different price; your partner price is used.`);
        lines.push({ itemKey: part.id, partNumber: part.partNumber, description: part.description, qty, unitCents: part.wholesaleCents!, ...labelFields(part) });
      }
      if (!lines.length) return bad("the order has nothing we offer");
      const note = [text(d.note, 1000), ...notes].filter(Boolean).join("\n") || null;
      await tx.partnerOrder.create({
        data: {
          id,
          shopId,
          linkId: link.id,
          side: "seller",
          number: text(d.number, 30) ?? id.slice(-6),
          lines: lines as Json,
          totalCents: orderTotal(lines),
          note,
          events: [{ at: at.toISOString(), status: "PLACED", note: text(d.name, 80) ? `by ${text(d.name, 80)}` : undefined }] as Json,
          createdAt: at,
        },
      });
      // Our copy goes back, so the sewing shop's order shows the same lines, prices and total as ours (its catalog
      // may have been out of date). An older sewing shop install ignores it.
      await tx.partnerOutbox.create({
        data: { shopId, linkId: link.id, type: "order.update", data: { id, status: "PLACED", lines, totalCents: orderTotal(lines), eventNote: notes.filter((n) => n.startsWith("Left out")).join(" ") || undefined, at: new Date().toISOString() } as Json },
      });
      kickPartnerSync();
      return;
    }

    case "order.update": {
      const o = await tx.partnerOrder.findUnique({ where: { shopId_id: { shopId, id: idOf(d.id, "order") } } });
      if (!o || o.linkId !== link.id) return;
      const to = String(d.status ?? "");
      // What each side may do to an order, from where it stands on our copy.
      // Both shops can move a placed order at the same moment (a cancel and an acceptance cross on the way). The buyer's
      // screen only offers Cancel on a placed order, so a cancel that finds it accepted is one sent before the buyer
      // heard: nothing has shipped, so it stands. Once the repair shop has delivered, what it did stands, and the
      // buyer's cancelled copy takes the delivery. Either way the two copies end up the same.
      const legal =
        m.fromSide === "retail"
          ? ((o.status === "PLACED" || o.status === "ACCEPTED") && to === "CANCELLED") || (o.status === "DELIVERED" && to === "RECEIVED")
          : (o.status === "PLACED" && ["ACCEPTED", "DELIVERED", "CANCELLED"].includes(to)) ||
            (o.status === "ACCEPTED" && ["DELIVERED", "CANCELLED"].includes(to)) ||
            (o.side === "buyer" && o.status === "CANCELLED" && to === "DELIVERED");
      const who = m.fromSide === "retail" ? "the sewing shop" : "the repair shop";
      // The repair shop's copy of the order (its lines at its prices, items it no longer offers left out): ours takes
      // it, so both statements show the same total and only what was delivered is received here.
      let theirs: { lines: Json; totalCents: number } | null = null;
      if (m.fromSide === "repair" && d.lines != null && o.side === "buyer" && o.status !== "RECEIVED" && o.status !== "CANCELLED") {
        const lines: OrderLine[] = arr(d.lines, 500, "order").map((x) => {
          const l = obj(x, "order line");
          const qty = Math.abs(qtyOf(l.qty, "qty"));
          return {
            itemKey: idOf(l.itemKey, "item"),
            partNumber: need(l.partNumber, 80, "part number"),
            description: text(l.description, 300) ?? "",
            qty,
            unitCents: int(l.unitCents, 0, MAX_MONEY, "price"),
            ...labelFields(l),
          };
        });
        theirs = { lines: lines.filter((l) => l.qty > 0) as Json, totalCents: orderTotal(lines) };
      }
      if (theirs && (to === o.status || to === "PLACED")) {
        const changed = theirs.totalCents !== o.totalCents || linesKey(theirs.lines) !== linesKey(o.lines);
        if (!changed) return;
        const note = `${who}'s copy comes to $${(theirs.totalCents / 100).toFixed(2)} at its prices${text(d.eventNote, 500) ? `: ${text(d.eventNote, 500)}` : ""}`;
        await tx.partnerOrder.update({ where: { shopId_id: { shopId, id: o.id } }, data: { ...theirs, events: withEvent(o.events, { at: at.toISOString(), note }) } });
        return;
      }
      if (!legal) {
        // The repair shop's copy sent just after an order arrives says PLACED: an order already moved on here (cancelled,
        // received) has nothing to sort out.
        if (to !== o.status && to !== "PLACED") {
          await tx.partnerOrder.update({
            where: { shopId_id: { shopId, id: o.id } },
            data: { events: withEvent(o.events, { at: at.toISOString(), note: `${who} marked it ${to.toLowerCase() || "?"}, but it was already ${o.status.toLowerCase()} here: sort it out with them` }) },
          });
        }
        return;
      }
      await tx.partnerOrder.update({
        where: { shopId_id: { shopId, id: o.id } },
        data: {
          status: to,
          ...(theirs ?? {}),
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

    // consign.place, consign.return and consign.count carry an id of their own: the same one again (sent twice after a
    // lost answer, or from a feed that started over) changes nothing. Older installs send none; then only the hub
    // message's seen row (applyOnce) tells a repeat.
    case "consign.place": {
      const msgId = text(d.id, 80);
      if (msgId && !(await firstTime(tx, shopId, `consign.place:${link.id}:${msgId}`))) return;
      const items = arr(d.items, 500, "items").map((x) => obj(x, "item"));
      // New shelf items from this partner in the last hour (each is an inventory entry here): a flood is set aside.
      const lately = await tx.part.count({ where: { shopId, consignLinkId: link.id, createdAt: { gte: new Date(Date.now() - 3600_000) } } });
      if (lately + items.length > MAX_CONSIGN_ITEMS_PER_HOUR) return bad(`${link.partnerName} placed more than ${MAX_CONSIGN_ITEMS_PER_HOUR} consigned items within an hour`);
      for (const it of items) await receiveConsigned(shopId, link, it, at, tx);
      return;
    }

    case "consign.return": {
      const msgId = text(d.id, 80);
      if (msgId && !(await firstTime(tx, shopId, `consign.return:${link.id}:${msgId}`))) return;
      // The sewing shop hands stock back; we put it back on our shelf, never more than is out there.
      for (const x of arr(d.items, 500, "items")) {
        const it = obj(x, "item");
        await consignReturned(shopId, link, idOf(it.itemKey, "item"), Math.abs(qtyOf(it.qty, "qty")), at, tx);
      }
      return;
    }

    case "consign.sale": {
      const id = String(d.id ?? "");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return bad("sale id isn't valid");
      if (await tx.consignSale.findUnique({ where: { shopId_id: { shopId, id } } })) return;
      const itemKey = idOf(d.itemKey, "item");
      const qty = qtyOf(d.qty, "qty");
      const priceCents = int(d.priceCents, 0, MAX_MONEY, "price");
      if (qty === 0) return;
      const item = await tx.consignItem.findUnique({ where: { shopId_linkId_itemKey: { shopId, linkId: link.id, itemKey } } });
      if (!item) return bad("a consigned sale for an item that isn't on consignment");
      // A negative sale takes back sales we have: a void of one sale on their register ("<sale>-void"), or a customer's
      // return rung up at their counter. Never more than we've counted as sold of this item (with the register's slack:
      // 0.7 sold less 0.4 returned isn't exactly 0.3).
      let voided: { itemKey: string; shopKeepsCents: number | null; qty: number; priceCents: number } | null = null;
      if (qty < 0) {
        if (id.endsWith("-void")) {
          voided = await tx.consignSale.findUnique({ where: { shopId_id: { shopId, id: id.slice(0, -5) } } });
          if (!voided || voided.itemKey !== itemKey || voided.qty + SLACK < -qty) return bad("a voided consigned sale doesn't match a sale");
        }
        if (item.sold + SLACK < -qty) return bad("a consigned return is more than was sold");
      }
      const gross = Math.round(qty * priceCents);
      // A void takes back exactly the share the sale gave (as the sewing shop's register does), not one worked out
      // again from today's terms and rounded the other way.
      const voidedKeeps = voided && Math.abs(voided.qty + qty) < SLACK ? (voided.shopKeepsCents ?? Math.round((Math.round(voided.qty * voided.priceCents) * terms.consignSharePct) / 100)) : null;
      await tx.consignSale.create({
        data: {
          id,
          shopId,
          linkId: link.id,
          itemKey,
          qty,
          priceCents,
          saleNumber: optInt(d.saleNumber, 0, 100_000_000, "sale number"),
          soldAt: at,
          shopKeepsCents: voidedKeeps != null ? -voidedKeeps : Math.round((gross * terms.consignSharePct) / 100),
        },
      });
      // A return takes back only what is still counted as sold at the moment it is written (as the register's does).
      const took = await tx.consignItem.updateMany({ where: { id: item.id, ...(qty < 0 ? { sold: { gte: -qty - SLACK } } : {}) }, data: { sold: { increment: qty } } });
      if (!took.count) return bad("a consigned return is more than was sold");
      return;
    }

    case "consign.count": {
      const msgId = text(d.id, 80);
      if (msgId && !(await firstTime(tx, shopId, `consign.count:${link.id}:${msgId}`))) return;
      for (const x of arr(d.items, 5000, "items")) {
        const it = obj(x, "item");
        await tx.consignItem.updateMany({
          where: { shopId, linkId: link.id, itemKey: idOf(it.itemKey, "item") },
          data: { countedQty: Math.abs(qtyOf(it.onHand, "count")), countedAt: at },
        });
      }
      return;
    }

    case "pickup.plan":
    case "pickup.ok":
    case "pickup.cancel":
    case "pickup.done":
      return applyRun(tx, shopId, link, partnerSide, m.type, d, at, ctx);

    case "caps.update": {
      const features = strings(d.features).slice(0, 20);
      const hadPickup = link.features.includes("pickup");
      await tx.partnerLink.update({ where: lk, data: { features } });
      // An upgraded partner that can take runs now gets every scheduled run of ours at its current plan.
      if (!hadPickup && features.includes("pickup")) {
        const runs = await tx.partnerRun.findMany({ where: { shopId, linkId: link.id, status: "SCHEDULED", ownerSide: link.side } });
        for (const r of runs) await sendRun(tx, shopId, link.id, "pickup.plan", runPlan(r, "") as unknown as Json);
      }
      return;
    }

    case "msg.rejected": {
      // The partner couldn't take something we sent: it's shown with what we sent, and on the job or order it was about.
      const sent = await tx.partnerOutbox.findFirst({ where: { shopId, linkId: link.id, id: idOf(d.id, "message") } });
      if (!sent?.sentAt) return;
      const reason = `${link.partnerName} couldn't take it: ${text(d.reason, 500) ?? "no reason given"}`;
      await tx.partnerOutbox.update({ where: { id: sent.id }, data: { deadAt: sent.deadAt ?? hubAt, error: reason } });
      const sentData = sent.data && typeof sent.data === "object" && !Array.isArray(sent.data) ? (sent.data as Obj) : {};
      if (sent.type === "terms.accept") {
        const version = Number(sentData.version);
        // We had taken their proposal as agreed, and they had replaced it before our acceptance arrived (their newer
        // proposal is here, or on its way): the terms in force before come back, and the withdrawn ones are kept
        // aside so the agreement page can say what happened.
        const prior = link.priorTerms as PriorTerms | null;
        if (prior && prior.adoptedVersion === version && version === link.termsVersion) {
          const withdrawn: WithdrawnTerms = { version, terms: link.terms, reason: text(d.reason, 500), at: hubAt.toISOString() };
          await tx.partnerLink.update({
            where: lk,
            data: { terms: prior.terms as Json, termsVersion: prior.termsVersion, accepted: prior.accepted as Json, priorTerms: Prisma.DbNull, withdrawnTerms: withdrawn as Json },
          });
          return;
        }
        // Our acceptance didn't take on their side: these terms aren't agreed by both, whatever we recorded for them.
        const accepted = { ...((link.accepted as Accepted) ?? {}) };
        if (version === link.termsVersion && accepted[partnerSide]?.version === link.termsVersion) {
          delete accepted[partnerSide];
          await tx.partnerLink.update({ where: lk, data: { accepted: accepted as Json } });
        }
        return;
      }
      const about = String(sentData.id ?? "");
      if (!about) return;
      const note = `${sent.type} ${reason}`;
      if (sent.type.startsWith("job.")) {
        const job = await tx.repairJob.findUnique({ where: { shopId_id: { shopId, id: about } } });
        if (job?.linkId === link.id) await tx.repairJob.update({ where: { shopId_id: { shopId, id: job.id } }, data: { events: withEvent(job.events, { at: hubAt.toISOString(), note }) } });
      } else if (sent.type.startsWith("order.")) {
        const o = await tx.partnerOrder.findUnique({ where: { shopId_id: { shopId, id: about } } });
        if (o?.linkId === link.id) await tx.partnerOrder.update({ where: { shopId_id: { shopId, id: o.id } }, data: { events: withEvent(o.events, { at: hubAt.toISOString(), note }) } });
      }
      return;
    }

    case "settle.paid": {
      const id = idOf(d.id, "payment");
      if (await tx.settlement.findUnique({ where: { shopId_id: { shopId, id } } })) return;
      // A shop records only the payments it made (+ the sewing shop paid the repair shop, - the other way round); a
      // settlement claiming the other shop paid can't come from it.
      const netCents = int(d.netCents, -MAX_MONEY, MAX_MONEY, "amount");
      if (m.fromSide === "retail" ? netCents <= 0 : netCents >= 0) return bad("a settlement can only record a payment the shop sending it made");
      // Stored as the partner's word (confirmedAt empty): it counts in the balance once someone here confirms the money
      // arrived, so a payment claimed and never made doesn't wipe out what the partner owes.
      await tx.settlement.create({
        data: {
          id,
          shopId,
          linkId: link.id,
          periodFrom: dateOf(d.periodFrom, "periodFrom"),
          periodTo: dateOf(d.periodTo, "periodTo"),
          netCents,
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

async function repairSideJob(tx: Prisma.TransactionClient, shopId: string, linkId: string, id: unknown) {
  const job = await tx.repairJob.findUnique({ where: { shopId_id: { shopId, id: idOf(id, "job") } } });
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
      ...labelFields(l),
    }))
    .filter((l) => l.itemKey && l.qty > 0);
}

export const orderTotal = (lines: OrderLine[]) => lines.reduce((a, l) => a + Math.round(l.qty * l.unitCents), 0);

/**
 * A repair shop's machine that a sewing shop took in: a ticket on the repair shop's bench, in its route flow. All in
 * the message's transaction (`tx`): a try that fails leaves no machine or ticket behind for the next try to repeat.
 */
async function newJobFromPartner(shopId: string, link: { id: string; partnerName: string; accountId: string | null; terms: unknown }, d: Obj, at: Date, tx: Prisma.TransactionClient) {
  const id = idOf(d.id, "job");
  if (await tx.repairJob.findUnique({ where: { shopId_id: { shopId, id } } })) return;
  const terms = normalizeTerms(link.terms);
  const brand = text(d.brand, 80) ?? "Unknown";
  const model = text(d.model, 80) ?? "Unknown";
  const serial = text(d.serial, 80);
  const tag = text(d.tag, 20) ?? "?";
  const customerName = text(d.customerName, 80) ?? "Customer";
  const photos = arr(d.photos, 8, "photos").map((x) => obj(x, "photo"));
  // Machines this partner sent in the last hour, counted by when the ticket was opened here (not by the partner's
  // clock): past the limit, the intake is set aside and shown, and the shop can ask the partner what's going on.
  const hourAgo = new Date(Date.now() - 3600_000);
  const lately = link.accountId
    ? await tx.ticket.count({ where: { shopId, viaAccountId: link.accountId, createdAt: { gte: hourAgo } } })
    : await tx.repairJob.count({ where: { shopId, linkId: link.id, side: "repair", createdAt: { gte: hourAgo } } });
  if (lately >= MAX_INTAKES_PER_HOUR) return bad(`${link.partnerName} sent more than ${MAX_INTAKES_PER_HOUR} machines within an hour`);
  const existing = serial ? await tx.machine.findFirst({ where: { shopId, serial: sameText(serial), modelKey: modelKey(model) } }) : null;
  const machine = existing ?? (await tx.machine.create({ data: { shopId, brand, model, modelKey: modelKey(model), serial, machineType: text(d.machineType, 60) } }));
  // The next free ticket number, taken atomically (a tech may be checking a machine in at the same moment). A counter
  // behind the tickets goes straight past the highest number, as createTicket does, not one used number at a time.
  let number = (await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: { increment: 1 } }, select: { nextTicketNumber: true } })).nextTicketNumber - 1;
  if (await tx.ticket.findFirst({ where: { shopId, number }, select: { id: true } })) {
    const top = await tx.ticket.aggregate({ where: { shopId }, _max: { number: true } });
    number = (top._max.number ?? 0) + 1;
    await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: number + 1 } });
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
  // Photos that don't fit the intake's budget together are left out, the way an odd one is; the ticket still opens.
  let budget = MAX_INTAKE_PHOTO_CHARS;
  for (const p of photos) {
    const mime = String(p.mime ?? "");
    const b64 = String(p.data ?? "");
    if (!IMAGE.has(mime) || !b64 || b64.length > 3_000_000 || b64.length > budget) continue;
    budget -= b64.length;
    await tx.machinePhoto.create({
      data: { shopId, machineId: machine.id, ticketId: t.id, kind: "CONDITION", caption: text(p.caption, 200) ?? `At intake, ${link.partnerName}`, mime, data: Buffer.from(b64, "base64") },
    });
  }
}

/**
 * A part number not yet used on this shop, from `number` with a suffix when needed. Numbers are one whatever their
 * case here (a unique index on the lower-cased number), so the check is case-blind too: "abc-1" is taken by "ABC-1".
 */
async function freePartNumber(tx: Prisma.TransactionClient, shopId: string, number: string, suffix: string) {
  const taken = (candidate: string) => tx.part.findFirst({ where: { shopId, partNumber: sameText(candidate) }, select: { id: true } });
  if (!(await taken(number))) return number;
  for (let i = 1; i < 100; i++) {
    const candidate = `${number} (${suffix}${i > 1 ? ` ${i}` : ""})`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${number} (${crypto.randomUUID().slice(0, 8)})`;
}

/** Consigned stock arriving on the sewing shop's shelf: its own inventory item, marked as the partner's. */
async function receiveConsigned(shopId: string, link: { id: string; partnerName: string }, it: Obj, at: Date, tx: Prisma.TransactionClient) {
  const itemKey = idOf(it.itemKey, "item");
  const qty = qtyOf(it.qty, "qty");
  if (qty <= 0) return;
  const price = int(it.priceCents, 0, MAX_MONEY, "shelf price");
  const number = need(it.partNumber, 80, "part number");
  const unit = it.unit === "yd" ? "yd" : null;
  // As the owner has the item now; an owner from before these were sent has only new, genuine items.
  const condition = asCondition(it.condition) ?? "NEW";
  const origin = asOrigin(it.origin) ?? "GENUINE";
  // The same item again, or the same number from this partner: one inventory entry.
  let part =
    (await tx.part.findFirst({ where: { shopId, consignLinkId: link.id, consignItemKey: itemKey } })) ??
    (await tx.part.findFirst({ where: { shopId, consignLinkId: link.id, OR: [{ partNumber: sameText(number) }, { altNumbers: { has: number } }] } }));
  if (!part) {
    const partNumber = await freePartNumber(tx, shopId, number, link.partnerName.slice(0, 20));
    const kind = KINDS.includes(String(it.kind)) ? String(it.kind) : "ACCESSORY";
    part = await tx.part.create({
      data: {
        shopId,
        partNumber,
        description: text(it.description, 300) ?? number,
        brand: text(it.brand, 80),
        kind: kind as "ACCESSORY",
        unit,
        condition,
        origin,
        priceCents: price,
        altNumbers: partNumber !== number ? [number] : [],
        numberKeys: [...new Set([partNumber, number].map((x) => x.toUpperCase().replace(/[^A-Z0-9]/g, "")))].filter((k) => k.length >= 3),
        consignLinkId: link.id,
        consignItemKey: itemKey,
        notes: `On consignment from ${link.partnerName}`,
      },
    });
  }
  await tx.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: qty }, priceCents: price || part.priceCents, consignItemKey: itemKey, condition, origin } });
  await tx.stockMove.create({ data: { shopId, partId: part.id, qty, reason: "CONSIGNED", note: `Consignment from ${link.partnerName}`, createdAt: at } });
  await tx.consignItem.upsert({
    where: { shopId_linkId_itemKey: { shopId, linkId: link.id, itemKey } },
    create: { shopId, linkId: link.id, side: "holder", itemKey, partId: part.id, partNumber: part.partNumber, description: part.description, priceCents: price, placed: qty },
    update: { placed: { increment: qty }, priceCents: price || undefined, partId: part.id },
  });
}

/**
 * Consigned stock going back to the repair shop, recorded by the sewing shop (which hands it over) and applied on both
 * sides; never more than is still out on the shelf.
 */
export async function consignReturned(shopId: string, link: { id: string; side: string; partnerName: string }, itemKey: string, qty: number, at: Date, outer?: Prisma.TransactionClient) {
  if (!(qty > 0)) return 0;
  // Inside the caller's transaction when it has one (so the message to the other shop is queued with the change).
  const run = async (tx: Prisma.TransactionClient) => {
    const item = await tx.consignItem.findUnique({ where: { shopId_linkId_itemKey: { shopId, linkId: link.id, itemKey } } });
    if (!item) return 0;
    const onShelf = Math.max(0, item.placed - item.sold - item.returned);
    // Within the register's slack, what's handed back is all that was out there (0.7 placed less 0.4 sold isn't 0.3 exactly).
    const back = qty <= onShelf + SLACK ? qty : onShelf;
    if (!(back > SLACK)) return 0;
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
  };
  return outer ? run(outer) : db.$transaction(run);
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
  const confirmed = settlements.filter((x) => x.confirmedAt);
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
      paidInPeriodCents: confirmed.reduce((a, x) => a + x.netCents, 0),
    },
    balanceCents: balance,
  };
}

/** Everything owed since the partnership began, less what was settled (and confirmed). + = the sewing shop owes the repair shop. */
async function runningBalance(shopId: string, linkId: string, terms: PartnerTerms) {
  const [jobs, sales, orders, settled] = await Promise.all([
    db.repairJob.findMany({ where: { shopId, linkId, paidAt: { not: null } }, select: { paidCents: true, commissionCents: true } }),
    db.consignSale.findMany({ where: { shopId, linkId }, select: { qty: true, priceCents: true, shopKeepsCents: true } }),
    db.partnerOrder.aggregate({ where: { shopId, linkId, status: { in: ["DELIVERED", "RECEIVED"] } }, _sum: { totalCents: true } }),
    db.settlement.aggregate({ where: { shopId, linkId, confirmedAt: { not: null } }, _sum: { netCents: true } }),
  ]);
  const repairs = jobs.reduce((a, j) => a + jobOwed(j), 0);
  const consign = sales.reduce((a, x) => a + consignShare(x, terms).owed, 0);
  return repairs + consign + (orders._sum.totalCents ?? 0) - (settled._sum.netCents ?? 0);
}

// Statement months and the zone helpers live with the other shop-time-zone helpers.
// ---------- partner pickup runs (scheduling-messaging-design.md section 13) ----------

type RunRow = Prisma.PartnerRunGetPayload<object>;
type LinkForRun = { id: string; side: string; partnerName: string };

/** The plan as it goes to the partner (`pickup.plan`): everything the owner decides, at this revision. */
export function runPlan(run: RunRow, name: string): RunPlan {
  return {
    id: run.id,
    rev: run.rev,
    ownerSide: run.ownerSide as RunSide,
    startsAt: run.startsAt.toISOString(),
    endsAt: run.endsAt ? run.endsAt.toISOString() : null,
    driver: run.driver as RunSide,
    collect: run.collect,
    deliver: run.deliver,
    note: run.note,
    name,
    at: new Date().toISOString(),
  };
}

/** A run message to the partner, in the transaction that changed the run. */
export async function sendRun(tx: Prisma.TransactionClient, shopId: string, linkId: string, type: string, data: Json) {
  await sendToPartner(shopId, linkId, type, data, tx);
}

/** The plan's fields as a partner sent them, checked against the message's own `at` (a replay still applies). */
function runPlanOf(d: Obj, at: Date) {
  const startsAt = new Date(String(d.startsAt ?? ""));
  if (Number.isNaN(startsAt.getTime())) return bad("the run has no start");
  if (startsAt.getTime() < at.getTime() - 60 * 86400_000 || startsAt.getTime() > at.getTime() + 366 * 86400_000) return bad("the run's start is out of range");
  let endsAt: Date | null = null;
  if (d.endsAt != null && d.endsAt !== "") {
    endsAt = new Date(String(d.endsAt));
    if (Number.isNaN(endsAt.getTime()) || endsAt < startsAt || endsAt.getTime() >= startsAt.getTime() + 24 * 3600_000) return bad("the run's end is out of range");
  }
  const driver: RunSide = d.driver === "retail" ? "retail" : "repair";
  const ids = (v: unknown, what: string) => arr(v, 200, what).map((x) => idOf(x, what));
  return { rev: int(d.rev, 1, 1_000_000, "rev"), startsAt, endsAt, driver, collect: ids(d.collect, "collect"), deliver: ids(d.deliver, "deliver"), note: text(d.note, 1000), name: text(d.name, 80) ?? "the partner" };
}

const dayWords = (d: Date, tz: string) => d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });

/**
 * A run message from the partner (design 13.2 "Apply"), idempotent: a replay changes nothing. `from` is the partner's
 * side; `ctx` is the notices context loaded before the transaction (the hand-off's status changes queue notices).
 */
export async function applyRun(tx: Prisma.TransactionClient, shopId: string, link: LinkForRun, from: RunSide, type: string, d: Obj, at: Date, ctx: HookCtx | null) {
  const id = idOf(d.id, "run id");
  const local = await tx.partnerRun.findUnique({ where: { shopId_id: { shopId, id } } });
  const state = local ? { status: local.status as "SCHEDULED" | "CANCELLED" | "DONE", ownerSide: local.ownerSide as RunSide, rev: local.rev, okRev: local.okRev, collectedAt: local.collectedAt?.toISOString() ?? null, deliveredAt: local.deliveredAt?.toISOString() ?? null } : null;
  switch (type) {
    case "pickup.plan": {
      const p = runPlanOf(d, at);
      const owner: RunSide = d.ownerSide === "retail" ? "retail" : "repair";
      const plan: RunPlan = { id, rev: p.rev, ownerSide: owner, startsAt: p.startsAt.toISOString(), endsAt: p.endsAt?.toISOString() ?? null, driver: p.driver, collect: p.collect, deliver: p.deliver, note: p.note, name: p.name, at: at.toISOString() };
      const outcome = planOutcome(state, plan, from);
      if (outcome === "ignore") return;
      const fields = { startsAt: p.startsAt, endsAt: p.endsAt, driver: p.driver, collect: p.collect, deliver: p.deliver, note: p.note, rev: p.rev };
      if (outcome === "create") {
        await tx.partnerRun.create({ data: { id, shopId, linkId: link.id, ownerSide: owner, ...fields, events: [{ at: at.toISOString(), side: from, what: "scheduled", name: p.name }] as Json } });
      } else {
        await tx.partnerRun.updateMany({ where: { shopId, id, status: "SCHEDULED", rev: { lt: p.rev } }, data: { ...fields, events: withRunEvent(local!.events, { at: at.toISOString(), side: from, what: "changed", name: p.name }) } });
      }
      return;
    }
    case "pickup.ok": {
      if (!local || local.status !== "SCHEDULED") return;
      const rev = int(d.rev, 1, 1_000_000, "rev");
      if (rev !== local.rev || local.okRev === rev) return; // an OK of an older plan: the page says "changed since"
      await tx.partnerRun.updateMany({ where: { shopId, id, status: "SCHEDULED", rev }, data: { okRev: rev, okAt: at, events: withRunEvent(local.events, { at: at.toISOString(), side: from, what: "ok", name: text(d.name, 80) ?? undefined }) } });
      return;
    }
    case "pickup.cancel": {
      if (!local || local.status !== "SCHEDULED") return;
      await tx.partnerRun.updateMany({ where: { shopId, id, status: "SCHEDULED" }, data: { status: "CANCELLED", cancelledAt: at, events: withRunEvent(local.events, { at: at.toISOString(), side: from, what: "cancelled", name: text(d.name, 80) ?? undefined, note: text(d.note, 1000) ?? undefined }) } });
      return;
    }
    case "pickup.done": {
      if (!local) return;
      const side: RunSide = d.side === "retail" ? "retail" : "repair";
      if (side !== from) return bad("pickup.done names the wrong side");
      const list = arr(d.list, 200, "list").map((x) => idOf(x, "job"));
      const which = receivedList(side);
      if (local[which + "At" as "collectedAt" | "deliveredAt"]) return; // the first record stands
      await tx.partnerRun.updateMany({
        where: { shopId, id, [which + "At"]: null },
        data: { [which]: list, [which + "At"]: at, status: "DONE", events: withRunEvent(local.events, { at: at.toISOString(), side: from, what: which, name: text(d.name, 80) ?? undefined }) },
      });
      await runEffects(tx, shopId, link, side, list, at, null, ctx);
      return;
    }
  }
}

function withRunEvent(events: unknown, e: { at: string; side: string; what: string; name?: string; note?: string }): Json {
  const list = Array.isArray(events) ? (events as Json[]) : [];
  return [...list, e as unknown as Json].slice(-MAX_EVENTS) as Json;
}

/**
 * What a hand-off changes (design 13.3). `side` is who recorded the list: the repair shop's `collected` (the driver
 * took these) or the sewing shop's `delivered` (these reached its counter). On the side that recorded it the machines
 * change status here; on the other side (applied from the message) only what that side owns changes.
 */
export async function runEffects(tx: Prisma.TransactionClient, shopId: string, link: LinkForRun, side: RunSide, list: string[], at: Date, byUserId: string | null, ctx: HookCtx | null) {
  if (!list.length) return;
  const tz = await shopTimeZone(shopId);
  const day = dayWords(at, tz);
  const jobs = await tx.repairJob.findMany({ where: { shopId, linkId: link.id, side: link.side, id: { in: list } } });
  if (!jobs.length) return;
  const context = ctx ?? (await hookContext(shopId));
  const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId }, select: { warrantyDays: true } });
  if (side === "repair") {
    if (link.side === "repair") {
      // Recorded here: the machines the driver took are in the truck.
      for (const j of jobs) {
        if (!j.ticketId) continue;
        const t = await tx.ticket.findFirst({ where: { id: j.ticketId, shopId } });
        if (t && t.status === "AT_SHOP_AWAITING_PICKUP") await changeTicketStatus(tx, t, "IN_TRUCK", at, shop.warrantyDays, context);
      }
    } else {
      // The sewing shop hears the driver took them: a line on each job (the repair shop's job.update sets the status).
      for (const j of jobs) await tx.repairJob.update({ where: { shopId_id: { shopId, id: j.id } }, data: { events: withEvent(j.events, { at: at.toISOString(), note: `Handed to the driver (run ${day})` }) } });
    }
    return;
  }
  if (link.side === "retail") {
    // Recorded here: the fixed machines are back at the counter; the ready notice goes (Marketing on).
    const back: string[] = [];
    for (const j of jobs) {
      if (j.backAt || j.pickedUpAt) continue;
      const r = await tx.repairJob.updateMany({ where: { shopId, id: j.id, backAt: null, pickedUpAt: null }, data: { backAt: at, events: withEvent(j.events, { at: at.toISOString(), note: `Back at the counter (run ${day})` }) } });
      if (r.count) back.push(j.id);
    }
    if (back.length) await onJobsBack(tx, shopId, back, at, byUserId, context);
  } else {
    // The repair shop hears they arrived: the tickets come off "in truck" onto the sewing shop's shelf.
    for (const j of jobs) {
      if (!j.ticketId) continue;
      const t = await tx.ticket.findFirst({ where: { id: j.ticketId, shopId } });
      if (t && t.status === "READY_IN_TRUCK") await changeTicketStatus(tx, t, "READY_FOR_PICKUP", at, shop.warrantyDays, context);
    }
  }
}

/** Tells every active partner what this install can do (`caps.update`), once per change. */
export async function pushFeatures() {
  const features = ["pickup"]; // this version takes runs, whatever the modules
  const h = hash(features);
  const links = await db.partnerLink.findMany({ where: { status: "ACTIVE" }, select: { shopId: true, id: true, featuresHash: true } });
  for (const l of links) {
    if (l.featuresHash === h) continue;
    try {
      await db.$transaction([
        db.partnerOutbox.create({ data: { shopId: l.shopId, linkId: l.id, type: "caps.update", data: { features } as Json } }),
        db.partnerLink.update({ where: { shopId_id: { shopId: l.shopId, id: l.id } }, data: { featuresHash: h } }),
      ]);
    } catch (e) {
      console.error("partner sync: caps.update couldn't be queued:", e instanceof Error ? e.message : e);
    }
  }
}

export { monthPeriod, zonedMidnight, zonedParts } from "@/lib/time-zone";
