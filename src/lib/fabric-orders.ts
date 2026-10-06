import "server-only";
// Fabric ordering (fabric-smarts-design.md sections 2 and 5, package F3): the Reorder tab's suggestions, suppliers (lead
// time learned from received orders, minimum order, order email) and purchase orders: draft, send (print, mailto and CSV;
// nothing is emailed from here), receive (RECEIVED moves, lead time learned), cancel. Each query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str } from "@/lib/format";
import { MAX_STOCK, centsField, numberKey } from "@/lib/parts";
import { inEighths, yards } from "@/lib/register-math";
import { dateIn, todayIn } from "@/lib/time-zone";
import { insightFor, type InsightItem } from "@/lib/fabric-insight";
import { daysAgo, slowStage } from "@/lib/fabric-insight-math";
import {
  OPEN_STATUSES,
  isUrgent,
  leadDaysOf,
  learnLead,
  lineYards,
  orderTotal,
  outstandingYards,
  reorderMath,
  statusAfterReceive,
  type PoLineLike,
  type ReorderOut,
} from "@/lib/fabric-orders-math";
import type { CurrentUser } from "@/lib/session";
import { Prisma } from "@/generated/prisma/client";
import { cleanLayout, cleanMap, orderRows, parseLayoutText } from "@/lib/connectors/layout";
import { connectorFor, isConnectorId } from "@/lib/connectors/registry";
import type { ColumnMap, ConnectorContext, OrderLayout, OrderVia } from "@/lib/connectors/types";

export const MAX_ORDER_LINES = 300;
const MAX_QTY_LINE = 100_000;

const supplierKey = (name: string | null | undefined) => (name ?? "").trim().toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------------------------------------------

export type SupplierView = {
  id: string | null;
  name: string;
  leadDays: number | null;
  learnedDays: number | null;
  learnedOrders: number;
  minOrderCents: number;
  orderEmail: string | null;
  /** Connectors (package F6): how orders go, the shop's account number there, and the last catalog import. */
  connector: string;
  accountNumber: string | null;
  catalogMap: ColumnMap | null;
  orderLayout: OrderLayout | null;
  catalogAt: Date | null;
  catalogNote: string | null;
  /** The lead time in use, and where it comes from. */
  lead: { days: number; from: "learned" | "supplier" | "shop" };
  fabrics: number;
  openOrders: number;
};

/** Every supplier named on a fabric or an order, with its figures (a name with no record yet shows the shop's defaults). */
export async function suppliersFor(shopId: string): Promise<SupplierView[]> {
  const [shop, saved, named, open] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { fabLeadDays: true } }),
    db.fabricSupplier.findMany({ where: { shopId } }),
    db.part.groupBy({ by: ["supplier"], where: { shopId, kind: "FABRIC", unit: "yd", consignLinkId: null, supplier: { not: null } }, _count: { _all: true } }),
    db.purchaseOrder.groupBy({ by: ["supplierId"], where: { shopId, status: { in: OPEN_STATUSES } }, _count: { _all: true } }),
  ]);
  const openBy = new Map(open.map((o) => [o.supplierId, o._count._all]));
  const byKey = new Map<string, SupplierView>();
  for (const s of saved) {
    byKey.set(supplierKey(s.name), {
      id: s.id,
      name: s.name,
      leadDays: s.leadDays,
      learnedDays: s.learnedDays,
      learnedOrders: s.learnedOrders,
      minOrderCents: s.minOrderCents,
      orderEmail: s.orderEmail,
      connector: connectorFor(s.connector).id,
      accountNumber: s.accountNumber,
      catalogMap: s.catalogMap ? cleanMap(s.catalogMap) : null,
      orderLayout: s.orderLayout ? cleanLayout(s.orderLayout) : null,
      catalogAt: s.catalogAt,
      catalogNote: s.catalogNote,
      lead: leadDaysOf(s, shop.fabLeadDays),
      fabrics: 0,
      openOrders: openBy.get(s.id) ?? 0,
    });
  }
  for (const g of named) {
    const name = g.supplier!.trim();
    if (!name) continue;
    const k = supplierKey(name);
    const cur = byKey.get(k);
    if (cur) cur.fabrics += g._count._all;
    else byKey.set(k, { id: null, name, leadDays: null, learnedDays: null, learnedOrders: 0, minOrderCents: 0, orderEmail: null, connector: "email", accountNumber: null, catalogMap: null, orderLayout: null, catalogAt: null, catalogNote: null, lead: leadDaysOf(null, shop.fabLeadDays), fabrics: g._count._all, openOrders: 0 });
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Finds the supplier by name (any capitals) or makes it; two at once can't make it twice (the unique key refuses the second). */
async function supplierNamed(tx: Prisma.TransactionClient, shopId: string, name: string) {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new UserError("Enter the supplier's name.");
  const find = () => tx.fabricSupplier.findFirst({ where: { shopId, name: { equals: clean, mode: "insensitive" } } });
  return (await find()) ?? (await tx.fabricSupplier.create({ data: { shopId, name: clean } }));
}

/** Saves one supplier's figures (made if the name has no record yet): own lead time (blank = the shop's), minimum order, order email. */
export async function saveSupplierFor(user: CurrentUser, fd: FormData): Promise<string> {
  const name = str(fd.get("name"));
  if (!name) throw new UserError("Which supplier?");
  const leadRaw = str(fd.get("leadDays"));
  let leadDays: number | null = null;
  if (leadRaw) {
    leadDays = Number(leadRaw);
    if (!Number.isInteger(leadDays) || leadDays < 1 || leadDays > 365) throw new UserError("Lead time: a whole number of days from 1 to 365 (or leave it blank).");
  }
  const minOrderCents = centsField(str(fd.get("minOrder")), "Minimum order") ?? 0;
  if (minOrderCents < 0 || minOrderCents > 100_000_000) throw new UserError("Minimum order: enter an amount in dollars.");
  const email = str(fd.get("orderEmail"));
  if (email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)) throw new UserError("That order email doesn't look right. Enter one address (name@company.com).");
  await db.$transaction(async (tx) => {
    const s = await supplierNamed(tx, user.shopId, name);
    await tx.fabricSupplier.update({ where: { id: s.id }, data: { leadDays, minOrderCents, orderEmail: email } });
  });
  return `Saved ${name}.`;
}

/**
 * Saves how orders go to one supplier (package F6): the connector, the shop's account number there (never a login or
 * password) and the column layout of the cart-upload spreadsheet, one "Heading = field" line a column (blank: the plain layout).
 */
export async function saveConnectorFor(user: CurrentUser, fd: FormData): Promise<string> {
  const name = str(fd.get("name"));
  if (!name) throw new UserError("Which supplier?");
  const connector = str(fd.get("connector")) ?? "email";
  if (!isConnectorId(connector)) throw new UserError("Pick one of the ways to send orders.");
  const account = str(fd.get("accountNumber"));
  if (account && account.length > 60) throw new UserError("Account number: 60 characters at most.");
  const layoutText = String(fd.get("layout") ?? "");
  const layout = layoutText.trim() ? parseLayoutText(layoutText) : null;
  await db.$transaction(async (tx) => {
    const s = await supplierNamed(tx, user.shopId, name);
    await tx.fabricSupplier.update({ where: { id: s.id }, data: { connector, accountNumber: account, orderLayout: layout && layout.length ? layout : Prisma.DbNull } });
  });
  return `Saved how orders go to ${name}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// On order
// ---------------------------------------------------------------------------------------------------------------

/**
 * Yards still to come on open orders (sent or partly received) by fabric, and yards on draft orders (not ordered yet).
 * `partIds` limits it to those fabrics.
 */
export async function onOrderFor(shopId: string, partIds?: string[]): Promise<Map<string, { open: number; draft: number }>> {
  const lines = await db.purchaseOrderLine.findMany({
    where: { shopId, partId: partIds ? { in: partIds } : { not: null }, order: { shopId, status: { in: ["DRAFT", ...OPEN_STATUSES] } } },
    select: { partId: true, unit: true, qty: true, boltYards: true, costCents: true, receivedYards: true, order: { select: { status: true } } },
  });
  const out = new Map<string, { open: number; draft: number }>();
  for (const l of lines) {
    if (!l.partId) continue;
    const cur = out.get(l.partId) ?? { open: 0, draft: 0 };
    if (l.order.status === "DRAFT") cur.draft += lineYards(l);
    else cur.open += outstandingYards(l);
    out.set(l.partId, cur);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The Reorder tab
// ---------------------------------------------------------------------------------------------------------------

export type ReorderRow = {
  item: InsightItem;
  supplier: string | null;
  lead: { days: number; from: "learned" | "supplier" | "shop" };
  z: number;
  staple: boolean;
  onOrder: number;
  inDraft: number;
  math: ReorderOut;
  urgent: boolean;
  /** Percent of the Reorder now window's stock that sold. */
  soldPct: number;
};

export type ReorderView = { rows: ReorderRow[]; reviewWeeks: number; urgentDays: number; urgentPct: number; urgentWeeks: number; noSupplier: number };

/**
 * Fabrics worth reordering: in print (not "closed out"), selling, not an aged unsold lot (that is the markdown ladder's job),
 * with a suggestion of at least a quarter of a half bolt. Urgent first, then the fewest weeks of supply.
 */
export async function reorderFor(shopId: string, now = new Date()): Promise<ReorderView> {
  const [ins, sup, onOrder, linked] = await Promise.all([
    insightFor(shopId, now),
    suppliersFor(shopId),
    onOrderFor(shopId),
    db.part.findMany({ where: { shopId, OR: [{ fatQuarterId: { not: null } }, { halfYardId: { not: null } }, { remnantId: { not: null } }] }, select: { fatQuarterId: true, halfYardId: true, remnantId: true } }),
  ]);
  const s = ins.settings;
  const skip = new Set(linked.flatMap((l) => [l.fatQuarterId, l.halfYardId, l.remnantId]).filter((x): x is string => !!x));
  const leadOf = new Map(sup.map((x) => [supplierKey(x.name), x.lead]));
  const rows: ReorderRow[] = [];
  let noSupplier = 0;
  for (const i of ins.items) {
    if (skip.has(i.id) || i.inPrint === "NO" || i.perWeek < 1e-9 || i.daysInStock <= 0) continue;
    if (i.aged && slowStage(i.aged, i.sinceFirst, s, i.weeks) && i.aged.ageDays >= s.fabMarkdownDays) continue;
    const lead = leadOf.get(supplierKey(i.supplier)) ?? leadDaysOf(null, s.fabLeadDays);
    const staple = !i.collection;
    const z = staple ? s.fabZStaple : s.fabZCollection;
    const oo = onOrder.get(i.id);
    const onOrderYd = oo?.open ?? 0;
    const math = reorderMath({ perWeek: i.perWeek, sigmaWeek: i.sigmaWeek, leadWeeks: lead.days / 7, reviewWeeks: s.fabReviewWeeks, z, onHand: i.qty, onOrder: onOrderYd, boltYards: i.boltYards });
    if (math.halves <= 0) continue;
    const urgent = isUrgent({ sold: i.urgentSold, lot: i.urgentLot, weeks: i.weeks, leadWeeks: lead.days / 7 }, s);
    if (!i.supplier?.trim()) noSupplier += 1;
    rows.push({ item: i, supplier: i.supplier?.trim() || null, lead, z, staple, onOrder: onOrderYd, inDraft: oo?.draft ?? 0, math, urgent, soldPct: i.urgentLot > 0 ? Math.round((i.urgentSold / i.urgentLot) * 100) : 0 });
  }
  rows.sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.item.weeks ?? 1e9) - (b.item.weeks ?? 1e9) || a.item.partNumber.localeCompare(b.item.partNumber));
  return { rows, reviewWeeks: s.fabReviewWeeks, urgentDays: s.fabUrgentDays, urgentPct: s.fabUrgentSoldPct, urgentWeeks: s.fabUrgentWeeks, noSupplier };
}

// ---------------------------------------------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------------------------------------------

/** The next order number for the company (a unique key on shopId + number backs it: two at once can't share one). */
async function nextNumber(tx: Prisma.TransactionClient, shopId: string): Promise<number> {
  const top = await tx.purchaseOrder.aggregate({ where: { shopId }, _max: { number: true } });
  return (top._max.number ?? 0) + 1;
}

const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/** Makes a draft for the supplier (retrying when another order took the number at the same moment). */
async function newDraft(tx: Prisma.TransactionClient, shopId: string, supplier: { id: string; name: string }) {
  return tx.purchaseOrder.create({ data: { shopId, number: await nextNumber(tx, shopId), supplierId: supplier.id, supplierName: supplier.name } });
}

async function inTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(fn);
    } catch (e) {
      if (isUnique(e) && attempt < 3) continue;
      throw e;
    }
  }
}

/** A company's own fabric by the maker's number (any capitals) or another number it goes by. */
async function fabricByNumber(shopId: string, typed: string) {
  const number = typed.split(" | ")[0].trim();
  if (!number) throw new UserError("Enter the fabric's item number.");
  const part = await db.part.findFirst({
    where: { shopId, consignLinkId: null, OR: [{ partNumber: { equals: number, mode: "insensitive" } }, { numberKeys: { has: numberKey(number) } }] },
  });
  if (!part) throw new UserError(`No item numbered ${number} in inventory. Add the fabric first (Add a collection, or Parts).`);
  if (part.unit !== "yd") throw new UserError(`${part.partNumber} isn't sold by the yard, so it can't be ordered as fabric here.`);
  return part;
}

const yardCostCents = (p: { costCents: number | null }) => p.costCents;

/**
 * Adds fabrics to draft orders, one draft per supplier (an existing draft is reused; a fabric already on it has its amount
 * set, not doubled). `picks` are fabric ids and bolts. A fabric with no supplier text is refused by name.
 */
export async function addToDraftFor(user: CurrentUser, picks: { partId: string; bolts: number }[]): Promise<string> {
  if (!picks.length) throw new UserError("Tick the fabrics to order.");
  if (picks.length > MAX_ORDER_LINES) throw new UserError(`${MAX_ORDER_LINES} lines at most at a time.`);
  for (const p of picks) {
    assertId(p.partId);
    if (!Number.isFinite(p.bolts) || p.bolts <= 0 || p.bolts > 1000 || Math.abs(p.bolts * 2 - Math.round(p.bolts * 2)) > 1e-9) throw new UserError("Bolts are counted in halves (1/2, 1, 1 1/2...).");
  }
  const made = await inTx(async (tx) => {
    const parts = await tx.part.findMany({ where: { shopId: user.shopId, id: { in: picks.map((p) => p.partId) }, kind: "FABRIC", unit: "yd", consignLinkId: null } });
    if (parts.length !== new Set(picks.map((p) => p.partId)).size) throw new UserError("Fabric not found: one of the ticked fabrics isn't in your inventory.");
    const byId = new Map(parts.map((p) => [p.id, p]));
    const none = parts.filter((p) => !p.supplier?.trim());
    if (none.length) throw new UserError(`Give ${none.map((p) => p.partNumber).slice(0, 3).join(", ")} a supplier first (open the item): an order goes to one supplier.`);
    const touched = new Map<string, { number: number; supplier: string; lines: number }>();
    for (const pick of picks) {
      const part = byId.get(pick.partId)!;
      const sup = await supplierNamed(tx, user.shopId, part.supplier!);
      let po = await tx.purchaseOrder.findFirst({ where: { shopId: user.shopId, supplierId: sup.id, status: "DRAFT" }, orderBy: { number: "desc" } });
      if (!po) po = await newDraft(tx, user.shopId, sup);
      const data = { unit: "BOLT" as const, qty: pick.bolts, boltYards: part.boltYards, costCents: yardCostCents(part), itemNumber: part.partNumber, description: part.description };
      const have = await tx.purchaseOrderLine.findFirst({ where: { shopId: user.shopId, orderId: po.id, partId: part.id } });
      if (have) await tx.purchaseOrderLine.update({ where: { id: have.id }, data });
      else {
        const count = await tx.purchaseOrderLine.count({ where: { orderId: po.id } });
        if (count >= MAX_ORDER_LINES) throw new UserError(`Order #${po.number} is full (${MAX_ORDER_LINES} lines).`);
        await tx.purchaseOrderLine.create({ data: { shopId: user.shopId, orderId: po.id, partId: part.id, ...data } });
      }
      const t = touched.get(po.id) ?? { number: po.number, supplier: sup.name, lines: 0 };
      t.lines += 1;
      touched.set(po.id, t);
    }
    return [...touched.values()];
  });
  return `Added to ${made.map((m) => `order #${m.number} (${m.supplier}, ${m.lines} ${m.lines === 1 ? "line" : "lines"})`).join(" and ")}.`;
}

/** Starts an empty draft order for a supplier by name; returns its id. */
export async function createOrderFor(user: CurrentUser, supplierName: string): Promise<string> {
  const name = (supplierName ?? "").trim();
  if (!name) throw new UserError("Enter the supplier's name.");
  return inTx(async (tx) => {
    const sup = await supplierNamed(tx, user.shopId, name);
    const po = await newDraft(tx, user.shopId, sup);
    return po.id;
  });
}

export type OrderLineView = { id: string; partId: string | null; itemNumber: string; description: string; unit: "YD" | "BOLT"; qty: number; boltYards: number; costCents: number | null; receivedYards: number; photoId: string | null };
export type OrderView = {
  id: string;
  number: number;
  supplier: { id: string; name: string; orderEmail: string | null; minOrderCents: number; connector: string; accountNumber: string | null; layout: OrderLayout | null; lead: { days: number; from: "learned" | "supplier" | "shop" } };
  /** How it went to the supplier (package F6): smtp, mailto, file or none; null while a draft. */
  sentVia: OrderVia | null;
  status: "DRAFT" | "SENT" | "PARTLY_RECEIVED" | "RECEIVED" | "CANCELLED";
  note: string | null;
  createdAt: Date;
  sentAt: Date | null;
  firstReceivedAt: Date | null;
  receivedAt: Date | null;
  cancelledAt: Date | null;
  lines: OrderLineView[];
  totalCents: number;
  totalYards: number;
  shopName: string;
  timeZone: string;
};

/** One order with its lines (by shopId and id), for the order page, the print page and the CSV. */
export async function orderFor(shopId: string, id: string): Promise<OrderView | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const [po, shop] = await Promise.all([
    db.purchaseOrder.findFirst({ where: { id, shopId }, include: { supplier: true, lines: { orderBy: { id: "asc" }, include: { part: { select: { photos: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true } } } } } } } }),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, timeZone: true, fabLeadDays: true } }),
  ]);
  if (!po) return null;
  const lines: OrderLineView[] = po.lines.map((l) => ({ id: l.id, partId: l.partId, itemNumber: l.itemNumber, description: l.description, unit: l.unit, qty: l.qty, boltYards: l.boltYards, costCents: l.costCents, receivedYards: l.receivedYards, photoId: l.part?.photos[0]?.id ?? null }));
  return {
    id: po.id,
    number: po.number,
    supplier: { id: po.supplier.id, name: po.supplier.name, orderEmail: po.supplier.orderEmail, minOrderCents: po.supplier.minOrderCents, connector: connectorFor(po.supplier.connector).id, accountNumber: po.supplier.accountNumber, layout: po.supplier.orderLayout ? cleanLayout(po.supplier.orderLayout) : null, lead: leadDaysOf(po.supplier, shop.fabLeadDays) },
    sentVia: po.sentVia === "smtp" || po.sentVia === "mailto" || po.sentVia === "file" || po.sentVia === "none" ? po.sentVia : null,
    status: po.status,
    note: po.note,
    createdAt: po.createdAt,
    sentAt: po.sentAt,
    firstReceivedAt: po.firstReceivedAt,
    receivedAt: po.receivedAt,
    cancelledAt: po.cancelledAt,
    lines,
    totalCents: orderTotal(lines),
    totalYards: lines.reduce((a, l) => a + lineYards(l), 0),
    shopName: shop.name,
    timeZone: shop.timeZone,
  };
}

export type OrderListRow = { id: string; number: number; supplierName: string; status: OrderView["status"]; createdAt: Date; sentAt: Date | null; lines: number; totalCents: number };

/** The company's orders, open ones first then the latest finished (60 at most). */
export async function ordersListFor(shopId: string): Promise<OrderListRow[]> {
  const pos = await db.purchaseOrder.findMany({
    where: { shopId },
    orderBy: { number: "desc" },
    take: 60,
    include: { lines: { select: { unit: true, qty: true, boltYards: true, costCents: true, receivedYards: true } } },
  });
  const rows = pos.map((p) => ({ id: p.id, number: p.number, supplierName: p.supplierName, status: p.status, createdAt: p.createdAt, sentAt: p.sentAt, lines: p.lines.length, totalCents: orderTotal(p.lines) }));
  const open = (r: { status: string }) => (r.status === "DRAFT" || r.status === "SENT" || r.status === "PARTLY_RECEIVED" ? 0 : 1);
  return rows.sort((a, b) => open(a) - open(b) || b.number - a.number);
}

function qtyOf(v: FormDataEntryValue | null, what: string): number {
  const t = str(v);
  const n = t == null ? NaN : Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_QTY_LINE) throw new UserError(`${what}: enter an amount over 0.`);
  return n;
}

function checkQty(unit: "YD" | "BOLT", qty: number, what: string) {
  if (unit === "YD" && !inEighths(qty)) throw new UserError(`${what}: yards are counted in eighths (1/8 = 0.125).`);
  if (unit === "BOLT" && Math.abs(qty * 2 - Math.round(qty * 2)) > 1e-9) throw new UserError(`${what}: bolts are counted in halves (1/2, 1, 1 1/2...).`);
}

const unitOf = (v: FormDataEntryValue | null): "YD" | "BOLT" => (str(v) === "BOLT" ? "BOLT" : "YD");

async function draftOrder(tx: Prisma.TransactionClient, shopId: string, id: string) {
  assertId(id);
  const po = await tx.purchaseOrder.findFirst({ where: { id, shopId } });
  if (!po) throw new UserError("Order not found.");
  if (po.status !== "DRAFT") throw new UserError(`Order #${po.number} isn't a draft any more, so its lines can't be changed.`);
  return po;
}

/** Adds a line by hand (the maker's number, amount, yards or bolts); the cost is the fabric's own unless typed. */
export async function addLineFor(user: CurrentUser, orderId: string, fd: FormData): Promise<string> {
  assertId(orderId);
  if (!(await db.purchaseOrder.findFirst({ where: { id: orderId, shopId: user.shopId }, select: { id: true } }))) throw new UserError("Order not found.");
  const part = await fabricByNumber(user.shopId, str(fd.get("itemNumber")) ?? "");
  const unit = unitOf(fd.get("unit"));
  const qty = qtyOf(fd.get("qty"), part.partNumber);
  checkQty(unit, qty, part.partNumber);
  const typed = centsField(str(fd.get("cost")), `${part.partNumber} cost`);
  await db.$transaction(async (tx) => {
    const po = await draftOrder(tx, user.shopId, orderId);
    const dup = await tx.purchaseOrderLine.findFirst({ where: { shopId: user.shopId, orderId: po.id, partId: part.id } });
    if (dup) throw new UserError(`${part.partNumber} is already on this order. Change its amount below.`);
    const count = await tx.purchaseOrderLine.count({ where: { orderId: po.id } });
    if (count >= MAX_ORDER_LINES) throw new UserError(`${MAX_ORDER_LINES} lines at most on one order.`);
    await tx.purchaseOrderLine.create({ data: { shopId: user.shopId, orderId: po.id, partId: part.id, itemNumber: part.partNumber, description: part.description, unit, qty, boltYards: part.boltYards, costCents: typed ?? yardCostCents(part) } });
  });
  return `Added ${part.partNumber}.`;
}

/** Saves a draft: the note, each line's amount, unit and cost, and the lines ticked to remove. */
export async function saveOrderFor(user: CurrentUser, orderId: string, fd: FormData): Promise<void> {
  await db.$transaction(async (tx) => {
    const po = await draftOrder(tx, user.shopId, orderId);
    const lines = await tx.purchaseOrderLine.findMany({ where: { shopId: user.shopId, orderId: po.id } });
    for (const l of lines) {
      if (fd.get(`remove.${l.id}`)) {
        await tx.purchaseOrderLine.delete({ where: { id: l.id } });
        continue;
      }
      const unit = unitOf(fd.get(`unit.${l.id}`));
      const qty = qtyOf(fd.get(`qty.${l.id}`), l.itemNumber);
      checkQty(unit, qty, l.itemNumber);
      const cost = centsField(str(fd.get(`cost.${l.id}`)), `${l.itemNumber} cost`);
      await tx.purchaseOrderLine.update({ where: { id: l.id }, data: { unit, qty, costCents: cost } });
    }
    const note = str(fd.get("note"));
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { note: note ? note.slice(0, 1000) : null } });
  });
}

/** Marks the draft as sent (the shop emails or prints it from the order page): from then on it counts as on order. */
export async function sendOrderFor(user: CurrentUser, orderId: string, how: "connector" | "manual" = "connector"): Promise<string> {
  assertId(orderId);
  // Claim the draft first (so a double click can't send twice), then let the supplier's connector send it. A connector that
  // can't send puts the draft back and says why; "manual" skips the connector (the shop emails, prints or phones it itself).
  const claimed = await db.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirst({ where: { id: orderId, shopId: user.shopId }, include: { lines: true } });
    if (!po) throw new UserError("Order not found.");
    if (po.status !== "DRAFT") throw new UserError(`Order #${po.number} was already sent.`);
    if (!po.lines.length) throw new UserError("Add at least one line before sending.");
    const noPart = po.lines.find((l) => !l.partId);
    if (noPart) throw new UserError(`${noPart.itemNumber} is no longer in inventory: remove it from the order.`);
    const at = new Date();
    const marked = await tx.purchaseOrder.updateMany({ where: { id: po.id, shopId: user.shopId, status: "DRAFT" }, data: { status: "SENT", sentAt: at } });
    if (marked.count !== 1) throw new UserError(`Order #${po.number} was already sent.`);
    return { number: po.number, at };
  });
  const finish = (via: OrderVia) => db.purchaseOrder.updateMany({ where: { id: orderId, shopId: user.shopId }, data: { sentVia: via } });
  if (how === "manual") {
    await finish("none");
    return `Order #${claimed.number} is marked sent. Its yards now count as on order.`;
  }
  const o = await orderFor(user.shopId, orderId);
  if (!o) throw new UserError("Order not found.");
  const conn = connectorFor(o.supplier.connector);
  const ctx: ConnectorContext = {
    shopId: user.shopId,
    supplier: { id: o.supplier.id, name: o.supplier.name, orderEmail: o.supplier.orderEmail, accountNumber: o.supplier.accountNumber, catalogMap: null, orderLayout: o.supplier.layout },
  };
  try {
    const out = conn.placeOrder ? await conn.placeOrder(ctx, o) : { via: "none" as const, note: `Order #${o.number} is marked sent. Print it or download the spreadsheet below.` };
    await finish(out.via);
    return out.note;
  } catch (e) {
    // Nothing went: back to a draft, so the shop can fix the cause and send again.
    await db.purchaseOrder.updateMany({ where: { id: orderId, shopId: user.shopId, status: "SENT", sentAt: claimed.at, firstReceivedAt: null }, data: { status: "DRAFT", sentAt: null, sentVia: null } });
    throw e;
  }
}

/** Cancels an order that nothing has come against (a draft or a sent order). */
export async function cancelOrderFor(user: CurrentUser, orderId: string): Promise<string> {
  assertId(orderId);
  return db.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirst({ where: { id: orderId, shopId: user.shopId } });
    if (!po) throw new UserError("Order not found.");
    if (po.status === "PARTLY_RECEIVED") throw new UserError(`Some of order #${po.number} has come in. Use "Close order" to stop waiting for the rest.`);
    if (po.status === "RECEIVED" || po.status === "CANCELLED") throw new UserError(`Order #${po.number} is already ${po.status === "RECEIVED" ? "received" : "cancelled"}.`);
    const m = await tx.purchaseOrder.updateMany({ where: { id: po.id, shopId: user.shopId, status: { in: ["DRAFT", "SENT"] } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    if (m.count !== 1) throw new UserError("The order changed while you were looking. Reload and try again.");
    return `Order #${po.number} is cancelled.`;
  });
}

/** Closes a partly received order: the rest isn't coming, so it stops counting as on order. */
export async function closeOrderFor(user: CurrentUser, orderId: string): Promise<string> {
  assertId(orderId);
  return db.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirst({ where: { id: orderId, shopId: user.shopId } });
    if (!po) throw new UserError("Order not found.");
    const m = await tx.purchaseOrder.updateMany({ where: { id: po.id, shopId: user.shopId, status: "PARTLY_RECEIVED" }, data: { status: "RECEIVED", receivedAt: new Date() } });
    if (m.count !== 1) throw new UserError(`Order #${po.number} isn't partly received.`);
    return `Order #${po.number} is closed. The yards that didn't come no longer count as on order.`;
  });
}

/**
 * Receives yards against a sent or partly received order: `yards.<lineId>` per line (blank skips it). Each makes a RECEIVED
 * move (which also starts that fabric's age clock), adds the yards to the fabric, and the order becomes partly received or
 * received. The first receipt teaches the supplier's lead time (days from sent to that receipt). A fabric with no cost
 * gets the line's cost.
 */
export async function receiveOrderFor(user: CurrentUser, orderId: string, fd: FormData): Promise<string> {
  assertId(orderId);
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true } });
  return db.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirst({ where: { id: orderId, shopId: user.shopId }, include: { lines: true, supplier: true } });
    if (!po) throw new UserError("Order not found.");
    if (po.status === "DRAFT") throw new UserError(`Order #${po.number} hasn't been sent. Send it first.`);
    if (po.status === "RECEIVED" || po.status === "CANCELLED") throw new UserError(`Order #${po.number} is ${po.status === "RECEIVED" ? "already received" : "cancelled"}.`);
    // Hold the order against a second receipt at the same moment (the status guard is the lock).
    const held = await tx.purchaseOrder.updateMany({ where: { id: po.id, shopId: user.shopId, status: po.status }, data: { status: po.status } });
    if (held.count !== 1) throw new UserError("The order changed while you were looking. Reload and try again.");
    const fresh = await tx.purchaseOrderLine.findMany({ where: { orderId: po.id, shopId: user.shopId } });
    const now = new Date();
    let total = 0;
    let count = 0;
    const after: PoLineLike[] = [];
    for (const l of fresh) {
      const raw = str(fd.get(`yards.${l.id}`));
      let got = 0;
      if (raw) {
        got = Number(raw);
        if (!Number.isFinite(got) || got < 0 || got > MAX_STOCK) throw new UserError(`${l.itemNumber}: enter the yards that came (0 to ${MAX_STOCK.toLocaleString("en-US")}).`);
        if (!inEighths(got)) throw new UserError(`${l.itemNumber}: fabric is counted in eighths of a yard (1/8 = 0.125).`);
      }
      if (got > 0) {
        if (!l.partId) throw new UserError(`${l.itemNumber} is no longer in inventory, so its yards can't be received.`);
        const part = await tx.part.findFirst({ where: { id: l.partId, shopId: user.shopId } });
        if (!part) throw new UserError(`${l.itemNumber} is no longer in inventory, so its yards can't be received.`);
        await tx.part.update({
          where: { id: part.id },
          data: { qtyOnHand: { increment: got }, ...(part.costCents == null && l.costCents != null ? { costCents: l.costCents, costTenThou: null } : {}) },
        });
        await tx.stockMove.create({ data: { shopId: user.shopId, partId: part.id, qty: got, reason: "RECEIVED", userId: user.id, note: `Order #${po.number} from ${po.supplierName}` } });
        await tx.purchaseOrderLine.update({ where: { id: l.id }, data: { receivedYards: { increment: got } } });
        total += got;
        count += 1;
      }
      after.push({ unit: l.unit, qty: l.qty, boltYards: l.boltYards, costCents: l.costCents, receivedYards: l.receivedYards + got });
    }
    if (count === 0) throw new UserError("Enter the yards that came on at least one line.");
    const status = statusAfterReceive(after);
    const data: Prisma.PurchaseOrderUpdateInput = { status };
    if (status === "RECEIVED") data.receivedAt = now;
    let learned = "";
    if (!po.firstReceivedAt) {
      data.firstReceivedAt = now;
      if (po.sentAt) {
        const days = Math.max(1, daysAgo(dateIn(po.sentAt, shop.timeZone), todayIn(shop.timeZone)));
        const l = learnLead(po.supplier, days);
        await tx.fabricSupplier.update({ where: { id: po.supplierId }, data: l });
        learned = ` ${po.supplierName}'s lead time is now ${l.learnedDays} days (this one took ${days}).`;
      }
    }
    await tx.purchaseOrder.update({ where: { id: po.id }, data });
    return `Received ${yards(total)} yd on ${count} ${count === 1 ? "line" : "lines"} of order #${po.number}${status === "RECEIVED" ? ", all in" : ""}.${learned}`;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Sending: the CSV and the email text (nothing is sent from here)
// ---------------------------------------------------------------------------------------------------------------

const dollars = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));

/** The order as a spreadsheet in the supplier's own column layout (package F6), or the plain one: maker's item number, description, amount, unit, yards, cost a yard, line total. */
export function orderCsvRows(o: OrderView): unknown[][] {
  return orderRows(o, o.supplier.layout, o.supplier.accountNumber);
}

/** The mailto: link for the order (the shop's own mail program opens with it filled in; a long order points at the spreadsheet). */
export function mailtoFor(o: OrderView): string {
  const subject = `Purchase order #${o.number} from ${o.shopName}`;
  let body = orderText(o);
  if (body.length > 1500) body = `${subject}\n\nThe order is too long for an email body: the spreadsheet is attached.\nTotal: ${yards(o.totalYards)} yd`;
  return `mailto:${o.supplier.orderEmail ?? ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body).replace(/%0A/g, "%0D%0A")}`;
}

/** The plain-text body of the order, for the email and the print page. */
export function orderText(o: OrderView): string {
  const amount = (l: OrderLineView) => (l.unit === "BOLT" ? `${l.qty} ${l.qty === 1 ? "bolt" : "bolts"} (${yards(lineYards(l))} yd)` : `${yards(l.qty)} yd`);
  const rows = o.lines.map((l) => `${l.itemNumber}  ${l.description}  ${amount(l)}${l.costCents != null ? `  @ $${dollars(l.costCents)}/yd` : ""}`);
  return [`Purchase order #${o.number} from ${o.shopName}`, `To: ${o.supplier.name}`, "", ...rows, "", `Total: ${yards(o.totalYards)} yd${o.totalCents ? `, $${dollars(o.totalCents)}` : ""}`, ...(o.note ? ["", o.note] : [])].join("\n");
}
