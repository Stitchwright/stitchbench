import "server-only";
// Live-sale claim list (shop-features-round-2-design.md 4.3). A Live sale page for a phone or tablet beside the camera:
// pick what's on today's show beforehand, then for each buyer called out: the item, her name (finds the customer; a new
// name is fine) and how many (yards in eighths for fabric); Claim holds the stock. A running list shows the claims and
// what's left. When the show ends, "Send pay links" groups each buyer's claims into one pay link (1.3, makePayLinkFor)
// by her usual way. Paid, her claims are paid (the pay link's sale takes the stock off). Unpaid after the hold time
// (48 hours by default): "Let go of these?" takes the link back and puts the stock back. Held stock is counted, not
// moved: what's left = on hand - held. Every query by shopId; bodies take the user so the check script can drive them.
import { db } from "@/lib/db";
import { isUserError, UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { customerIdsByPhone } from "@/lib/phone-search";
import { validEmail } from "@/lib/phone";
import { inEighths, qtyText } from "@/lib/register-math";
import { cancelPayLinkFor, makePayLinkFor, payLinkProblem, resendPayLinkFor } from "@/lib/pay-links";
import { atStore, currentStoreId, storeOfRow } from "@/lib/stores";
import { storeQty, withStoreQty } from "@/lib/stock";

export const HELD_STATUSES = ["HELD", "SENT"];
export const CLAIM_WORDS: Record<string, string> = { HELD: "Held for her", SENT: "Pay link sent", PAID: "Paid", LET_GO: "Let go" };
const ID_RE = /^[a-z0-9]{10,40}$/i;

/** How much of each item is held for live-sale buyers (claimed, not yet paid or let go). */
export async function liveHeld(shopId: string, partIds?: string[], store?: { id: string; main: boolean } | null): Promise<Map<string, number>> {
  const rows = await db.liveClaim.groupBy({
    by: ["partId"],
    // With a store: only the claims of that store's live sales (each store's shelf holds its own claims, 7.2).
    where: { shopId, status: { in: HELD_STATUSES }, partId: partIds ? { in: partIds } : { not: null }, ...(store ? { liveSale: atStore(store) } : {}) },
    _sum: { qty: true },
  });
  return new Map(rows.filter((r) => r.partId).map((r) => [r.partId!, Math.round((r._sum.qty ?? 0) * 1000) / 1000]));
}

async function ownSale(user: CurrentUser, id: string) {
  const s = typeof id === "string" && ID_RE.test(id) ? await db.liveSale.findFirst({ where: { id, shopId: user.shopId } }) : null;
  if (!s) throw new UserError("Live sale not found.");
  return s;
}

/** "Start a live sale": a name (default "Facebook Live, Oct 7") and how long claims are held unpaid. */
export async function startLiveSaleFor(user: CurrentUser, a: { name?: string | null; holdHours?: number | null }, now = new Date()): Promise<string> {
  await requireBaseWritable(user);
  const hold = Number(a.holdHours ?? 48);
  if (!Number.isInteger(hold) || hold < 1 || hold > 24 * 14) throw new UserError("Hold claims for 1 hour to 14 days (336 hours).");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true } });
  const day = now.toLocaleDateString("en-US", { timeZone: shop.timeZone, month: "short", day: "numeric" });
  // Run from this store: its shelf holds the claims (7.2).
  const s = await db.liveSale.create({ data: { shopId: user.shopId, locationId: await currentStoreId(user), name: (a.name?.trim() || `Facebook Live, ${day}`).slice(0, 120), holdHours: hold, startsAt: now, createdById: user.id } });
  return s.id;
}

/** Puts an item on (or takes it off) "On today's show". */
export async function setPickFor(user: CurrentUser, saleId: string, partId: string, on: boolean): Promise<void> {
  const s = await ownSale(user, saleId);
  if (on) {
    const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId }, select: { id: true, kind: true } });
    if (!p) throw new UserError("Item not found.");
    if (p.kind === "MACHINE") throw new UserError("That's a machine model to order, not something on the shelf.");
  }
  const picks = on ? [...new Set([...s.picks, partId])].slice(0, 200) : s.picks.filter((x) => x !== partId);
  await db.liveSale.updateMany({ where: { id: s.id, shopId: user.shopId }, data: { picks } });
}

export type ClaimInput = { partId: string; customerId?: string | null; name?: string | null; phone?: string | null; qty: number; priceCents?: number | null };

/** "Claim": holds the stock for the buyer. A tech claims at the item's price; an owner or admin may type a show price. */
export async function claimFor(user: CurrentUser, saleId: string, c: ClaimInput, now = new Date()): Promise<string> {
  await requireBaseWritable(user);
  const s = await ownSale(user, saleId);
  if (s.status !== "OPEN") throw new UserError("This live sale has ended. Start a new one.");
  const p = typeof c.partId === "string" ? await db.part.findFirst({ where: { id: c.partId, shopId: user.shopId } }) : null;
  if (!p) throw new UserError("Choose the item first.");
  if (p.kind === "MACHINE") throw new UserError("That's a machine model to order, not something on the shelf.");
  const qty = Number(c.qty);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 999) throw new UserError("Type how many.");
  if (p.unit === "yd" ? !inEighths(qty) : !Number.isInteger(qty)) throw new UserError(p.unit === "yd" ? "Fabric is cut in eighths of a yard: type 1, 1.5 or 2 3/8 as 2.375." : "Type a whole number.");
  let price = p.priceCents;
  if (c.priceCents != null && c.priceCents !== p.priceCents) {
    if (user.role === "TECH") throw new UserError("Only an owner or admin can change the price.");
    price = Math.round(Number(c.priceCents));
  }
  if (price == null || !Number.isFinite(price) || price < 0) throw new UserError(`${p.partNumber} has no price: give it one first.`);
  let customer: { id: string; name: string; phone: string | null } | null = null;
  if (c.customerId) {
    customer = await db.customer.findFirst({ where: { id: c.customerId, shopId: user.shopId }, select: { id: true, name: true, phone: true } });
    if (!customer) throw new UserError("Customer not found.");
  }
  const name = (customer?.name ?? c.name ?? "").trim().slice(0, 120);
  if (!name) throw new UserError("Type the buyer's name.");
  // What's on the live sale's store's shelf, less what its claims hold (7.2).
  const store = await storeOfRow(user.shopId, s.locationId);
  const held = (await liveHeld(user.shopId, [p.id], store)).get(p.id) ?? 0;
  const left = Math.max(0, (await storeQty(db, user.shopId, p.id, store?.id ?? null)) - held);
  if (qty > left + 1e-9) throw new UserError(left > 0 ? `Only ${qtyText(left, p.unit)} left of ${p.description}.` : `${p.description} is all claimed.`);
  const claim = await db.liveClaim.create({
    data: {
      shopId: user.shopId,
      liveSaleId: s.id,
      customerId: customer?.id ?? null,
      name,
      phone: (customer?.phone ?? c.phone?.trim() ?? "").slice(0, 40) || null,
      partId: p.id,
      description: (p.onlineTitle?.trim() || p.description).slice(0, 200),
      qty,
      unit: p.unit,
      priceCents: price,
      createdById: user.id,
      createdAt: now,
    },
  });
  if (!s.picks.includes(p.id)) await db.liveSale.updateMany({ where: { id: s.id, shopId: user.shopId }, data: { picks: [...s.picks, p.id].slice(0, 200) } });
  return claim.id;
}

/** Takes a claim off before its pay link goes (a mistake, or she changed her mind): the stock is free again. */
export async function dropClaimFor(user: CurrentUser, claimId: string, now = new Date()): Promise<void> {
  const r = await db.liveClaim.updateMany({ where: { id: claimId, shopId: user.shopId, status: "HELD" }, data: { status: "LET_GO", letGoAt: now } });
  if (!r.count) {
    const c = await db.liveClaim.findFirst({ where: { id: claimId, shopId: user.shopId }, select: { status: true } });
    if (!c) throw new UserError("Claim not found.");
    throw new UserError(c.status === "SENT" ? "Her pay link has gone: use Let go of these." : "That claim is done already.");
  }
}

/** Puts a dropped claim back (Undo), if the stock is still there. */
export async function undropClaimFor(user: CurrentUser, claimId: string): Promise<void> {
  const c = await db.liveClaim.findFirst({ where: { id: claimId, shopId: user.shopId, status: "LET_GO", webOrderId: null } });
  if (!c) throw new UserError("Claim not found.");
  if (c.partId) {
    const p = await db.part.findFirst({ where: { id: c.partId, shopId: user.shopId }, select: { qtyOnHand: true } });
    const sale = await db.liveSale.findFirst({ where: { id: c.liveSaleId, shopId: user.shopId }, select: { locationId: true } });
    const store = await storeOfRow(user.shopId, sale?.locationId ?? null);
    const held = (await liveHeld(user.shopId, [c.partId], store)).get(c.partId) ?? 0;
    if (!p || (await storeQty(db, user.shopId, c.partId, store?.id ?? null)) - held < c.qty - 1e-9) throw new UserError("That stock has been claimed since.");
  }
  await db.liveClaim.updateMany({ where: { id: c.id, shopId: user.shopId }, data: { status: "HELD", letGoAt: null } });
}

/** Claims whose pay link was paid become paid. Run when the page is opened. */
export async function syncClaims(shopId: string, saleId?: string): Promise<void> {
  const sent = await db.liveClaim.findMany({ where: { shopId, status: "SENT", webOrderId: { not: null }, ...(saleId ? { liveSaleId: saleId } : {}) }, select: { id: true, webOrderId: true } });
  if (!sent.length) return;
  const orders = await db.webOrder.findMany({ where: { shopId, id: { in: [...new Set(sent.map((c) => c.webOrderId!))] } }, select: { id: true, status: true, paidAt: true } });
  for (const o of orders) {
    if (["PAID", "READY", "DONE"].includes(o.status)) await db.liveClaim.updateMany({ where: { shopId, webOrderId: o.id, status: "SENT" }, data: { status: "PAID", paidAt: o.paidAt ?? new Date() } });
  }
}

const buyerKey = (c: { customerId: string | null; name: string; phone: string | null }) => c.customerId ?? `new:${c.name.toLowerCase()}|${(c.phone ?? "").replace(/\D/g, "")}`;

/** The customer a new name becomes when her link is sent: one with the same phone, else a new customer. */
async function customerForBuyer(user: CurrentUser, c: { name: string; phone: string | null }): Promise<string> {
  const phone = c.phone?.trim() || null;
  const email = phone && phone.includes("@") ? validEmail(phone) : null;
  if (phone && !email) {
    const ids = await customerIdsByPhone(user.shopId, phone);
    if (ids.length === 1) return ids[0];
  }
  if (email) {
    const e = await db.customer.findFirst({ where: { shopId: user.shopId, email: { equals: email, mode: "insensitive" } }, select: { id: true } });
    if (e) return e.id;
  }
  const made = await db.customer.create({ data: { shopId: user.shopId, kind: "RETAIL", name: c.name, phone: email ? null : phone, email, notifyBy: email ? "email" : phone ? "sms" : "" }, select: { id: true } });
  return made.id;
}

/**
 * "Send pay links": ends the show and sends each buyer one pay link for her held claims (her usual way; a buyer without a
 * phone or email gets a link to copy). Returns what happened, in words.
 */
export async function sendLinksFor(user: CurrentUser, saleId: string, now = new Date()): Promise<string> {
  await requireBaseWritable(user);
  const s = await ownSale(user, saleId);
  const problem = await payLinkProblem(user.shopId);
  if (problem) throw new UserError(problem);
  const held = await db.liveClaim.findMany({ where: { shopId: user.shopId, liveSaleId: s.id, status: "HELD" }, orderBy: { createdAt: "asc" } });
  if (!held.length) {
    await db.liveSale.updateMany({ where: { id: s.id, shopId: user.shopId }, data: { status: "CLOSED", closedAt: s.closedAt ?? now } });
    throw new UserError("No claims waiting for a pay link.");
  }
  const groups = new Map<string, typeof held>();
  for (const c of held) groups.set(buyerKey(c), [...(groups.get(buyerKey(c)) ?? []), c]);
  const days = Math.max(1, Math.ceil(s.holdHours / 24));
  let sent = 0;
  const copy: string[] = [];
  const failed: string[] = [];
  for (const claims of groups.values()) {
    const first = claims[0];
    try {
      const customerId = first.customerId ?? (await customerForBuyer(user, first));
      const r = await makePayLinkFor(
        // The live sale's store: its shelf holds the claims, and the sale is its when she pays (7.2).
        { ...user, locationId: s.locationId ?? (await storeOfRow(user.shopId, null))?.id ?? null },
        { customerId, lines: claims.map((c) => ({ partId: c.partId, description: c.description, qty: c.qty, unitPriceCents: c.priceCents, taxable: true })), note: `From our ${s.name}.`, send: "usual", days },
        { trusted: true, now },
      );
      await db.liveClaim.updateMany({ where: { id: { in: claims.map((c) => c.id) }, shopId: user.shopId, status: "HELD" }, data: { status: "SENT", webOrderId: r.orderId, sentAt: now, customerId } });
      if (/^Sent to her/.test(r.told)) sent += 1;
      else copy.push(first.name);
    } catch (e) {
      if (!isUserError(e)) throw e;
      failed.push(`${first.name}: ${e.message}`);
    }
  }
  await db.liveSale.updateMany({ where: { id: s.id, shopId: user.shopId }, data: { status: "CLOSED", closedAt: s.closedAt ?? now } });
  return [
    sent ? `Pay links sent to ${sent} buyer${sent === 1 ? "" : "s"}.` : "",
    copy.length ? `Copy the link for ${copy.join(", ")} (no way to reach ${copy.length === 1 ? "her" : "them"} by message).` : "",
    failed.length ? `Not sent: ${failed.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** "Let go of these?": takes back a buyer's unpaid pay link and puts her claimed stock back. */
export async function letGoFor(user: CurrentUser, saleId: string, webOrderId: string, now = new Date()): Promise<void> {
  await ownSale(user, saleId);
  const claims = await db.liveClaim.findMany({ where: { shopId: user.shopId, liveSaleId: saleId, webOrderId, status: "SENT" } });
  if (!claims.length) throw new UserError("Nothing to let go: she may have just paid. Look again.");
  const o = await db.webOrder.findFirst({ where: { id: webOrderId, shopId: user.shopId }, select: { status: true } });
  if (o?.status === "PENDING") await cancelPayLinkFor(user, webOrderId, now);
  else if (o && o.status !== "CANCELLED") {
    await syncClaims(user.shopId, saleId);
    throw new UserError("She has paid. Nothing to let go.");
  }
  await db.liveClaim.updateMany({ where: { shopId: user.shopId, webOrderId, status: "SENT" }, data: { status: "LET_GO", letGoAt: now } });
}

/** "Send it again" for a buyer's unpaid link. */
export async function resendBuyerFor(user: CurrentUser, saleId: string, webOrderId: string): Promise<string> {
  await ownSale(user, saleId);
  const c = await db.liveClaim.findFirst({ where: { shopId: user.shopId, liveSaleId: saleId, webOrderId, status: "SENT" } });
  if (!c) throw new UserError("Nothing waiting to be paid there.");
  return resendPayLinkFor(user, webOrderId);
}

export type LiveBuyer = {
  key: string;
  name: string;
  customerId: string | null;
  claims: { id: string; description: string; qty: number; unit: string | null; priceCents: number; status: string }[];
  totalCents: number;
  webOrderId: string | null;
  /** Sent, unpaid, past the hold time: "Let go of these?". */
  overdue: boolean;
};

export type LiveView = {
  id: string;
  name: string;
  status: string;
  holdHours: number;
  startsAt: Date;
  picks: { id: string; partNumber: string; description: string; priceCents: number | null; unit: string | null; onHand: number; held: number; left: number }[];
  buyers: LiveBuyer[];
  counts: { held: number; sent: number; paid: number; letGo: number };
};

/** The live sale page: today's show with what's left, and the claims by buyer (the newest buyer first). */
export async function liveView(shopId: string, id: string, now = new Date()): Promise<LiveView | null> {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  await syncClaims(shopId, id);
  const s = await db.liveSale.findFirst({ where: { id, shopId }, include: { claims: { orderBy: { createdAt: "asc" } } } });
  if (!s) return null;
  // The live sale's store's shelf (7.2): its stock, less its claims.
  const store = await storeOfRow(shopId, s.locationId);
  const parts = await withStoreQty(shopId, s.picks.length ? await db.part.findMany({ where: { shopId, id: { in: s.picks } }, select: { id: true, partNumber: true, description: true, onlineTitle: true, priceCents: true, unit: true, qtyOnHand: true } }) : [], store);
  const held = await liveHeld(shopId, s.picks, store);
  const order = new Map(s.picks.map((p, i) => [p, i]));
  const buyers = new Map<string, LiveBuyer>();
  for (const c of s.claims) {
    const key = c.webOrderId ? `link:${c.webOrderId}` : `${buyerKey(c)}:${c.status === "LET_GO" ? "gone" : "open"}`;
    const b = buyers.get(key) ?? { key, name: c.name, customerId: c.customerId, claims: [], totalCents: 0, webOrderId: c.webOrderId, overdue: false };
    b.claims.push({ id: c.id, description: c.description, qty: c.qty, unit: c.unit, priceCents: c.priceCents, status: c.status });
    if (c.status !== "LET_GO") b.totalCents += Math.round(c.qty * c.priceCents);
    if (c.status === "SENT" && c.sentAt && now.getTime() - c.sentAt.getTime() > s.holdHours * 3_600_000) b.overdue = true;
    buyers.set(key, b);
  }
  const count = (st: string) => s.claims.filter((c) => c.status === st).length;
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    holdHours: s.holdHours,
    startsAt: s.startsAt,
    picks: parts
      .map((p) => {
        const h = held.get(p.id) ?? 0;
        return { id: p.id, partNumber: p.partNumber, description: p.onlineTitle?.trim() || p.description, priceCents: p.priceCents, unit: p.unit, onHand: p.qtyOnHand, held: h, left: Math.max(0, Math.round((p.qtyOnHand - h) * 1000) / 1000) };
      })
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
    buyers: [...buyers.values()].reverse(),
    counts: { held: count("HELD"), sent: count("SENT"), paid: count("PAID"), letGo: count("LET_GO") },
  };
}

/** The shop's live sales, newest first, with their claim counts. */
export async function liveSalesFor(shopId: string) {
  await syncClaims(shopId);
  const rows = await db.liveSale.findMany({ where: { shopId }, orderBy: { startsAt: "desc" }, take: 50, include: { claims: { select: { status: true, qty: true, priceCents: true } } } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    startsAt: r.startsAt,
    claims: r.claims.filter((c) => c.status !== "LET_GO").length,
    paidCents: r.claims.filter((c) => c.status === "PAID").reduce((a, c) => a + Math.round(c.qty * c.priceCents), 0),
    waiting: r.claims.filter((c) => c.status === "HELD" || c.status === "SENT").length,
  }));
}
