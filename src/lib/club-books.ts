import "server-only";
// Club money in the books (fabric-smarts-design.md 4a): each paid club month is posted as a register sale (one line, the
// club and month, the member as the customer), so the register's day summary, "taken today", the reports and the tax
// figures include it. The monthly price is what the member pays, tax included: the sale backs the shop's tax out of it
// (or takes the tax Stripe reports), so the sale's total is exactly the money received. A refund in Stripe, or "take back
// paid" at the counter, voids the sale (voidSaleAs rewinds the member's paid month). Integer cents; every query by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import type { CurrentUser } from "@/lib/session";

export const CLUB_TENDERS = ["CASH", "CARD", "CHECK", "OTHER"] as const;
export type ClubTender = (typeof CLUB_TENDERS)[number];
export const clubTenderOf = (v: unknown): ClubTender => (CLUB_TENDERS as readonly string[]).includes(String(v)) ? (String(v) as ClubTender) : "CASH";

const MAX_MONEY = 10_000_000;
const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/** Who the books say took a payment nobody rang up (a Stripe webhook): the shop's first owner or admin. */
async function booksUserFor(shopId: string): Promise<CurrentUser> {
  const pick = (role?: "OWNER" | "ADMIN") => db.user.findFirst({ where: { shopId, ...(role ? { role } : {}), active: true }, orderBy: { createdAt: "asc" }, select: { id: true, email: true } });
  const u = (await pick("OWNER")) ?? (await pick("ADMIN")) ?? (await db.user.findFirst({ where: { shopId }, orderBy: { createdAt: "asc" }, select: { id: true, email: true } }));
  if (!u) throw new UserError("This shop has no users to record the sale under.");
  return { id: u.id, shopId, role: "OWNER", name: "Club billing", email: u.email };
}

export type PostedClubPayment = { saleId: string; created: boolean };

/**
 * Posts one paid club month: a register sale (tender `method`) and the ClubPayment that ties it to the member. Sent again
 * with the same Stripe invoice it posts nothing twice (the invoice id is the sale's clientKey). Null when nothing was paid.
 * `by`: the person who marked it paid (the sale is theirs); without it the shop's owner stands in (webhooks).
 */
export async function postClubPayment(
  shopId: string,
  a: { memberId: string; month: string; label: string; amountCents: number; method: ClubTender; invoiceId?: string | null; paymentIntent?: string | null; taxCents?: number | null; by?: CurrentUser | null },
): Promise<PostedClubPayment | null> {
  const amount = Math.round(Number(a.amountCents));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (amount > MAX_MONEY) throw new UserError("A club payment can't be more than $100,000. Check the club's price.");
  if (a.invoiceId) {
    const prior = await db.clubPayment.findUnique({ where: { shopId_invoiceId: { shopId, invoiceId: a.invoiceId } }, select: { saleId: true } });
    if (prior) return { saleId: prior.saleId, created: false };
  }
  const m = await db.clubMember.findFirst({ where: { id: a.memberId, shopId }, include: { club: { select: { name: true } } } });
  if (!m) throw new UserError("Member not found.");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true } });
  // The price includes tax: back it out at the shop's rate unless the processor reported its own.
  const tax = a.taxCents != null ? Math.max(0, Math.min(amount, Math.round(a.taxCents))) : amount - Math.round(amount / (1 + shop.taxRatePct / 100));
  const attempt = a.invoiceId ? 0 : await db.clubPayment.count({ where: { shopId, memberId: m.id, month: a.month } });
  const clientKey = (a.invoiceId ? `club-inv-${a.invoiceId}` : `club-pay-${m.id}-${a.month}-${attempt}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const user = a.by ? { ...a.by, role: "OWNER" as const } : await booksUserFor(shopId);
  const text = `${m.club.name}: ${a.label}`;
  const sale = await completeSaleAs(
    user,
    {
      customerId: m.customerId,
      lines: [{ description: text.slice(0, 200), qty: 1, unitPriceCents: amount - tax, taxable: true }],
      tenders: [{ method: a.method, amountCents: amount, note: a.invoiceId ? `Stripe ${a.invoiceId}` : null }],
      note: `Club payment: ${text}`,
      clientKey,
      taxCents: tax,
    },
    // Money already taken is always booked, even if the program key has lapsed (the online shop does the same).
    { paidOnline: !a.by },
  );
  try {
    await db.clubPayment.create({ data: { shopId, memberId: m.id, month: a.month, amountCents: amount, method: a.method, invoiceId: a.invoiceId ?? null, paymentIntent: a.paymentIntent ?? null, saleId: sale.saleId } });
  } catch (e) {
    if (!isUnique(e)) throw e; // the same payment recorded by a retry running at once
    return { saleId: sale.saleId, created: false };
  }
  return { saleId: sale.saleId, created: true };
}

/** Voids a club payment's sale (a refund, or taken back); the register's void marks the payment and rewinds the member's paid month. */
export async function voidClubSale(user: CurrentUser | null, shopId: string, saleId: string, reason: string): Promise<void> {
  const who = user ?? (await booksUserFor(shopId));
  try {
    await voidSaleAs({ ...who, role: "OWNER" }, saleId, reason);
  } catch (e) {
    if (!(e instanceof UserError) || !/already void/.test(e.message)) throw e;
    await db.clubPayment.updateMany({ where: { shopId, saleId, voidedAt: null }, data: { voidedAt: new Date() } });
  }
}

/** A full refund in Stripe: every unvoided payment it covers is voided. Returns how many (0: not a club payment). */
export async function voidClubPaymentsFor(shopId: string, by: { paymentIntent: string | null; invoiceId: string | null }, reason: string): Promise<number> {
  const or = [...(by.paymentIntent ? [{ paymentIntent: by.paymentIntent }] : []), ...(by.invoiceId ? [{ invoiceId: by.invoiceId }] : [])];
  if (!or.length) return 0;
  const found = await db.clubPayment.findMany({ where: { shopId, voidedAt: null, OR: or }, select: { saleId: true } });
  for (const p of found) await voidClubSale(null, shopId, p.saleId, reason);
  return found.length;
}
