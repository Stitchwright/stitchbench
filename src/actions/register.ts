"use server";

// The sewing / quilt shop's register: ring up notions, fabric by the yard, consigned stock and repair pickups.
// Cards are run on the shop's own card terminal; the register records how each sale was paid.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError, isUserError } from "@/lib/action";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireAdmin, requireUser } from "@/lib/session";
import { codeKeys, numberKey } from "@/lib/parts";
import { sameText } from "@/lib/input";
import { lineNet, type Tender } from "@/lib/register-math";
import type { Issued } from "@/lib/gift-card-number";
import { returnSkip, splitForReturn } from "@/lib/sale-return";
import { registerUnitHits } from "@/lib/units/sale-units";
import { FIRST_PHOTO, viewItem, type RegisterItem } from "@/lib/register-item";
import { shopTimeZone } from "@/lib/shop-zone";
import { BACK_FROM_REPAIR, bookingsDueFor, completeSaleAs, repairDue, voidSaleAs, type SaleInput } from "@/lib/register-sale";
import { refuseVoidOfOnlineSale } from "@/lib/shop/online-shop";
import { exemptCertificate } from "@/lib/tax-exempt";
import { customerIdsBySpelling } from "@/lib/customer-search";
import type { BookingDue } from "@/lib/booking-types";
import { findColorsFor } from "@/lib/colors";

// RegisterItem and the Part -> item mapping live in src/lib/register-item.ts: a "use server" file may export only async
// functions (even a type re-export trips the bundler), and the machines-for-sale hooks (src/lib/units/sale-units.ts) build items too.
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
    where: { shopId: user.shopId, kind: { not: "MACHINE" }, OR: [{ partNumber: sameText(c) }, ...(keys.length ? [{ numberKeys: { hasSome: keys } }] : [])] },
    take: 20,
    include: FIRST_PHOTO,
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
  // No part by that number: a machine for sale whose serial it is.
  return matches[0] ? view(matches[0]) : ((await registerUnitHits({ shopId: user.shopId, q: c, mode: "code" }))[0] ?? null);
}

/**
 * Items whose number or description matches, for the search box. A maker and color number in any shape ("isa 15",
 * "Aurifil 2024"), a color name or a supply in words ("PLA black 1.75") finds items by their details too
 * (shop-features-round-2-design.md 2.2): those come first.
 */
export async function findItems(q: string): Promise<RegisterItem[]> {
  const user = await requireUser();
  const t = q.trim();
  if (t.length < 2) return [];
  const words = t.split(/\s+/).slice(0, 5);
  const [parts, colors] = await Promise.all([
    db.part.findMany({
      where: {
        shopId: user.shopId,
        kind: { not: "MACHINE" },
        OR: [{ partNumber: { contains: t, mode: "insensitive" } }, { numberKeys: { has: numberKey(t) } }, { AND: words.map((w) => ({ description: { contains: w, mode: "insensitive" as const } })) }],
      },
      orderBy: [{ qtyOnHand: "desc" }, { description: "asc" }],
      take: 25,
      include: FIRST_PHOTO,
    }),
    findColorsFor(user.shopId, t, 15),
  ]);
  const seen = new Set<string>();
  const items = [...colors.map(({ location, sameAs, boughtAt, boughtText, ...it }) => (void location, void sameAs, void boughtAt, void boughtText, it)), ...parts.map(view)].filter((it) => !seen.has(it.id) && seen.add(it.id)).slice(0, 30);
  // Machines for sale whose brand or model matches come after the parts.
  return [...items, ...(await registerUnitHits({ shopId: user.shopId, q: t, mode: "search" }))];
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

function toPickupJob(j: {
  id: string;
  tag: string;
  customerName: string;
  brand: string;
  model: string;
  paidCents: number | null;
  pickedUpAt: Date | null;
  status: string;
  customerId: string | null;
  totalCents: number | null;
  repairPaidCents: number | null;
}): PickupJob {
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
  /** The rate the sale charged (0 when it was tax exempt): a return of it gives the tax back at this rate. */
  taxRatePct: number;
  customer: CustomerHit | null;
  lines: SaleReturnLine[];
  /** Payment lines for a repair bill, left out: reverse those with the repair shop instead (same as voiding a sale). */
  skippedRepairLines: number;
  /** Gift cards sold, loaded or paid out on it, left out: a card's money comes back through the card itself (void the
   * sale, or pay the card out), never as a plain refund line that would leave the card spendable. */
  skippedCardLines: number;
  /** Class seats and appointments, left out: refund them through "Return an item" > Classes & appointments, which
   * settles the booking with the money. */
  skippedBookingLines: number;
  /** Machines sold from stock, their service plans and trade-ins, left out: through "Return an item" > Return a machine,
   * which takes the unit back (and ends its plans) with the money. */
  skippedUnitLines: number;
  /** Layaway payments and cancel fees, left out: settled on the layaway itself. */
  skippedLayawayLines: number;
  /** Gift cards and store credit the sale was paid with: the default way back is onto the same card. */
  cardsPaid: { number: string; kind: "gift" | "credit"; amountCents: number }[];
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
    include: { lines: true, customer: { select: { id: true, name: true, phone: true, taxExemptId: true, taxExemptUntil: true } } },
  });
  if (!sale) return null;
  const lines: SaleReturnLine[] = [];
  const skipped = { repair: 0, card: 0, booking: 0, unit: 0, layaway: 0 };
  for (const l of sale.lines) {
    const skip = returnSkip(l);
    if (skip) {
      skipped[skip]++;
      continue;
    }
    // What the line actually charged (its own discount folded in), split into whole-cent unit prices that refund
    // exactly that amount: one line, or two when the charge doesn't divide evenly among the units (splitForReturn).
    const net = lineNet({ qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents, taxable: l.taxable });
    for (const part of splitForReturn(l.qty, net)) {
      lines.push({ partId: l.partId, description: l.description, partNumber: l.partNumber, unit: l.unit, qty: part.qty, unitPriceCents: part.unitPriceCents, taxable: l.taxable });
    }
  }
  const paid = (sale.tenders as Tender[]).filter((t) => t.cardId && t.amountCents > 0);
  const cards = paid.length ? await db.giftCard.findMany({ where: { shopId: user.shopId, id: { in: paid.map((t) => t.cardId!) } }, select: { id: true, number: true, kind: true } }) : [];
  const cardsPaid = paid.flatMap((t) => {
    const c = cards.find((x) => x.id === t.cardId);
    return c ? [{ number: c.number, kind: c.kind as "gift" | "credit", amountCents: t.amountCents }] : [];
  });
  return { id: sale.id, number: sale.number, taxRatePct: sale.taxRatePct, customer: sale.customer ? hitOf(sale.customer) : null, lines, skippedRepairLines: skipped.repair, skippedCardLines: skipped.card, skippedBookingLines: skipped.booking, skippedUnitLines: skipped.unit, skippedLayawayLines: skipped.layaway, cardsPaid };
}

/** `taxExemptId`: the certificate number when the customer is tax exempt now (null: not; absent: not looked up yet). */
export type CustomerHit = { id: string; name: string; phone: string | null; taxExemptId?: string | null };

const hitOf = (c: { id: string; name: string; phone: string | null; taxExemptId: string | null; taxExemptUntil: Date | null }): CustomerHit => ({ id: c.id, name: c.name, phone: c.phone, taxExemptId: exemptCertificate(c) });

/** Whether a customer of this shop is tax exempt now: the register looks it up for a customer it was handed without it. */
export async function customerTaxExempt(customerId: string): Promise<string | null> {
  const user = await requireUser();
  const c = await db.customer.findFirst({ where: { id: String(customerId), shopId: user.shopId }, select: { taxExemptId: true, taxExemptUntil: true } });
  return exemptCertificate(c);
}

export async function findCustomers(q: string): Promise<CustomerHit[]> {
  const user = await requireUser();
  const t = q.trim();
  if (t.length < 2) return [];
  const digits = t.replace(/\D/g, "");
  const rows = await db.customer.findMany({
    where: {
      shopId: user.shopId,
      kind: "RETAIL",
      OR: [{ name: { contains: t, mode: "insensitive" } }, ...(digits.length >= 4 ? [{ phone: { contains: digits.slice(-4) } }] : []), { email: { contains: t, mode: "insensitive" } }],
    },
    select: { id: true, name: true, phone: true, taxExemptId: true, taxExemptUntil: true },
    orderBy: { name: "asc" },
    take: 10,
  });
  if (rows.length) return rows.map(hitOf);
  // Nothing as typed: a near spelling ("dorthy" finds Dorothy).
  const near = await customerIdsBySpelling(user.shopId, t, { retailOnly: true, take: 10 });
  if (!near.length) return [];
  const nearRows = await db.customer.findMany({
    where: { shopId: user.shopId, id: { in: near } },
    select: { id: true, name: true, phone: true, taxExemptId: true, taxExemptUntil: true },
    orderBy: { name: "asc" },
  });
  return nearRows.map(hitOf);
}

/**
 * A customer added from the register (name, phone, email, address) without leaving the sale: the sale is then rung up
 * under them. Returns the same shape the customer search gives, so the register picks it straight away.
 */
export async function quickAddCustomer(fd: FormData): Promise<CustomerHit | { error: string }> {
  try {
    const user = await requireUser();
    await requireBaseWritable(user); // a new record: refused while the program is read-only
    const text = (k: string) => String(fd.get(k) ?? "").trim();
    const name = text("name").slice(0, 120);
    const phone = text("phone").slice(0, 40) || null;
    const email = text("email").slice(0, 120) || null;
    const address = text("address").slice(0, 300) || null;
    if (!name || (!phone && !email)) throw new UserError("Enter a name and a phone or email.");
    const c = await db.customer.create({ data: { shopId: user.shopId, kind: "RETAIL", name, phone, email, address }, select: { id: true, name: true, phone: true } });
    revalidatePath("/customers", "layout");
    return { ...c, taxExemptId: null };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

export async function completeSale(input: SaleInput): Promise<{ saleId: string; number: number; changeCents: number; cards?: Issued[] } | { error: string }> {
  try {
    const user = await requireUser();
    // A given tax amount and the ONLINE tender belong to the online shop's payment path, never to the counter.
    const { taxCents: _given, ...counter } = input;
    void _given;
    if (Array.isArray(counter.tenders) && counter.tenders.some((t) => t?.method === "ONLINE")) return { error: '"Paid online" is written by the online shop only. Pick how the customer paid.' };
    const r = await completeSaleAs(user, counter);
    revalidatePath("/register", "layout");
    revalidatePath("/repairs", "layout");
    revalidatePath("/parts", "layout");
    revalidatePath("/vac", "layout");
    revalidatePath("/classes", "layout");
    revalidatePath("/calendar", "layout");
    return r;
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

/** Undo a sale that was rung up by mistake: stock goes back, consigned sales are reversed with the owner. */
export const voidSale = safe.whileLapsed("voidSale")(async function voidSale(saleId: string, formData: FormData) {
  const user = await requireAdmin();
  await refuseVoidOfOnlineSale(user.shopId, saleId);
  await voidSaleAs(
    user,
    saleId,
    String(formData.get("reason") ?? "")
      .trim()
      .slice(0, 200),
  );
  revalidatePath("/register", "layout");
  revalidatePath("/parts", "layout");
  revalidatePath("/vac", "layout");
  revalidatePath("/classes", "layout");
  revalidatePath("/calendar", "layout");
});

/** Class seats and appointments owed (or, in return mode, paid and refundable), for the register's picker. */
export async function bookingsDue(customerId?: string | null, refunds = false): Promise<BookingDue[]> {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  return bookingsDueFor(user.shopId, tz, customerId && /^[a-z0-9]{20,40}$/i.test(customerId) ? customerId : null, refunds);
}
