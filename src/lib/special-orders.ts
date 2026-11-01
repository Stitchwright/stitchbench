import "server-only";
// Special orders and pre-orders (shop-features-round-2-design.md 1.2). Something a customer wants that isn't on the
// shelf, at a price, with a deposit. Every bit of money goes through the register as a sale whose lines carry the
// order's id (completeSaleAs with opts.internal, never from the browser):
// - the deposit and any payment toward it: a DEPOSIT line (+), money held for the customer (Customer Deposits);
// - the pick-up (at the register, or one tap from the customer's waiting list): the item sold at the order's price, its
//   deposits used up on a DEPOSIT line (-) the register works out (src/lib/special-order-hooks.ts);
// - a cancel by the shop's rule: the deposit back as store credit or money (DEPOSIT -), or kept (DEPOSIT -, DEPOSIT_KEPT
//   +: income "Kept deposits"). Undo for a day voids that sale, which opens the order again.
// It goes on a supplier's draft order ("Order it", "Add them"); when the item arrives (an order received, stock received
// by hand) the oldest orders for it are marked here, the quantity held off the shelf for her, and the "it's here"
// message goes out (kind order_in, never twice); a customer who takes no messages goes on the "Call these" list.
// Every query by shopId; bodies take the user so the check script can drive them.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { money, str, toCents } from "@/lib/format";
import { noticesOn } from "@/lib/module-gate";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView } from "@/lib/messaging/settings";
import { firstName, renderKind } from "@/lib/messaging/templates";
import { inEighths, saleTotals, TENDER_METHODS, type Tender } from "@/lib/register-math";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { exemptCertificate } from "@/lib/tax-exempt";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, parseYmd, ymdOf } from "@/lib/zoned";
import { actorOf, audit } from "@/lib/audit";
import { addItemsToDraftFor } from "@/lib/fabric-orders";
import { makePayLinkFor } from "@/lib/pay-links";
import { holdFor, paidTowardOrders, releaseHeld } from "@/lib/special-order-hooks";
import { currentStore, currentStoreId, onlineStore, storeDetails } from "@/lib/stores";

const MAX_MONEY = 10_000_000;
export const OPEN_STATUSES = ["WAITING", "ORDERED", "HERE"];
export type DepositRule = "credit" | "refund" | "keep";
export const RULE_WORDS: Record<DepositRule, string> = {
  credit: "If you cancel, the deposit comes back as store credit.",
  refund: "If you cancel, the deposit is refunded.",
  keep: "The deposit is not refundable.",
};
/** The status as a sentence. */
export const STATUS_WORDS: Record<string, string> = {
  WAITING: "Not ordered yet",
  ORDERED: "Waiting for the supplier",
  HERE: "Here, waiting for her",
  DONE: "Picked up",
  CANCELLED: "Cancelled",
};
const isRule = (s: unknown): s is DepositRule => s === "credit" || s === "refund" || s === "keep";

// ---------------------------------------------------------------------------------------------------------------------
// Settings

export type SpecialOrderSettings = { depositPct: number; depositCents: number; rule: DepositRule; days: number };

export async function specialOrderSettings(shopId: string): Promise<SpecialOrderSettings> {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { specialOrderDepositPct: true, specialOrderDepositCents: true, specialOrderDepositRule: true, specialOrderDays: true } });
  return { depositPct: s.specialOrderDepositPct, depositCents: s.specialOrderDepositCents, rule: isRule(s.specialOrderDepositRule) ? s.specialOrderDepositRule : "credit", days: s.specialOrderDays };
}

/** Settings → Selling → Special orders (owner or admin). The deposit is a percent or an amount (the other is cleared). */
export async function saveSpecialOrderSettingsFor(user: CurrentUser, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const how = str(fd.get("depositHow")) ?? "none";
  let pct = 0;
  let cents = 0;
  if (how === "pct") {
    pct = Number(str(fd.get("depositPct"))?.replace(/%$/, "") ?? "");
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw new UserError("Deposit: a whole percent from 1 to 100.");
  } else if (how === "amount") {
    cents = toCents(str(fd.get("depositAmount"))) ?? -1;
    if (cents < 1 || cents > 100_000) throw new UserError("Deposit: an amount from $0.01 to $1,000.");
  }
  const rule = str(fd.get("rule"));
  const days = Number(str(fd.get("days")) ?? "30");
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new UserError("Days to pick up: a whole number from 1 to 365.");
  await db.shop.update({ where: { id: user.shopId }, data: { specialOrderDepositPct: pct, specialOrderDepositCents: cents, specialOrderDepositRule: isRule(rule) ? rule : "credit", specialOrderDays: days } });
}

/** The deposit the shop asks by default for a price (cents). */
export function defaultDeposit(s: Pick<SpecialOrderSettings, "depositPct" | "depositCents">, totalCents: number): number {
  if (s.depositCents > 0) return Math.min(s.depositCents, totalCents);
  if (s.depositPct > 0) return Math.round((totalCents * s.depositPct) / 100);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading

type Row = Prisma.SpecialOrderGetPayload<{ include: { customer: { select: { id: true; name: true; phone: true; email: true; notifyBy: true; taxExemptId: true; taxExemptUntil: true } } } }>;
const INCLUDE = { customer: { select: { id: true, name: true, phone: true, email: true, notifyBy: true, taxExemptId: true, taxExemptUntil: true } } } as const;

export type SpecialOrderView = {
  id: string;
  number: number;
  kind: string;
  status: string;
  statusWords: string;
  customer: { id: string; name: string; phone: string | null; notifyBy: string } | null;
  partId: string | null;
  partNumber: string | null;
  description: string;
  qty: number;
  unit: string | null;
  priceCents: number;
  /** The item's price, its tax today, the two together, what was paid toward it and what is left. */
  itemsCents: number;
  taxCents: number;
  owedCents: number;
  paidCents: number;
  leftCents: number;
  depositCents: number;
  depositRule: DepositRule;
  expectedOn: string | null;
  poLineId: string | null;
  heldQty: number;
  hereAt: Date | null;
  noticedAt: Date | null;
  calledAt: Date | null;
  saleId: string | null;
  cancelledAt: Date | null;
  note: string | null;
  createdAt: Date;
  /** Cancelled less than a day ago: Undo still works. */
  undoable: boolean;
  /** Here longer than the shop's days to pick up. */
  late: boolean;
};

async function views(shopId: string, rows: Row[]): Promise<SpecialOrderView[]> {
  if (!rows.length) return [];
  const now = Date.now();
  const [paid, shop, parts, settings] = await Promise.all([
    paidTowardOrders(
      shopId,
      rows.map((r) => r.id),
    ),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true } }),
    db.part.findMany({ where: { shopId, id: { in: rows.map((r) => r.partId).filter((x): x is string => !!x) } }, select: { id: true, partNumber: true } }),
    specialOrderSettings(shopId),
  ]);
  const numbers = new Map(parts.map((p) => [p.id, p.partNumber]));
  return rows.map((r) => {
    const t = saleTotals([{ qty: r.qty, unitPriceCents: r.priceCents, taxable: true }], 0, exemptCertificate(r.customer) ? 0 : shop.taxRatePct);
    const p = r.status === "DONE" || r.status === "CANCELLED" ? 0 : (paid.get(r.id) ?? 0);
    return {
      id: r.id,
      number: r.number,
      kind: r.kind,
      status: r.status,
      statusWords: STATUS_WORDS[r.status] ?? r.status,
      customer: r.customer ? { id: r.customer.id, name: r.customer.name, phone: r.customer.phone, notifyBy: r.customer.notifyBy } : null,
      partId: r.partId,
      partNumber: r.partId ? (numbers.get(r.partId) ?? null) : null,
      description: r.description,
      qty: r.qty,
      unit: r.unit,
      priceCents: r.priceCents,
      itemsCents: t.subtotal,
      taxCents: t.tax,
      owedCents: t.total,
      paidCents: p,
      leftCents: Math.max(0, t.total - p),
      depositCents: r.depositCents,
      depositRule: isRule(r.depositRule) ? r.depositRule : "credit",
      expectedOn: r.expectedOn,
      poLineId: r.poLineId,
      heldQty: r.heldQty,
      hereAt: r.hereAt,
      noticedAt: r.noticedAt,
      calledAt: r.calledAt,
      saleId: r.saleId,
      cancelledAt: r.cancelledAt,
      note: r.note,
      createdAt: r.createdAt,
      undoable: r.status === "CANCELLED" && !!r.cancelledAt && now - r.cancelledAt.getTime() < 86_400_000,
      late: r.status === "HERE" && !!r.hereAt && now - r.hereAt.getTime() > settings.days * 86_400_000,
    };
  });
}

export async function specialOrderView(shopId: string, id: string): Promise<SpecialOrderView | null> {
  if (typeof id !== "string") return null;
  const r = await db.specialOrder.findFirst({ where: { id, shopId }, include: INCLUDE });
  return r ? (await views(shopId, [r]))[0] : null;
}

export type Tab = "waiting" | "here" | "done";
const TAB_STATUS: Record<Tab, string[]> = { waiting: ["WAITING", "ORDERED"], here: ["HERE"], done: ["DONE", "CANCELLED"] };

/** One tab of the Special orders page (oldest first while open, newest first when done); `customerId` narrows it. */
export async function specialOrdersFor(shopId: string, o: { tab?: Tab; customerId?: string | null; partId?: string | null; take?: number } = {}): Promise<SpecialOrderView[]> {
  const rows = await db.specialOrder.findMany({
    where: { shopId, ...(o.tab ? { status: { in: TAB_STATUS[o.tab] } } : {}), ...(o.customerId ? { customerId: o.customerId } : {}), ...(o.partId ? { partId: o.partId } : {}) },
    include: INCLUDE,
    orderBy: o.tab === "done" ? { number: "desc" } : { number: "asc" },
    take: o.take ?? 200,
  });
  return views(shopId, rows);
}

/** The counts for the tabs and the dashboard: waiting to order, waiting for the supplier, here, here too long, to call. */
export async function specialOrderCounts(shopId: string, now = new Date()) {
  const { days } = await specialOrderSettings(shopId);
  const [waiting, ordered, here, late, call] = await Promise.all([
    db.specialOrder.count({ where: { shopId, status: "WAITING" } }),
    db.specialOrder.count({ where: { shopId, status: "ORDERED" } }),
    db.specialOrder.count({ where: { shopId, status: "HERE" } }),
    db.specialOrder.count({ where: { shopId, status: "HERE", hereAt: { lt: new Date(now.getTime() - days * 86_400_000) } } }),
    db.specialOrder.count({ where: { shopId, status: "HERE", noticedAt: null, calledAt: null } }),
  ]);
  return { waiting, ordered, here, late, call, days };
}

/** Her orders waiting at the counter (the register's "Jane has a special order waiting"). */
export async function waitingForCustomer(shopId: string, customerId: string): Promise<SpecialOrderView[]> {
  return specialOrdersFor(shopId, { tab: "here", customerId });
}

/** Money held for customers on open special orders (the deposits report beside layaway's). */
export async function specialOrderDepositsHeld(shopId: string): Promise<number> {
  const rows = await db.saleLine.findMany({ where: { kind: "DEPOSIT", specialOrderId: { not: null }, sale: { shopId, status: "COMPLETED" } }, select: { qty: true, unitPriceCents: true, discountCents: true } });
  return rows.reduce((a, r) => a + Math.round(r.qty * r.unitPriceCents) - (r.qty < 0 ? -1 : 1) * r.discountCents, 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Taking one

export type TakeInput = {
  customerId: string | null;
  partId?: string | null;
  description?: string | null;
  qty?: number;
  priceCents: number;
  depositCents?: number | null;
  expectedOn?: string | null;
  note?: string | null;
  tender?: Tender | null;
  clientKey?: string | null;
};

function tenderOf(t: Tender | null | undefined, amountCents: number): Tender[] {
  if (!amountCents) return [];
  const method = t && TENDER_METHODS.includes(t.method) ? t.method : null;
  if (!method) throw new UserError("Pick how she's paying the deposit.");
  return [{ method, amountCents, note: typeof t?.note === "string" ? t.note.slice(0, 100) || null : null, cardNumber: typeof t?.cardNumber === "string" ? t.cardNumber.slice(0, 40) : null }];
}

/**
 * "Take the order": the customer, the item (one of the shop's, or words), how many, the price, the deposit (rung up
 * here, by the tender given), when it's expected. An item marked coming soon makes a pre-order. Returns the order and
 * the deposit's sale (none when no deposit is taken).
 */
export async function takeSpecialOrderAs(user: CurrentUser, input: TakeInput): Promise<{ id: string; number: number; saleId: string | null; saleNumber: number | null }> {
  const shopId = user.shopId;
  await requireBaseWritable(user);
  const clientKey = typeof input.clientKey === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(input.clientKey) ? input.clientKey : null;
  if (clientKey) {
    const made = await db.sale.findUnique({ where: { shopId_clientKey: { shopId, clientKey } }, select: { id: true, number: true, lines: { select: { specialOrderId: true }, take: 1 } } });
    const sid = made?.lines[0]?.specialOrderId;
    if (made && sid) {
      const o = await db.specialOrder.findFirstOrThrow({ where: { id: sid, shopId }, select: { id: true, number: true } });
      return { id: o.id, number: o.number, saleId: made.id, saleNumber: made.number };
    }
  }
  const customer = input.customerId ? await db.customer.findFirst({ where: { id: input.customerId, shopId } }) : null;
  if (!customer) throw new UserError(input.customerId ? "Customer not found." : "Pick the customer first: a special order is for someone.");
  const part = input.partId ? await db.part.findFirst({ where: { id: input.partId, shopId } }) : null;
  if (input.partId && !part) throw new UserError("That item isn't in your inventory any more.");
  if (part?.consignLinkId) throw new UserError(`${part.partNumber} is a partner's consigned item: order it from them instead.`);
  const description = (input.description?.trim() || part?.description || "").slice(0, 200);
  if (!description) throw new UserError("Say what she wants (search your items, or type it).");
  const qty = Number(input.qty ?? 1);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 10_000 || (part?.unit === "yd" ? !inEighths(qty) : !Number.isInteger(qty))) throw new UserError(part?.unit === "yd" ? "How many yards: in eighths (2 3/8 is 2.375)." : "How many: a whole number.");
  const price = Math.round(Number(input.priceCents));
  if (!Number.isFinite(price) || price < 0 || price > MAX_MONEY) throw new UserError("Check the price.");
  if (user.role === "TECH") {
    if (!part) throw new UserError("Only an owner or admin can price something that isn't in your items.");
    if (part.priceCents == null || price !== part.priceCents) throw new UserError(`Only an owner or admin can change the price of ${part.partNumber}.`);
  }
  const settings = await specialOrderSettings(shopId);
  // Taken at this store (7.1): its tax rate, and the item is held on its shelf when it comes in.
  const here = await currentStore(user);
  const shop = storeDetails(await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true } }), here);
  const owed = saleTotals([{ qty, unitPriceCents: price, taxable: true }], 0, exemptCertificate(customer) ? 0 : shop.taxRatePct).total;
  const deposit = input.depositCents == null ? defaultDeposit(settings, owed) : Math.round(Number(input.depositCents));
  if (!Number.isFinite(deposit) || deposit < 0) throw new UserError("Check the deposit.");
  if (deposit > owed) throw new UserError("The deposit is more than the whole price. Ring it up as a sale instead.");
  const expectedOn = input.expectedOn ? parseYmd(input.expectedOn) : (part?.comingSoonOn ?? null);
  if (input.expectedOn && !expectedOn) throw new UserError("Expected: pick a date, or leave it blank.");
  const tenders = tenderOf(input.tender, deposit);
  const order = await db.$transaction(async (tx) => {
    const sh = await tx.shop.update({ where: { id: shopId }, data: { nextSpecialOrderNumber: { increment: 1 } }, select: { nextSpecialOrderNumber: true } });
    return tx.specialOrder.create({
      data: {
        shopId,
        number: sh.nextSpecialOrderNumber - 1,
        customerId: customer.id,
        kind: part?.comingSoonOn ? "PREORDER" : "ORDER",
        locationId: here?.id ?? null,
        partId: part?.id ?? null,
        description,
        qty,
        unit: part?.unit ?? null,
        priceCents: price,
        depositCents: deposit,
        depositRule: part?.depositKept ? "keep" : settings.rule,
        expectedOn,
        note: input.note?.trim().slice(0, 500) || null,
        createdById: user.id,
      },
    });
  });
  if (!deposit) return { id: order.id, number: order.number, saleId: null, saleNumber: null };
  try {
    const sale = await completeSaleAs(
      user,
      { customerId: customer.id, lines: [{ description: `Special order ${order.number}: deposit`, qty: 1, unitPriceCents: deposit, taxable: false, specialOrderId: order.id, depositKind: "DEPOSIT" }], tenders, clientKey },
      { internal: true },
    );
    return { id: order.id, number: order.number, saleId: sale.saleId, saleNumber: sale.number };
  } catch (e) {
    await db.specialOrder.deleteMany({ where: { id: order.id, shopId } });
    throw e;
  }
}

async function openOrder(shopId: string, id: string) {
  const o = typeof id === "string" ? await db.specialOrder.findFirst({ where: { id, shopId }, include: INCLUDE }) : null;
  if (!o) throw new UserError("Special order not found.");
  if (!OPEN_STATUSES.includes(o.status)) throw new UserError(`Special order ${o.number} is ${o.status === "DONE" ? "picked up" : "cancelled"} already.`);
  return o;
}

/** A payment toward it at the counter: any amount up to what is left. */
export async function payTowardAs(user: CurrentUser, a: { id: string; amountCents: number; tender: Tender; clientKey?: string | null }): Promise<{ saleId: string; number: number; changeCents: number }> {
  const o = await openOrder(user.shopId, a.id);
  const v = (await views(user.shopId, [o]))[0];
  const amount = Math.round(Number(a.amountCents));
  if (!Number.isFinite(amount) || amount <= 0) throw new UserError("Enter the amount she's paying.");
  if (amount > v.leftCents) throw new UserError(`Only ${money(v.leftCents)} is left to pay.`);
  const sale = await completeSaleAs(
    user,
    { customerId: o.customerId, lines: [{ description: `Special order ${o.number}: payment`, qty: 1, unitPriceCents: amount, taxable: false, specialOrderId: o.id, depositKind: "DEPOSIT" }], tenders: tenderOf(a.tender, amount), clientKey: a.clientKey ?? null },
    { internal: true },
  );
  return { saleId: sale.saleId, number: sale.number, changeCents: sale.changeCents };
}

/** "Send a pay link for the rest": what is left, as a pay link (src/lib/pay-links.ts). */
export async function sendBalanceLinkAs(user: CurrentUser, id: string): Promise<string> {
  const o = await openOrder(user.shopId, id);
  const v = (await views(user.shopId, [o]))[0];
  if (v.leftCents < 50) throw new UserError("Nothing (or less than $0.50) is left to pay.");
  const r = await makePayLinkFor(user, { customerId: o.customerId, lines: [{ description: `Special order ${o.number}: ${o.description}, the rest`, unitPriceCents: v.leftCents, specialOrderId: o.id }] }, { trusted: true });
  return `Pay link #${r.number} for ${money(v.leftCents)}. ${r.told}`;
}

/** Pre-orders: "Ask for the balances" sends each open pre-order of an item a pay link for what is left. */
export async function askForBalancesAs(user: CurrentUser, partId: string): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  const rows = await db.specialOrder.findMany({ where: { shopId: user.shopId, partId, status: { in: OPEN_STATUSES } }, include: INCLUDE });
  if (!rows.length) throw new UserError("No open pre-orders for this item.");
  let sent = 0;
  let skipped = 0;
  for (const v of await views(user.shopId, rows)) {
    if (v.leftCents < 50) {
      skipped += 1;
      continue;
    }
    // A link for this order already waiting: not sent twice.
    if (await db.webOrder.count({ where: { shopId: user.shopId, source: "staff", status: "PENDING", specialOrderIds: { has: v.id } } })) {
      skipped += 1;
      continue;
    }
    await sendBalanceLinkAs(user, v.id);
    sent += 1;
  }
  return `Sent ${sent} pay ${sent === 1 ? "link" : "links"}${skipped ? `; ${skipped} paid in full or already sent one` : ""}.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ordering it and its arrival

/** "Order it" / "Add them": the orders' items on their suppliers' draft orders; the orders are then waiting for the supplier. */
export async function orderThemFor(user: CurrentUser, ids: string[]): Promise<string> {
  const rows = await db.specialOrder.findMany({ where: { shopId: user.shopId, id: { in: ids.filter((x) => typeof x === "string") }, status: "WAITING" } });
  if (!rows.length) throw new UserError("Nothing to order: those are ordered already, or not found.");
  const byWords = rows.filter((r) => !r.partId);
  const items = rows.filter((r) => r.partId);
  let words = "";
  if (items.length) {
    const qty = new Map<string, number>();
    for (const r of items) qty.set(r.partId!, (qty.get(r.partId!) ?? 0) + r.qty);
    // What's already on a draft or sent order for the item counts: only what isn't covered is added.
    words = await addItemsToDraftFor(
      user,
      [...qty].map(([partId, q]) => ({ partId, qty: Math.max(1, Math.ceil(q)) })),
    );
    for (const r of items) {
      const line = await db.purchaseOrderLine.findFirst({ where: { shopId: user.shopId, partId: r.partId, order: { status: "DRAFT" } }, orderBy: { order: { number: "desc" } }, select: { id: true } });
      await db.specialOrder.updateMany({ where: { id: r.id, shopId: user.shopId, status: "WAITING" }, data: { status: "ORDERED", poLineId: line?.id ?? null } });
    }
  }
  if (byWords.length) await db.specialOrder.updateMany({ where: { shopId: user.shopId, id: { in: byWords.map((r) => r.id) }, status: "WAITING" }, data: { status: "ORDERED" } });
  return [words, byWords.length ? `${byWords.length} typed ${byWords.length === 1 ? "order is" : "orders are"} marked ordered (order ${byWords.length === 1 ? "it" : "them"} from the supplier yourself).` : ""].filter(Boolean).join(" ");
}

/** Special orders not ordered yet with items (the Orders to suppliers page's "3 special orders waiting"). */
export async function waitingToOrder(shopId: string): Promise<{ id: string; partId: string }[]> {
  return (await db.specialOrder.findMany({ where: { shopId, status: "WAITING", partId: { not: null } }, select: { id: true, partId: true } })).map((r) => ({ id: r.id, partId: r.partId! }));
}

/** "Waiting for the supplier" again: an order wrongly marked here goes back (its held quantity back on the shelf). */
export async function notHereAfterAllFor(user: CurrentUser, id: string, now = new Date()): Promise<void> {
  const o = await openOrder(user.shopId, id);
  if (o.status !== "HERE") throw new UserError("It isn't marked here.");
  await db.$transaction(async (tx) => {
    const r = await tx.specialOrder.updateMany({ where: { id: o.id, shopId: user.shopId, status: "HERE" }, data: { status: "ORDERED", hereAt: null, heldQty: 0 } });
    if (!r.count) throw new UserError("It just changed. Look again.");
    await releaseHeld(tx, user.shopId, o, user.id, now, "not here after all");
    await tx.outMessage.updateMany({ where: { shopId: user.shopId, kind: "order_in", refType: "special_order", refId: o.id, status: { in: ["QUEUED"] } }, data: { status: "CANCELLED", error: "Not here after all", cancelledById: user.id } });
  });
}

/** Marks orders here by hand (one typed in words, or any that came another way). */
export async function markHereFor(user: CurrentUser, id: string, now = new Date()): Promise<string> {
  const o = await openOrder(user.shopId, id);
  if (o.status === "HERE") throw new UserError("It's marked here already.");
  const r = await hereNow(user, [o], now);
  return r.words;
}

/**
 * Stock arrived for these items (an order received, stock received by hand) at the store receiving it (this device's):
 * the oldest open orders for each at that store are marked here and held on its shelf while the quantity lasts. Orders
 * waiting at another store aren't marked here (the stock isn't there): the words say so, to send it over with a
 * transfer (Stores) and mark them here when it arrives. Returns the words for the person receiving.
 */
export async function arrivedFor(user: CurrentUser, arrivals: { partId: string; qty: number }[], now = new Date()): Promise<string> {
  const got = new Map<string, number>();
  for (const a of arrivals) if (a.partId && a.qty > 0) got.set(a.partId, (got.get(a.partId) ?? 0) + a.qty);
  if (!got.size) return "";
  const rows = await db.specialOrder.findMany({ where: { shopId: user.shopId, partId: { in: [...got.keys()] }, status: { in: ["WAITING", "ORDERED"] } }, include: INCLUDE, orderBy: { number: "asc" } });
  if (!rows.length) return "";
  // A null store is the main store, on either side.
  const mainId = (await db.location.findFirst({ where: { shopId: user.shopId, main: true }, select: { id: true } }))?.id ?? null;
  const here = (await currentStoreId(user)) ?? mainId;
  const take: Row[] = [];
  const elsewhere = new Map<string, number>();
  for (const r of rows) {
    if ((r.locationId ?? mainId) !== here) {
      const at = r.locationId ?? mainId ?? "";
      elsewhere.set(at, (elsewhere.get(at) ?? 0) + 1);
      continue;
    }
    const left = got.get(r.partId!) ?? 0;
    if (left + 1e-9 < r.qty) continue;
    got.set(r.partId!, left - r.qty);
    take.push(r);
  }
  const words: string[] = [];
  if (take.length) words.push((await hereNow(user, take, now)).words);
  if (elsewhere.size) {
    const names = new Map((await db.location.findMany({ where: { shopId: user.shopId, id: { in: [...elsewhere.keys()] } }, select: { id: true, name: true } })).map((l) => [l.id, l.name]));
    const n = [...elsewhere.values()].reduce((x, y) => x + y, 0);
    words.push(`${n} special ${n === 1 ? "order" : "orders"} for this wait${n === 1 ? "s" : ""} at ${[...elsewhere.keys()].map((k) => names.get(k) ?? "another store").join(", ")}: send ${n === 1 ? "it" : "them"} over with a transfer (Stores), then mark ${n === 1 ? "it" : "them"} here there.`);
  }
  return words.filter(Boolean).join(" ");
}

/** Here: held for her, and told (the "it's here" message once email or texts are on, never twice), or on the Call these list. */
async function hereNow(user: CurrentUser, rows: Row[], now: Date): Promise<{ words: string }> {
  // In the base since 7 Oct 2026: email or texts switched on is enough (no Marketing needed).
  const marketing = await noticesOn(user.shopId);
  const ms = marketing ? await messagingView(user.shopId) : null;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true } });
  const vs = new Map((await views(user.shopId, rows)).map((v) => [v.id, v]));
  let told = 0;
  const call: string[] = [];
  for (const r of rows) {
    await db.$transaction(async (tx) => {
      const ok = await tx.specialOrder.updateMany({ where: { id: r.id, shopId: user.shopId, status: { in: ["WAITING", "ORDERED"] } }, data: { status: "HERE", hereAt: now } });
      if (!ok.count) return;
      await holdFor(tx, user.shopId, r, user.id, now);
      if (!ms || !r.customerId || r.noticedAt) {
        call.push(r.customer?.name ?? `order ${r.number}`);
        return;
      }
      const v = vs.get(r.id)!;
      const vars = {
        first_name: firstName(r.customer?.name ?? ""),
        name: r.customer?.name ?? "",
        shop_name: shop.name,
        shop_phone: shop.phone ?? "",
        item: r.description,
        ref_line: ` Special order ${r.number}.`,
        balance_line: v.leftCents > 0 ? ` ${money(v.leftCents)} is left to pay when you pick it up.` : " It's paid in full.",
      };
      const q = await queueToCustomer(tx, {
        shopId: user.shopId,
        customerId: r.customerId,
        kind: "order_in",
        channels: "preferred",
        dedupeKey: `order_in:so:${r.id}`,
        refType: "special_order",
        refId: r.id,
        sendAfter: now,
        byUserId: user.id,
        staffCap: false,
        ms,
        content: (ch) => renderKind(ms, "order_in", ch, vars),
      });
      if (q.queued.length || q.duplicate.length) {
        told += 1;
        await tx.specialOrder.updateMany({ where: { id: r.id, shopId: user.shopId }, data: { noticedAt: now } });
      } else call.push(r.customer?.name ?? `order ${r.number}`);
    });
  }
  const parts = [`${rows.length === 1 ? "Special order" : `${rows.length} special orders`} marked here and held.`];
  if (told) parts.push(`${told === 1 ? "The customer hears" : `${told} customers hear`} it's here.`);
  if (call.length) parts.push(`Call ${call.slice(0, 5).join(", ")}${call.length > 5 ? " and more" : ""}: ${marketing ? "no way to message them" : "messages are off, so nothing was sent"}.`);
  return { words: parts.join(" ") };
}

/** Called by hand: off the Call these list. */
export async function markCalledFor(user: CurrentUser, id: string, now = new Date()): Promise<void> {
  const o = await openOrder(user.shopId, id);
  await db.specialOrder.updateMany({ where: { id: o.id, shopId: user.shopId }, data: { calledAt: now } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Cancelling, and undo

/**
 * Cancels by the order's deposit rule (an owner or admin may choose another each time): store credit or money back, or
 * kept. The held quantity goes back on the shelf. Returns the cancel's sale (none when nothing was paid).
 */
export async function cancelSpecialOrderAs(user: CurrentUser, a: { id: string; rule?: DepositRule | null; method?: string | null; reason?: string | null; clientKey?: string | null }, now = new Date()): Promise<{ saleId: string | null; backCents: number; keptCents: number }> {
  const o = await openOrder(user.shopId, a.id);
  const paid = (await paidTowardOrders(user.shopId, [o.id])).get(o.id) ?? 0;
  const own = isRule(o.depositRule) ? o.depositRule : "credit";
  const rule = a.rule && isRule(a.rule) && user.role !== "TECH" ? a.rule : own;
  if (user.role === "TECH" && paid > 0) throw new UserError("Only an owner or admin can cancel a special order with money paid on it.");
  const note = a.reason?.trim().slice(0, 200) || null;
  if (paid <= 0) {
    await db.$transaction(async (tx) => {
      const r = await tx.specialOrder.updateMany({ where: { id: o.id, shopId: user.shopId, status: o.status }, data: { status: "CANCELLED", prevStatus: o.status, cancelledAt: now, heldQty: 0, saleId: null, ...(note ? { note: [o.note, `Cancelled: ${note}`].filter(Boolean).join("\n") } : {}) } });
      if (!r.count) throw new UserError("It just changed. Look again.");
      await releaseHeld(tx, user.shopId, o, user.id, now, "cancelled");
    });
    await (await import("@/lib/pay-links")).cancelLinksFor(user.shopId, { specialOrderId: o.id }, `special order ${o.number} was cancelled`, now);
    return { saleId: null, backCents: 0, keptCents: 0 };
  }
  const lines =
    rule === "keep"
      ? [
          { description: `Special order ${o.number}: deposit kept`, qty: -1, unitPriceCents: paid, taxable: false, specialOrderId: o.id, depositKind: "DEPOSIT" as const },
          { description: `Special order ${o.number}: kept deposit`, qty: 1, unitPriceCents: paid, taxable: false, specialOrderId: o.id, depositKind: "DEPOSIT_KEPT" as const },
        ]
      : [{ description: `Special order ${o.number}: cancelled, deposit given back`, qty: -1, unitPriceCents: paid, taxable: false, specialOrderId: o.id, depositKind: "DEPOSIT" as const }];
  const method = rule === "credit" ? "CREDIT" : a.method === "CARD" || a.method === "CHECK" ? a.method : "CASH";
  const sale = await completeSaleAs(
    user,
    { customerId: o.customerId, lines, tenders: rule === "keep" ? [] : [{ method, amountCents: -paid }], clientKey: a.clientKey ?? null, note: note ? `Cancelled: ${note}` : null },
    { internal: true, specialOrder: { mode: "cancel", id: o.id, prevStatus: o.status } },
  );
  await (await import("@/lib/pay-links")).cancelLinksFor(user.shopId, { specialOrderId: o.id }, `special order ${o.number} was cancelled`, now);
  if (rule === "keep") await audit(db, actorOf(user), { action: "specialorder.keep", subjectType: "SpecialOrder", subjectId: o.id, subjectLabel: `Special order ${o.number}`, amountCents: paid, reason: note });
  return { saleId: sale.saleId, backCents: rule === "keep" ? 0 : paid, keptCents: rule === "keep" ? paid : 0 };
}

/** Undo a cancel within a day: its sale is voided (the credit or kept deposit comes back off) and the order is open again. */
export async function undoCancelFor(user: CurrentUser, id: string, now = new Date()): Promise<void> {
  const o = typeof id === "string" ? await db.specialOrder.findFirst({ where: { id, shopId: user.shopId } }) : null;
  if (!o) throw new UserError("Special order not found.");
  if (o.status !== "CANCELLED") throw new UserError("That special order isn't cancelled.");
  if (!o.cancelledAt || now.getTime() - o.cancelledAt.getTime() > 86_400_000) throw new UserError("It was cancelled more than a day ago. Take a new special order instead.");
  if (o.saleId) {
    // The cancel moved money (given back, credited or kept): undoing it voids that sale, an owner's or admin's (as the
    // cancel with money and the register's void are).
    if (user.role === "TECH") throw new UserError("Only an owner or admin can undo a cancel that moved money.");
    await voidSaleAs(user, o.saleId, `Undo: special order ${o.number} open again`);
    return;
  }
  const back = o.prevStatus && OPEN_STATUSES.includes(o.prevStatus) ? o.prevStatus : "WAITING";
  await db.$transaction(async (tx) => {
    await tx.specialOrder.updateMany({ where: { id: o.id, shopId: user.shopId, status: "CANCELLED" }, data: { status: back, cancelledAt: null, prevStatus: null } });
    if (back === "HERE") await holdFor(tx, user.shopId, o, user.id, now);
  });
}

/** The day she should pick it up by (here + the shop's days), in its zone. */
export async function pickUpBy(shopId: string, hereAt: Date): Promise<string> {
  const [{ days }, tz] = await Promise.all([specialOrderSettings(shopId), shopTimeZone(shopId)]);
  return addDays(ymdOf(hereAt, tz), days);
}

// ---------------------------------------------------------------------------------------------------------------------
// The online shop's pre-order

/**
 * "Pre-order" on a coming-soon item in the online shop: the customer matched or made, a PREORDER taken for one, and
 * Stripe's page for the deposit (the shop's default; the whole price when the shop asks none). The deposit lands as
 * money held for her when she pays (a pay link, src/lib/pay-links.ts). Returns where to send her.
 */
export async function startPreorder(a: { slug: string; partId: string; qty?: number; customer: import("@/lib/online-booking").OnlineCustomer }): Promise<string> {
  const { publicStore, booksUserFor } = await import("@/lib/shop/online-shop");
  const { customerForOnline, withStaffNote } = await import("@/lib/online-booking");
  const { openPayLink } = await import("@/lib/pay-links");
  const store = await publicStore(a.slug);
  if (!store || !store.open) throw new UserError("The shop isn't taking online orders right now. Please call us.");
  const part = typeof a.partId === "string" ? await db.part.findFirst({ where: { id: a.partId, shopId: store.id, online: true, priceCents: { not: null }, consignLinkId: null, comingSoonOn: { not: null } } }) : null;
  if (!part) throw new UserError("That item isn't taking pre-orders.");
  const qty = Math.max(1, Math.min(10, Math.round(Number(a.qty ?? 1)) || 1));
  const customer = await db.$transaction((tx) => customerForOnline(tx, store.id, a.customer, "online pre-order"));
  const user = await booksUserFor(store.id);
  const settings = await specialOrderSettings(store.id);
  const owed = saleTotals([{ qty, unitPriceCents: part.priceCents!, taxable: true }], 0, store.taxRatePct).total;
  const deposit = defaultDeposit(settings, owed) || owed;
  const sh = await db.shop.update({ where: { id: store.id }, data: { nextSpecialOrderNumber: { increment: 1 } }, select: { nextSpecialOrderNumber: true } });
  const o = await db.specialOrder.create({
    data: {
      shopId: store.id,
      number: sh.nextSpecialOrderNumber - 1,
      customerId: customer.id,
      kind: "PREORDER",
      // Held at the store the online shop sells from (Settings -> Stores).
      locationId: (await onlineStore(store.id))?.id ?? null,
      partId: part.id,
      description: part.onlineTitle?.trim() || part.description,
      qty,
      unit: part.unit,
      priceCents: part.priceCents!,
      depositCents: deposit,
      depositRule: part.depositKept ? "keep" : settings.rule,
      expectedOn: part.comingSoonOn,
      // "Pre-ordered online" first: expireUnpaidPreorders finds them by it. Then what the form gave that the record lacks.
      note: withStaffNote("Pre-ordered online", customer.staffNote),
    },
  });
  const link = await makePayLinkFor(user, { customerId: customer.id, lines: [{ description: `Pre-order ${o.number}: ${o.description}, deposit`, unitPriceCents: deposit, specialOrderId: o.id }], send: "none", days: 2 }, { trusted: true });
  return openPayLink(link.link.split("/shop/o/")[1]);
}

/**
 * Pre-orders made online whose deposit was never paid (its link ran out or was taken back, nothing paid toward it):
 * cancelled, so they don't hold stock when it arrives. Run with the online shop's sweep. Returns how many.
 */
export async function expireUnpaidPreorders(now = new Date()): Promise<number> {
  const rows = await db.specialOrder.findMany({ where: { kind: "PREORDER", OR: [{ note: "Pre-ordered online" }, { note: { startsWith: "Pre-ordered online\n" } }], status: { in: ["WAITING", "ORDERED"] }, createdAt: { lt: new Date(now.getTime() - 2 * 86_400_000) } }, select: { id: true, shopId: true, status: true }, take: 500 });
  let n = 0;
  for (const o of rows) {
    if ((await paidTowardOrders(o.shopId, [o.id])).get(o.id)) continue;
    if (await db.webOrder.count({ where: { shopId: o.shopId, source: "staff", status: { in: ["PENDING", "PAID"] }, specialOrderIds: { has: o.id } } })) continue;
    const r = await db.specialOrder.updateMany({ where: { id: o.id, shopId: o.shopId, status: o.status }, data: { status: "CANCELLED", prevStatus: o.status, cancelledAt: now, note: "Pre-ordered online; the deposit was never paid" } });
    n += r.count;
  }
  return n;
}
