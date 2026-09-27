"use server";

// The sewing / quilt shop's register: ring up notions, fabric by the yard, consigned stock and repair pickups.
// Cards are run on the shop's own card terminal; the register records how each sale was paid.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError, isUserError } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { numberKey } from "@/lib/parts";
import { sendToPartner } from "@/lib/partners";
import { normalizeTerms } from "@/lib/partner-terms";
import { lineNet, orderDiscountShares, saleTotals, TENDER_METHODS, type Tender } from "@/lib/register-math";
import type { Prisma } from "@/generated/prisma/client";

export type RegisterItem = {
  id: string;
  partNumber: string;
  description: string;
  priceCents: number | null;
  unit: string | null;
  qtyOnHand: number;
  kind: string;
  consigned: boolean;
};

const view = (p: {
  id: string;
  partNumber: string;
  description: string;
  priceCents: number | null;
  unit: string | null;
  qtyOnHand: number;
  kind: string;
  consignLinkId: string | null;
}): RegisterItem => ({
  id: p.id,
  partNumber: p.partNumber,
  description: p.description,
  priceCents: p.priceCents,
  unit: p.unit,
  qtyOnHand: p.qtyOnHand,
  kind: p.kind,
  consigned: Boolean(p.consignLinkId),
});

/**
 * A scanned barcode or typed number: the item, or null. When the shop stocks the number itself and also holds a
 * partner's consigned stock of it, its own stock sells first; consigned stock sells once its own runs out.
 */
export async function itemByCode(code: string): Promise<RegisterItem | null> {
  const user = await requireUser();
  const c = code.trim();
  if (!c) return null;
  const key = numberKey(c);
  const matches = await db.part.findMany({
    where: { shopId: user.shopId, OR: [{ partNumber: { equals: c, mode: "insensitive" } }, ...(key.length >= 3 ? [{ numberKeys: { has: key } }] : [])] },
    take: 20,
  });
  const exact = (p: { partNumber: string }) => p.partNumber.toLowerCase() === c.toLowerCase();
  const rank = (p: (typeof matches)[number]) => (p.qtyOnHand > 0 ? 0 : 4) + (p.consignLinkId ? 2 : 0) + (exact(p) ? 0 : 1);
  matches.sort((a, b) => rank(a) - rank(b));
  return matches[0] ? view(matches[0]) : null;
}

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
  return parts.map(view);
}

export type PickupJob = { id: string; tag: string; customerName: string; machine: string; dueCents: number; status: string; customerId: string | null };

/** Repairs back from the partner repair shop and not paid for yet: the customer pays for them at the register. */
export async function pickupJobs(): Promise<PickupJob[]> {
  const user = await requireUser();
  const jobs = await db.repairJob.findMany({
    where: { shopId: user.shopId, side: "retail", paidAt: null, totalCents: { not: null }, status: { in: ["READY_IN_TRUCK", "READY_FOR_PICKUP", "RETURNED_UNREPAIRED"] } },
    orderBy: { updatedAt: "desc" },
  });
  return jobs
    .map((j) => ({
      id: j.id,
      tag: j.tag,
      customerName: j.customerName,
      machine: `${j.brand} ${j.model}`,
      dueCents: repairDue(j),
      status: j.status,
      customerId: j.customerId,
    }))
    .filter((j) => j.dueCents > 0);
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

export type SaleLineInput = {
  partId?: string | null;
  repairJobId?: string | null;
  pickedUp?: boolean;
  description: string;
  qty: number;
  unitPriceCents: number;
  discountCents?: number;
  taxable: boolean;
};

export type SaleInput = {
  customerId?: string | null;
  lines: SaleLineInput[];
  orderDiscountCents?: number;
  tenders: Tender[];
  note?: string | null;
};

export async function completeSale(input: SaleInput): Promise<{ saleId: string; number: number; changeCents: number } | { error: string }> {
  try {
    const user = await requireUser();
    const shopId = user.shopId;
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
    if (!input.lines.length) throw new UserError("Nothing to sell yet. Scan or search for an item.");
    if (input.lines.length > 300) throw new UserError("That's too many lines for one sale.");

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
      if (j.paidAt) throw new UserError(`Repair tag ${j.tag} is already paid.`);
    }
    if (input.customerId && !(await db.customer.findFirst({ where: { id: input.customerId, shopId } }))) throw new UserError("Customer not found.");

    // Prices and discounts are the owner's call: a tech rings items up as they're priced, with no money off.
    const tech = user.role === "TECH";
    const lines = input.lines.map((l) => {
      const qty = Number(l.qty);
      if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > 10000) throw new UserError("Each line needs a quantity.");
      let unit = Math.round(Number(l.unitPriceCents));
      if (!Number.isFinite(unit) || unit < 0) throw new UserError("Prices can't be negative. For a return, use Return mode (negative quantity).");
      let disc = Math.max(0, Math.round(Number(l.discountCents ?? 0)));
      if (tech && disc > 0) throw new UserError("Only an owner or admin can discount a line.");
      const part = l.partId ? parts.get(l.partId)! : null;
      const job = l.repairJobId ? jobs.get(l.repairJobId)! : null;
      if (job) {
        if (qty !== 1) throw new UserError("A repair is one line of 1.");
        if (disc) throw new UserError("A repair is paid as the repair shop billed it; it can't be discounted here.");
        // The balance as we know it now, not what the page had when it was opened.
        unit = repairDue(job);
        if (unit <= 0) throw new UserError(`Repair tag ${job.tag} has nothing left to pay.`);
      }
      if (part) {
        if (part.unit !== "yd" && !Number.isInteger(qty)) throw new UserError(`${part.partNumber} is sold each: use a whole number.`);
        if (tech && part.priceCents != null && unit !== part.priceCents) throw new UserError(`Only an owner or admin can change the price of ${part.partNumber}.`);
        // An item nobody has priced yet is priced on the line, not given away.
        if (tech && part.priceCents == null && unit === 0) throw new UserError(`${part.partNumber} has no price yet. Type the price on the line.`);
      } else if (tech && !job && qty < 0) {
        // A misc refund pays out cash for something that was never in stock: an owner or admin does that.
        throw new UserError("Only an owner or admin can refund a misc item.");
      }
      // A discount can take a line to zero, never below.
      disc = Math.min(disc, Math.abs(Math.round(qty * unit)));
      return {
        partId: part?.id ?? null,
        repairJobId: job?.id ?? null,
        pickedUp: l.pickedUp !== false,
        description: (l.description || part?.description || "Item").slice(0, 200),
        partNumber: part?.partNumber ?? null,
        qty,
        unit: part?.unit ?? null,
        unitPriceCents: unit,
        discountCents: disc,
        taxable: job ? false : Boolean(l.taxable),
        discountable: !job,
        costCents: part?.costCents ?? null,
        consignLinkId: part?.consignLinkId ?? null,
        consignItemKey: part?.consignItemKey ?? null,
      };
    });

    const tenders = (input.tenders ?? [])
      .map((t) => ({ method: TENDER_METHODS.includes(t.method) ? t.method : "OTHER", amountCents: Math.round(Number(t.amountCents) || 0), note: t.note?.slice(0, 100) || null }))
      .filter((t) => t.amountCents !== 0);
    const orderDiscountCents = Math.max(0, Math.round(Number(input.orderDiscountCents) || 0));
    if (tech && orderDiscountCents > 0) throw new UserError("Only an owner or admin can discount the sale.");
    const totals = saleTotals(lines, orderDiscountCents, shop.taxRatePct, tenders);
    // Each line's share of the whole-sale discount, so a consigned item is reported at the price it really fetched.
    const offEachLine = orderDiscountShares(lines, orderDiscountCents);
    if (totals.total >= 0 && totals.paid < totals.total) throw new UserError(`Still due: $${((totals.total - totals.paid) / 100).toFixed(2)}.`);
    if (totals.total < 0 && totals.paid !== totals.total) throw new UserError(`Refund the full $${(-totals.total / 100).toFixed(2)} (a negative payment).`);
    if (tenders.some((t) => (totals.total >= 0 ? t.amountCents < 0 : t.amountCents > 0))) throw new UserError(totals.total >= 0 ? "Payments are positive amounts on a sale." : "A refund is paid out as negative amounts.");
    const cash = tenders.filter((t) => t.method === "CASH").reduce((a, t) => a + t.amountCents, 0);
    if (totals.total >= 0 && totals.paid - cash > totals.total) throw new UserError("Card, check and gift amounts can't be more than the total. Only cash gives change.");
    if (totals.change > cash) throw new UserError("Only cash gives change. Take the exact amount on the card or check.");

    // The sewing shop's share of consigned sales, as the partnership stands today (kept with each sale).
    const shares = new Map<string, number>();
    for (const linkId of new Set(lines.map((l) => l.consignLinkId).filter(Boolean) as string[])) {
      const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: linkId } }, select: { terms: true } });
      shares.set(linkId, normalizeTerms(link?.terms).consignSharePct);
    }

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
          createdAt: at,
        },
      });
      for (const [i, l] of lines.entries()) {
        const { pickedUp, discountable, ...row } = l;
        void discountable;
        const line = await tx.saleLine.create({ data: { saleId: sale.id, ...row } });
        if (l.partId) {
          await tx.part.update({ where: { id: l.partId }, data: { qtyOnHand: { decrement: l.qty } } });
          await tx.stockMove.create({
            data: { shopId, partId: l.partId, qty: -l.qty, reason: "SOLD", userId: user.id, note: `Sale #${number}`, createdAt: at },
          });
        }
        if (l.consignLinkId && l.consignItemKey) {
          // Consigned stock: the owner hears about every sale at the price it really fetched, after the line discount
          // and this line's share of any discount on the whole sale (both boxes cost the owner the same).
          const net = Math.round((lineNet(l) - offEachLine[i]) / l.qty);
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
              shopKeepsCents: Math.round((gross * (shares.get(l.consignLinkId) ?? 0)) / 100),
            },
          });
          // A return takes back only what was sold (the repair shop applies the same rule, so both books agree).
          const took = await tx.consignItem.updateMany({
            where: { shopId, linkId: l.consignLinkId, itemKey: l.consignItemKey, ...(l.qty < 0 ? { sold: { gte: -l.qty } } : {}) },
            data: { sold: { increment: l.qty } },
          });
          if (!took.count) throw new UserError(`More of ${l.description} is being returned than was sold on consignment.`);
          await sendToPartner(shopId, l.consignLinkId, "consign.sale", { id: line.id, itemKey: l.consignItemKey, qty: l.qty, priceCents: net, saleNumber: number, at: at.toISOString() }, tx);
        }
        if (l.repairJobId) {
          const job = jobs.get(l.repairJobId)!;
          const amount = lineNet(l);
          const events = [...((job.events as { at: string; note?: string; status?: string }[]) ?? []), { at: at.toISOString(), note: `Paid $${(amount / 100).toFixed(2)} at the counter, sale #${number}` }].slice(-200);
          // Only if nobody paid it meanwhile (another register, or a second click) and the bill is still the one the
          // amount was worked out from: a repair shop update that landed since changes what's due.
          const paid = await tx.repairJob.updateMany({
            where: { shopId, id: job.id, paidAt: null, totalCents: job.totalCents, repairPaidCents: job.repairPaidCents, paidCents: job.paidCents },
            data: {
              paidCents: (job.paidCents ?? 0) + amount,
              paidAt: at,
              paidWhere: job.repairPaidCents ? "split" : "shop",
              ...(pickedUp ? { pickedUpAt: at, status: "COLLECTED" } : {}),
              events: (pickedUp ? [...events, { at: at.toISOString(), status: "COLLECTED" }] : events) as Prisma.InputJsonValue,
            },
          });
          if (!paid.count) {
            const now = await tx.repairJob.findUnique({ where: { shopId_id: { shopId, id: job.id } }, select: { paidAt: true } });
            throw new UserError(
              now?.paidAt
                ? `Repair tag ${job.tag} was just paid. Take it off this sale.`
                : `The bill for repair tag ${job.tag} changed while you were ringing it up. Take it off this sale and add it again for the new amount.`,
            );
          }
          await sendToPartner(shopId, job.linkId, "job.paid", { id: job.id, amountCents: amount, saleNumber: number, at: at.toISOString() }, tx);
          if (pickedUp) await sendToPartner(shopId, job.linkId, "job.pickedup", { id: job.id, at: at.toISOString() }, tx);
        }
      }
      return sale;
    });
    revalidatePath("/register", "layout");
    revalidatePath("/repairs", "layout");
    revalidatePath("/parts", "layout");
    return { saleId: sale.id, number: sale.number, changeCents: totals.change };
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
        // Reverse exactly what was recorded when it sold: the same net price (which carried its share of any discount
        // on the whole sale) and the same share kept, so the owner's books net to zero whatever the terms are today.
        const original = await tx.consignSale.findUnique({ where: { shopId_id: { shopId, id: l.id } }, select: { priceCents: true, shopKeepsCents: true } });
        const net = original?.priceCents ?? Math.round(lineNet(l) / l.qty);
        await tx.consignSale.create({
          data: { id, shopId, linkId: l.consignLinkId, itemKey: l.consignItemKey, qty: -l.qty, priceCents: net, saleNumber: sale.number, soldAt: at, shopKeepsCents: original?.shopKeepsCents != null ? -original.shopKeepsCents : null },
        });
        const undone = await tx.consignItem.updateMany({
          where: { shopId, linkId: l.consignLinkId, itemKey: l.consignItemKey, ...(l.qty > 0 ? { sold: { gte: l.qty } } : {}) },
          data: { sold: { decrement: l.qty } },
        });
        if (!undone.count) throw new UserError(`${l.description} was returned since this sale; void that return first.`);
        await sendToPartner(shopId, l.consignLinkId, "consign.sale", { id, itemKey: l.consignItemKey, qty: -l.qty, priceCents: net, saleNumber: sale.number, at: at.toISOString() }, tx);
      }
    }
  });
  revalidatePath("/register", "layout");
  revalidatePath("/parts", "layout");
});
