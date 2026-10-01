"use server";

// The sewing / quilt shop's register: ring up notions, fabric by the yard, consigned stock and repair pickups.
// Cards are run on the shop's own card terminal; the register records how each sale was paid.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError, isUserError } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { codeKeys, numberKey } from "@/lib/parts";
import { withDisclosure } from "@/lib/part-labels";
import { sameText } from "@/lib/input";
import { sendToPartner } from "@/lib/partners";
import { normalizeTerms } from "@/lib/partner-terms";
import { discountShares, inEighths, lineNet, orderDiscountShares, qtyText, roundCents, saleTotals, tenderProblem, TENDER_METHODS, type Tender } from "@/lib/register-math";
import { splitForReturn } from "@/lib/sale-return";
import { applyUnitLine, prepareUnitLines, registerUnitHits, voidUnitLines } from "@/lib/vac/sale-units";
import type { TradeInInput } from "@/lib/vac/types";
import type { Prisma } from "@/generated/prisma/client";
import { viewItem, type RegisterItem } from "@/lib/register-item";

// RegisterItem and the Part -> item mapping live in src/lib/register-item.ts: a "use server" file may export only async
// functions, and the Vac Shop unit hooks (src/lib/vac/sale-units.ts) build items too.
export type { RegisterItem };
const view = viewItem;

/**
 * A scanned barcode or typed number: the item, or null. The item with that number comes first, then items that only
 * list it as another number (cross-references). When the shop stocks the number itself and also holds a partner's
 * consigned stock of it, its own stock sells first; consigned stock sells once its own runs out.
 */
export async function itemByCode(code: string): Promise<RegisterItem | null> {
  const user = await requireUser();
  const c = code.trim();
  if (!c) return null;
  // Its barcode form too: a scanner's 12-digit UPC finds the item imported with its 13-digit EAN.
  const keys = codeKeys(c);
  const matches = await db.part.findMany({
    where: { shopId: user.shopId, OR: [{ partNumber: sameText(c) }, ...(keys.length ? [{ numberKeys: { hasSome: keys } }] : [])] },
    take: 20,
  });
  const lc = c.toLowerCase();
  const exact = (p: { partNumber: string }) => p.partNumber.toLowerCase() === lc;
  // The same item kept apart as a partner's consigned stock ("N (Their shop)"), as this shop's own beside a partner's
  // "N" ("N (own)"), or in another condition ("N (used)"), counts as the number itself.
  const twin = (p: (typeof matches)[number]) => {
    const n = p.partNumber.toLowerCase();
    return n.startsWith(`${lc} (`) && (Boolean(p.consignLinkId) || /\((own|new|used|refurbished)\)$/.test(n));
  };
  const rank = (p: (typeof matches)[number]) => (exact(p) || twin(p) ? 0 : 8) + (p.qtyOnHand > 0 ? 0 : 4) + (p.consignLinkId ? 2 : 0) + (exact(p) ? 0 : 1);
  matches.sort((a, b) => rank(a) - rank(b));
  // No part by that number: a vacuum in stock whose serial it is (Vac Shop).
  return matches[0] ? view(matches[0]) : ((await registerUnitHits({ shopId: user.shopId, q: c, mode: "code" }))[0] ?? null);
}

// A repair the customer can take home: the repair shop has sent it back.
const BACK_FROM_REPAIR = ["READY_IN_TRUCK", "READY_FOR_PICKUP", "RETURNED_UNREPAIRED"];

/** What the customer still owes on a repair: the bill, less anything already paid to either shop. */
function repairDue(j: { totalCents: number | null; repairPaidCents: number | null; paidCents: number | null }) {
  return Math.max(0, (j.totalCents ?? 0) - (j.repairPaidCents ?? 0) - (j.paidCents ?? 0));
}

/** Items whose number or description matches, for the search box. */
export async function findItems(q: string): Promise<RegisterItem[]> {
  const user = await requireUser();
  const t = q.trim();
  if (t.length < 2) return [];
  const words = t.split(/\s+/).slice(0, 5);
  const parts = await db.part.findMany({
    where: {
      shopId: user.shopId,
      OR: [
        { partNumber: { contains: t, mode: "insensitive" } },
        { numberKeys: { has: numberKey(t) } },
        { AND: words.map((w) => ({ description: { contains: w, mode: "insensitive" as const } })) },
      ],
    },
    orderBy: [{ qtyOnHand: "desc" }, { description: "asc" }],
    take: 25,
  });
  // Vacuums in stock whose brand or model matches come after the parts (Vac Shop).
  return [...parts.map(view), ...(await registerUnitHits({ shopId: user.shopId, q: t, mode: "search" }))];
}

export type PickupJob = {
  id: string;
  tag: string;
  customerName: string;
  machine: string;
  dueCents: number;
  /** Already paid at this counter: what's due now is the rest of a bill that went up afterwards. */
  paidCents: number;
  pickedUp: boolean;
  status: string;
  customerId: string | null;
};

function toPickupJob(j: { id: string; tag: string; customerName: string; brand: string; model: string; paidCents: number | null; pickedUpAt: Date | null; status: string; customerId: string | null; totalCents: number | null; repairPaidCents: number | null }): PickupJob {
  return {
    id: j.id,
    tag: j.tag,
    customerName: j.customerName,
    machine: `${j.brand} ${j.model}`,
    dueCents: repairDue(j),
    paidCents: j.paidCents ?? 0,
    pickedUp: Boolean(j.pickedUpAt),
    status: j.status,
    customerId: j.customerId,
  };
}

/**
 * Repairs back from the partner repair shop and not paid for yet: the customer pays for them at the register. Also a
 * repair paid here whose bill then went up (the repair shop added to it before its update arrived): the rest is due.
 */
export async function pickupJobs(): Promise<PickupJob[]> {
  const user = await requireUser();
  const jobs = await db.repairJob.findMany({
    where: {
      shopId: user.shopId,
      side: "retail",
      totalCents: { not: null },
      OR: [
        { paidAt: null, status: { in: BACK_FROM_REPAIR } },
        { paidCents: { gt: 0 }, totalCents: { gt: db.repairJob.fields.paidCents } },
      ],
    },
    orderBy: { updatedAt: "desc" },
  });
  return jobs.map(toPickupJob).filter((j) => j.dueCents > 0);
}

/**
 * The one pickup job whose claim tag this is (the tag printed as "T<tag>" on the two-part claim tag, or typed plain),
 * if it has a balance due. Scanning or typing it at the register finds this the same way /search finds the repair.
 */
export async function pickupJobByTag(tag: string): Promise<PickupJob | null> {
  const user = await requireUser();
  const t = tag.trim().slice(0, 20);
  if (!t) return null;
  const j = await db.repairJob.findFirst({ where: { shopId: user.shopId, side: "retail", tag: t, totalCents: { not: null } } });
  if (!j) return null;
  const job = toPickupJob(j);
  return job.dueCents > 0 ? job : null;
}

export type SaleReturnLine = {
  partId: string | null;
  description: string;
  partNumber: string | null;
  unit: string | null;
  /** Already the return's own quantity (negative of what the sale charged; see splitForReturn), not the sale's. */
  qty: number;
  unitPriceCents: number;
  taxable: boolean;
};

export type SaleForReturn = {
  id: string;
  number: number;
  customer: CustomerHit | null;
  lines: SaleReturnLine[];
  /** Payment lines for a repair bill, left out: reverse those with the repair shop instead (same as voiding a sale). */
  skippedRepairLines: number;
};

/**
 * A past sale by its receipt number (the "S<number>" the printed receipt's barcode reads), to scan back in as a
 * return at the register instead of re-finding and re-pricing each item by hand.
 */
export async function saleForReturn(number: number): Promise<SaleForReturn | null> {
  const user = await requireUser();
  if (!Number.isInteger(number) || number <= 0) return null;
  const sale = await db.sale.findFirst({
    where: { shopId: user.shopId, number, status: "COMPLETED" },
    include: { lines: true, customer: { select: { id: true, name: true, phone: true } } },
  });
  if (!sale) return null;
  const lines: SaleReturnLine[] = [];
  let skippedRepairLines = 0;
  for (const l of sale.lines) {
    if (l.repairJobId) {
      skippedRepairLines++;
      continue;
    }
    // What the line actually charged (its own discount folded in), split into whole-cent unit prices that refund
    // exactly that amount: one line, or two when the charge doesn't divide evenly among the units (splitForReturn).
    const net = lineNet({ qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents, taxable: l.taxable });
    for (const part of splitForReturn(l.qty, net)) {
      lines.push({ partId: l.partId, description: l.description, partNumber: l.partNumber, unit: l.unit, qty: part.qty, unitPriceCents: part.unitPriceCents, taxable: l.taxable });
    }
  }
  return { id: sale.id, number: sale.number, customer: sale.customer, lines, skippedRepairLines };
}

export type CustomerHit = { id: string; name: string; phone: string | null };

export async function findCustomers(q: string): Promise<CustomerHit[]> {
  const user = await requireUser();
  const t = q.trim();
  if (t.length < 2) return [];
  const digits = t.replace(/\D/g, "");
  return db.customer.findMany({
    where: {
      shopId: user.shopId,
      kind: "RETAIL",
      OR: [{ name: { contains: t, mode: "insensitive" } }, ...(digits.length >= 4 ? [{ phone: { contains: digits.slice(-4) } }] : []), { email: { contains: t, mode: "insensitive" } }],
    },
    select: { id: true, name: true, phone: true },
    orderBy: { name: "asc" },
    take: 10,
  });
}

/**
 * A customer added from the register (name, phone, email, address) without leaving the sale: the sale is then rung up
 * under them. Returns the same shape the customer search gives, so the register picks it straight away.
 */
export async function quickAddCustomer(fd: FormData): Promise<CustomerHit | { error: string }> {
  try {
    const user = await requireUser();
    const text = (k: string) => String(fd.get(k) ?? "").trim();
    const name = text("name").slice(0, 120);
    const phone = text("phone").slice(0, 40) || null;
    const email = text("email").slice(0, 120) || null;
    const address = text("address").slice(0, 300) || null;
    if (!name || (!phone && !email)) throw new UserError("Enter a name and a phone or email.");
    const c = await db.customer.create({ data: { shopId: user.shopId, kind: "RETAIL", name, phone, email, address }, select: { id: true, name: true, phone: true } });
    revalidatePath("/customers", "layout");
    return c;
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

export type SaleLineInput = {
  partId?: string | null;
  repairJobId?: string | null;
  pickedUp?: boolean;
  description: string;
  qty: number;
  unitPriceCents: number;
  discountCents?: number;
  taxable: boolean;
  /** Vac Shop: the customer's vacuum this bag, belt or filter is for; a unit sold from stock; a trade-in taken as credit. */
  machineId?: string | null;
  stockUnitId?: string | null;
  tradeIn?: TradeInInput | null;
};

export type SaleInput = {
  customerId?: string | null;
  lines: SaleLineInput[];
  orderDiscountCents?: number;
  tenders: Tender[];
  note?: string | null;
  /** The register's own name for this sale, the same on every try: a sale sent again isn't made twice. */
  clientKey?: string | null;
};

// $100,000 in cents: far above any real line, payment or sale, and well inside what the books' whole numbers hold.
const MAX_MONEY = 10_000_000;

/** The sale already made under this key, if any. */
function saleByKey(shopId: string, clientKey: string | null) {
  return clientKey ? db.sale.findUnique({ where: { shopId_clientKey: { shopId, clientKey } }, select: { id: true, number: true, changeCents: true } }) : null;
}

export async function completeSale(input: SaleInput): Promise<{ saleId: string; number: number; changeCents: number } | { error: string }> {
  try {
    const user = await requireUser();
    const shopId = user.shopId;
    // Sent again after the answer to the first try was lost (a dropped connection): that sale, not a second one.
    const clientKey = typeof input.clientKey === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(input.clientKey) ? input.clientKey : null;
    const made = await saleByKey(shopId, clientKey);
    if (made) return { saleId: made.id, number: made.number, changeCents: made.changeCents };
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
    if (!input.lines.length) throw new UserError("Nothing to sell yet. Scan or search for an item.");
    if (input.lines.length > 300) throw new UserError("That's too many lines for one sale.");
    const rawTenders = Array.isArray(input.tenders) ? input.tenders : [];
    if (rawTenders.length > 20) throw new UserError("That's too many payments for one sale.");

    // Every item must be this shop's; repairs must be this shop's unpaid partner jobs.
    const partIds = [...new Set(input.lines.map((l) => l.partId).filter(Boolean) as string[])];
    const parts = new Map((await db.part.findMany({ where: { shopId, id: { in: partIds } } })).map((p) => [p.id, p]));
    if (parts.size !== partIds.length) throw new UserError("An item on this sale isn't in your inventory any more. Remove it and scan it again.");
    const jobIds = [...new Set(input.lines.map((l) => l.repairJobId).filter(Boolean) as string[])];
    const jobs = new Map(
      (await db.repairJob.findMany({ where: { shopId, side: "retail", id: { in: jobIds } } })).map((j) => [j.id, j]),
    );
    for (const id of jobIds) {
      const j = jobs.get(id);
      if (!j) throw new UserError("That repair isn't one of this shop's.");
      // Paid, unless the bill went up after it was paid here: then the rest is paid the same way.
      if (j.paidAt && repairDue(j) <= 0) throw new UserError(`Repair tag ${j.tag} is already paid.`);
    }
    // A supply bought for a customer's vacuum names one of this shop's vacuums.
    const machineIds = [...new Set(input.lines.map((l) => l.machineId).filter(Boolean) as string[])];
    if (machineIds.length && (await db.machine.count({ where: { shopId, id: { in: machineIds }, equipment: "VACUUM" } })) !== machineIds.length) {
      throw new UserError("That vacuum isn't one of this shop's.");
    }
    if (input.customerId && !(await db.customer.findFirst({ where: { id: input.customerId, shopId } }))) throw new UserError("Customer not found.");
    // Vacuums sold from stock and trade-ins, checked and worded by the Vac Shop (by line index).
    const units = await prepareUnitLines({
      shopId,
      role: user.role,
      customerId: input.customerId ?? null,
      lines: input.lines.map((l) => ({ stockUnitId: l.stockUnitId ?? null, tradeIn: l.tradeIn ?? null, qty: Number(l.qty), unitPriceCents: Math.round(Number(l.unitPriceCents)), taxable: Boolean(l.taxable) })),
    });

    const lines = input.lines.map((l, i) => {
      if ((l.stockUnitId || l.tradeIn) && (l.partId || l.repairJobId)) throw new UserError("A line can only be one thing.");
      const unitLine = units.get(i);
      if (unitLine) {
        const total = Math.abs(roundCents(unitLine.qty * unitLine.unitPriceCents));
        if (unitLine.unitPriceCents > MAX_MONEY || total > MAX_MONEY) throw new UserError(`${unitLine.description} comes to more than $100,000. Check the price.`);
        let disc = Math.max(0, Math.round(Number(l.discountCents ?? 0)));
        if (user.role === "TECH" && disc) throw new UserError("Only an owner or admin can give a discount.");
        disc = unitLine.discountable ? Math.min(disc, total) : 0;
        return {
          partId: null,
          repairJobId: null,
          pickedUp: false,
          description: unitLine.description.slice(0, 200),
          partNumber: null,
          qty: unitLine.qty,
          unit: null,
          unitPriceCents: unitLine.unitPriceCents,
          discountCents: disc,
          taxable: unitLine.taxable,
          discountable: unitLine.discountable,
          costCents: unitLine.costCents,
          consignLinkId: null,
          consignItemKey: null,
          machineId: null,
          stockUnitId: unitLine.stockUnitId,
          tradeIn: l.tradeIn ?? null,
        };
      }
      const part = l.partId ? parts.get(l.partId)! : null;
      const job = l.repairJobId ? jobs.get(l.repairJobId)! : null;
      let qty = Number(l.qty);
      // Fabric is cut in eighths, and an eighth is exact in binary: counts and sums never drift, and the repair shop
      // (which rounds to thousandths) records the same number. Anything that is not an eighth is refused below.
      if (part?.unit === "yd" && Number.isFinite(qty) && inEighths(qty)) qty = Math.round(qty * 8) / 8;
      if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > 10000) throw new UserError("Each line needs a quantity.");
      let unit = Math.round(Number(l.unitPriceCents));
      if (!Number.isFinite(unit) || unit < 0) throw new UserError("Prices can't be negative. For a return, use Return mode (negative quantity).");
      let disc = Math.max(0, Math.round(Number(l.discountCents ?? 0)));
      if (job) {
        if (qty !== 1) throw new UserError("A repair is one line of 1.");
        if (disc) throw new UserError("A repair is paid as the repair shop billed it; it can't be discounted here.");
        // The balance as we know it now, not what the page had when it was opened.
        unit = repairDue(job);
        if (unit <= 0) throw new UserError(`Repair tag ${job.tag} has nothing left to pay.`);
        // The machine goes home only if the repair shop has sent it back (the pickup list may be out of date).
        if (l.pickedUp !== false && !job.pickedUpAt && !BACK_FROM_REPAIR.includes(job.status)) {
          throw new UserError(`Repair tag ${job.tag} isn't back from the repair shop yet. Untick "taking the machine home" to take the payment only.`);
        }
      }
      if (part) {
        if (part.unit !== "yd" && !Number.isInteger(qty)) throw new UserError(`${part.partNumber} is sold each: use a whole number.`);
        if (part.unit === "yd" && !inEighths(qty)) throw new UserError(`Check the yardage of ${part.partNumber}: fabric is cut in eighths of a yard (2 3/8 is 2.375).`);
        if (user.role === "TECH" && part.priceCents != null && unit !== part.priceCents) throw new UserError(`Only an owner or admin can change the price of ${part.partNumber}.`);
        // A tech can type the price of an item that has none, but not leave it free.
        if (user.role === "TECH" && part.priceCents == null && unit === 0) throw new UserError(`${part.partNumber} has no price yet. Type the price on the line.`);
      }
      // A discount is a price change too.
      if (user.role === "TECH" && disc) throw new UserError("Only an owner or admin can give a discount.");
      if (unit > MAX_MONEY || Math.abs(qty * unit) > MAX_MONEY) {
        throw new UserError(`${part?.partNumber ?? (l.description || "A line")} comes to more than $100,000. Check the price and quantity.`);
      }
      // A discount can take a line to zero, never below.
      disc = Math.min(disc, Math.abs(roundCents(qty * unit)));
      const text = (l.description || part?.description || "Item").slice(0, 200);
      return {
        partId: part?.id ?? null,
        repairJobId: job?.id ?? null,
        pickedUp: l.pickedUp !== false,
        // A used, refurbished, compatible or 3D printed item says so on the receipt: written now, so the receipt stays
        // right if the item is changed later.
        description: part ? withDisclosure(text, part) : text,
        partNumber: part?.partNumber ?? null,
        qty,
        unit: part?.unit ?? null,
        unitPriceCents: unit,
        discountCents: disc,
        // The server has no tax setting per item, so stocked items are always taxed; the browser's flag counts for a misc line only.
        taxable: job ? false : part ? true : Boolean(l.taxable),
        discountable: !job,
        costCents: part?.costCents ?? null,
        consignLinkId: part?.consignLinkId ?? null,
        consignItemKey: part?.consignItemKey ?? null,
        machineId: l.machineId ?? null,
        stockUnitId: null,
        tradeIn: null,
      };
    });

    const tenders = rawTenders
      .map((t) => ({
        method: TENDER_METHODS.includes(t?.method) ? t.method : "OTHER",
        amountCents: Math.round(Number(t?.amountCents) || 0),
        note: typeof t?.note === "string" ? t.note.slice(0, 100) || null : null,
      }))
      .filter((t) => t.amountCents !== 0);
    if (tenders.some((t) => Math.abs(t.amountCents) > MAX_MONEY)) throw new UserError("A payment can't be more than $100,000. Check the amount.");
    const orderDiscountCents = Math.max(0, Math.round(Number(input.orderDiscountCents) || 0));
    if (user.role === "TECH" && orderDiscountCents) throw new UserError("Only an owner or admin can give a discount.");
    const totals = saleTotals(lines, orderDiscountCents, shop.taxRatePct, tenders);
    if (Math.abs(totals.subtotal) > MAX_MONEY) throw new UserError("A sale can't be more than $100,000. Check the prices and quantities.");
    const problem = tenderProblem(totals, tenders);
    if (problem) throw new UserError(problem);
    // Each line's share of the whole-sale discount as the tax was worked out (what a vacuum really sold for).
    const shares = discountShares(lines, totals.orderDiscount);

    // The sewing shop's share of consigned sales, as the partnership stands today (kept with each sale).
    const consignShares = new Map<string, number>();
    for (const linkId of new Set(lines.map((l) => l.consignLinkId).filter(Boolean) as string[])) {
      const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: linkId } }, select: { terms: true } });
      consignShares.set(linkId, normalizeTerms(link?.terms).consignSharePct);
    }

    // Each line's part of the whole-sale discount, adding up to it exactly (what a consigned item really sold for).
    const orderShares = orderDiscountShares(lines, totals.orderDiscount);

    const at = new Date();
    const sale = await db.$transaction(async (tx) => {
      const sh = await tx.shop.update({ where: { id: shopId }, data: { nextSaleNumber: { increment: 1 } }, select: { nextSaleNumber: true } });
      const number = sh.nextSaleNumber - 1;
      const sale = await tx.sale.create({
        data: {
          shopId,
          number,
          customerId: input.customerId || null,
          userId: user.id,
          subtotalCents: totals.subtotal,
          discountCents: totals.orderDiscount,
          taxCents: totals.tax,
          totalCents: totals.total,
          taxRatePct: shop.taxRatePct,
          tenders: tenders as Prisma.InputJsonValue,
          changeCents: totals.change,
          note: input.note?.slice(0, 500) || null,
          clientKey,
          createdAt: at,
        },
      });
      for (const [i, l] of lines.entries()) {
        // tradeIn isn't a column: the Vac Shop makes the trade-in's own rows and sets tradeInUnitId on the line.
        const { pickedUp, discountable, tradeIn, ...row } = l;
        void discountable;
        const line = await tx.saleLine.create({ data: { saleId: sale.id, ...row } });
        if (l.stockUnitId || tradeIn) {
          await applyUnitLine(tx, { shopId, saleNumber: number, customerId: input.customerId || null, at, timeZone: shop.timeZone, line, tradeIn, discountShareCents: shares[i] });
        }
        if (l.partId) {
          await tx.part.update({ where: { id: l.partId }, data: { qtyOnHand: { decrement: l.qty } } });
          await tx.stockMove.create({
            data: { shopId, partId: l.partId, qty: -l.qty, reason: "SOLD", userId: user.id, note: `Sale #${number}`, createdAt: at },
          });
        }
        if (l.consignLinkId && l.consignItemKey) {
          // Consigned stock: the owner hears about every sale; the net price after the line discount and the line's part
          // of any whole-sale discount is what counts.
          const net = Math.round((lineNet(l) - orderShares[i]) / l.qty);
          const gross = Math.round(l.qty * net);
          await tx.consignSale.create({
            data: {
              id: line.id,
              shopId,
              linkId: l.consignLinkId,
              itemKey: l.consignItemKey,
              qty: l.qty,
              priceCents: net,
              saleNumber: number,
              soldAt: at,
              shopKeepsCents: Math.round((gross * (consignShares.get(l.consignLinkId) ?? 0)) / 100),
            },
          });
          // A sale sells only what is still on the shelf and a return takes back only what was sold (the repair shop
          // applies the same rules, so both books agree). Quantities are floats: a millionth of slack.
          const key = { shopId, linkId: l.consignLinkId, itemKey: l.consignItemKey };
          if (l.qty > 0) {
            const item = await tx.consignItem.findUnique({ where: { shopId_linkId_itemKey: key } });
            const onShelf = item ? item.placed - item.sold - item.returned : 0;
            if (!item || l.qty > onShelf + 1e-6) {
              throw new UserError(`${l.description}: ${onShelf > 1e-6 ? `only ${qtyText(onShelf, l.unit)}` : "none"} left on the shelf on consignment.`);
            }
            // Only if nobody sold it meanwhile (another register).
            const took = await tx.consignItem.updateMany({ where: { id: item.id, sold: item.sold }, data: { sold: { increment: l.qty } } });
            if (!took.count) throw new UserError(`${l.description} was just sold at another register. Ring it up again.`);
          } else {
            const took = await tx.consignItem.updateMany({ where: { ...key, sold: { gte: -l.qty - 1e-6 } }, data: { sold: { increment: l.qty } } });
            if (!took.count) throw new UserError(`More of ${l.description} is being returned than was sold on consignment.`);
          }
          await sendToPartner(shopId, l.consignLinkId, "consign.sale", { id: line.id, itemKey: l.consignItemKey, qty: l.qty, priceCents: net, saleNumber: number, at: at.toISOString() }, tx, false);
        }
        if (l.repairJobId) {
          const job = jobs.get(l.repairJobId)!;
          const amount = lineNet(l);
          // Adds to anything paid here before (the rest of a bill that went up after it was paid).
          const paidHere = (job.paidCents ?? 0) + amount;
          // A machine already handed over isn't handed over again.
          const handOver = pickedUp && !job.pickedUpAt;
          const events = [...((job.events as { at: string; note?: string; status?: string }[]) ?? []), { at: at.toISOString(), note: `Paid $${(amount / 100).toFixed(2)} at the counter, sale #${number}` }].slice(-200);
          // Only if nobody paid it and the bill didn't change meanwhile (another register, a second click, an update).
          const paid = await tx.repairJob.updateMany({
            where: { shopId, id: job.id, paidCents: job.paidCents, repairPaidCents: job.repairPaidCents, totalCents: job.totalCents, ...(handOver ? { status: job.status } : {}) },
            data: {
              paidCents: paidHere,
              paidAt: job.paidAt ?? at,
              paidWhere: job.repairPaidCents ? "split" : "shop",
              // A machine sent back unrepaired stays that way in the record (as on the repair shop's side).
              ...(handOver ? { pickedUpAt: at, status: job.status === "RETURNED_UNREPAIRED" ? job.status : "COLLECTED" } : {}),
              events: (handOver ? [...events, { at: at.toISOString(), status: "COLLECTED" }] : events) as Prisma.InputJsonValue,
            },
          });
          if (!paid.count) throw new UserError(`Repair tag ${job.tag} was just paid, or its bill or status changed. Take it off this sale and add it again.`);
          // amountCents is this payment; paidCents is everything paid here so far (a repeat of a message adds nothing).
          await sendToPartner(shopId, job.linkId, "job.paid", { id: job.id, amountCents: amount, paidCents: paidHere, saleNumber: number, at: at.toISOString() }, tx, false);
          if (handOver) await sendToPartner(shopId, job.linkId, "job.pickedup", { id: job.id, at: at.toISOString() }, tx, false);
        }
      }
      return sale;
    }).catch(async (e: unknown) => {
      // The same sale sent twice at once: the other try made it.
      const made = (e as { code?: string })?.code === "P2002" ? await saleByKey(shopId, clientKey) : null;
      if (made) return made;
      throw e;
    });
    revalidatePath("/register", "layout");
    revalidatePath("/repairs", "layout");
    revalidatePath("/parts", "layout");
    revalidatePath("/vac", "layout");
    return { saleId: sale.id, number: sale.number, changeCents: sale.changeCents };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

/** Undo a sale that was rung up by mistake: stock goes back, consigned sales are reversed with the owner. */
export const voidSale = safe(async function voidSale(saleId: string, formData: FormData) {
  const user = await requireAdmin();
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200);
  const shopId = user.shopId;
  const sale = await db.sale.findFirst({ where: { id: saleId, shopId }, include: { lines: true } });
  if (!sale) throw new UserError("Sale not found.");
  if (sale.status === "VOIDED") throw new UserError("That sale is already void.");
  if (sale.lines.some((l) => l.repairJobId)) {
    throw new UserError("This sale paid for a repair. Ring up a return for the items instead, and sort the repair payment out with the repair shop.");
  }
  const at = new Date();
  await db.$transaction(async (tx) => {
    // Only a sale that is still complete (two voids at once must not put the stock back twice).
    const done = await tx.sale.updateMany({
      where: { id: sale.id, shopId, status: "COMPLETED" },
      data: { status: "VOIDED", voidedAt: at, note: [sale.note, `Void: ${reason || "no reason given"} (${user.name})`].filter(Boolean).join("\n") },
    });
    if (!done.count) throw new UserError("That sale is already void.");
    // Vacuums sold go back in stock; trade-ins taken come back out (Vac Shop).
    await voidUnitLines(tx, { shopId, saleNumber: sale.number, customerId: sale.customerId, lines: sale.lines, at });
    for (const l of sale.lines) {
      if (l.partId) {
        const part = await tx.part.findFirst({ where: { id: l.partId, shopId } });
        if (part) {
          await tx.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: l.qty } } });
          await tx.stockMove.create({ data: { shopId, partId: part.id, qty: l.qty, reason: "SOLD", userId: user.id, note: `Sale #${sale.number} void`, createdAt: at } });
        }
      }
      if (l.consignLinkId && l.consignItemKey) {
        const id = `${l.id}-void`;
        const original = await tx.consignSale.findUnique({ where: { shopId_id: { shopId, id: l.id } }, select: { priceCents: true, shopKeepsCents: true } });
        // Undone at the price it was paid out at (after any whole-sale discount).
        const net = original?.priceCents ?? Math.round(lineNet(l) / l.qty);
        await tx.consignSale.create({
          data: { id, shopId, linkId: l.consignLinkId, itemKey: l.consignItemKey, qty: -l.qty, priceCents: net, saleNumber: sale.number, soldAt: at, shopKeepsCents: original?.shopKeepsCents != null ? -original.shopKeepsCents : null },
        });
        const undone = await tx.consignItem.updateMany({
          where: { shopId, linkId: l.consignLinkId, itemKey: l.consignItemKey, ...(l.qty > 0 ? { sold: { gte: l.qty - 1e-6 } } : {}) },
          data: { sold: { decrement: l.qty } },
        });
        if (!undone.count) throw new UserError(`${l.description} was returned since this sale; void that return first.`);
        await sendToPartner(shopId, l.consignLinkId, "consign.sale", { id, itemKey: l.consignItemKey, qty: -l.qty, priceCents: net, saleNumber: sale.number, at: at.toISOString() }, tx, false);
      }
    }
  });
  revalidatePath("/register", "layout");
  revalidatePath("/parts", "layout");
  revalidatePath("/vac", "layout");
});
