import "server-only";
// Financing (tax-machine-sales-layaway-design.md section 5; owner's answers 7 and 8: record only, no house accounts).
// The shop lists its lenders (Settings → Selling); the register takes a Financing payment naming the lender and the
// approval number; the lender owes the shop that money (a FinancedSale, in the books as owed by lenders) until the shop
// marks it paid. No lender is called: each needs its own merchant agreement. Every query by shopId.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { str } from "@/lib/format";
import type { Tender } from "@/lib/register-math";

type Tx = Prisma.TransactionClient;

export type LenderRow = { id: string; name: string; applyUrl: string | null; active: boolean };

export async function listLenders(shopId: string, activeOnly = false): Promise<LenderRow[]> {
  return db.lender.findMany({ where: { shopId, ...(activeOnly ? { active: true } : {}) }, orderBy: [{ active: "desc" }, { name: "asc" }], select: { id: true, name: true, applyUrl: true, active: true } });
}

/** Adds (id null) or changes a lender; owner or admin. */
export async function saveLenderFor(user: CurrentUser, id: string | null, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const name = str(fd.get("name"))?.slice(0, 60);
  if (!name) throw new UserError("Enter the lender's name, e.g. Synchrony.");
  const url = str(fd.get("applyUrl"));
  if (url && (!/^https?:\/\/\S+$/i.test(url) || url.length > 300)) throw new UserError("The apply page: a web address starting with https://");
  const data = { name, applyUrl: url ?? null, active: id ? fd.get("active") === "on" : true };
  if (!id) {
    await db.lender.create({ data: { shopId: user.shopId, ...data } });
    return;
  }
  const r = await db.lender.updateMany({ where: { id, shopId: user.shopId }, data });
  if (!r.count) throw new UserError("Lender not found.");
}

/** Before a sale: each Financing payment names one of this shop's lenders and the approval number; the lender's name is kept on it. */
export async function prepareFinanced(shopId: string, tenders: Tender[]): Promise<void> {
  const fin = tenders.filter((t) => t.method === "FINANCED");
  if (!fin.length) return;
  const lenders = new Map((await db.lender.findMany({ where: { shopId, id: { in: fin.map((t) => String(t.lenderId ?? "")) } } })).map((l) => [l.id, l]));
  for (const t of fin) {
    const l = lenders.get(String(t.lenderId ?? ""));
    if (!l) throw new UserError("Pick the lender for the financing payment.");
    if (!l.active && t.amountCents > 0) throw new UserError(`${l.name} isn't offered any more (Settings → Selling).`);
    const approval = (t.note ?? "").trim();
    if (!approval) throw new UserError(`Enter ${l.name}'s approval number.`);
    t.note = approval.slice(0, 40);
    t.lenderId = l.id;
    t.lender = l.name;
  }
}

/** Inside the sale's transaction: what each lender now owes. */
export async function recordFinanced(tx: Tx, a: { shopId: string; saleId: string; tenders: Tender[]; at: Date }): Promise<void> {
  for (const t of a.tenders) {
    if (t.method !== "FINANCED" || !t.lenderId) continue;
    await tx.financedSale.create({ data: { shopId: a.shopId, saleId: a.saleId, lenderId: t.lenderId, amountCents: t.amountCents, approval: t.note ?? null, at: a.at } });
  }
}

/** Inside a void: the sale's financing is voided too, unless a lender has paid it (mark it not paid first). */
export async function voidFinanced(tx: Tx, a: { shopId: string; saleId: string; at: Date }): Promise<void> {
  const rows = await tx.financedSale.findMany({ where: { shopId: a.shopId, saleId: a.saleId, voidedAt: null }, include: { lender: { select: { name: true } } } });
  const paid = rows.find((r) => r.paidAt);
  if (paid) throw new UserError(`${paid.lender.name} has already paid this sale. Mark it not paid (Reports → Financing) and sort it out with them first.`);
  if (rows.length) await tx.financedSale.updateMany({ where: { shopId: a.shopId, saleId: a.saleId, voidedAt: null }, data: { voidedAt: a.at } });
}

/** The lender paid it (or, paid false, it hasn't after all); owner or admin. */
export async function markFinancedPaidFor(user: CurrentUser, id: string, paid: boolean): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const r = await db.financedSale.updateMany({ where: { id, shopId: user.shopId, voidedAt: null, paidAt: paid ? null : { not: null } }, data: paid ? { paidAt: new Date(), paidById: user.id } : { paidAt: null, paidById: null } });
  if (!r.count) throw new UserError(paid ? "Not found, or already marked paid." : "Not found, or not marked paid.");
}

export type FinancedRow = { id: string; saleId: string; saleNumber: number; customer: string | null; lender: string; approval: string | null; amountCents: number; at: Date; paidAt: Date | null };

/** Financed sales in a range (by sale date) and every one still unpaid, with each lender's totals. */
export async function financedReport(shopId: string, start: Date, end: Date) {
  const rows = await db.financedSale.findMany({
    where: { shopId, voidedAt: null, OR: [{ at: { gte: start, lt: end } }, { paidAt: null }] },
    include: { lender: { select: { name: true } } },
    orderBy: { at: "asc" },
  });
  const sales = new Map(
    (await db.sale.findMany({ where: { shopId, id: { in: [...new Set(rows.map((r) => r.saleId))] } }, select: { id: true, number: true, customer: { select: { name: true } } } })).map((s) => [s.id, s]),
  );
  const list: FinancedRow[] = rows.map((r) => ({
    id: r.id,
    saleId: r.saleId,
    saleNumber: sales.get(r.saleId)?.number ?? 0,
    customer: sales.get(r.saleId)?.customer?.name ?? null,
    lender: r.lender.name,
    approval: r.approval,
    amountCents: r.amountCents,
    at: r.at,
    paidAt: r.paidAt,
  }));
  const inRange = list.filter((r) => r.at >= start && r.at < end);
  const byLender = new Map<string, { lender: string; count: number; cents: number; unpaidCents: number }>();
  for (const r of list) {
    const x = byLender.get(r.lender) ?? { lender: r.lender, count: 0, cents: 0, unpaidCents: 0 };
    if (r.at >= start && r.at < end) {
      x.count++;
      x.cents += r.amountCents;
    }
    if (!r.paidAt) x.unpaidCents += r.amountCents;
    byLender.set(r.lender, x);
  }
  return { inRange, unpaid: list.filter((r) => !r.paidAt), byLender: [...byLender.values()].sort((a, b) => a.lender.localeCompare(b.lender)) };
}
