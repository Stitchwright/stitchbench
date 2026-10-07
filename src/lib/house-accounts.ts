import "server-only";
// House charge accounts (shop-features-round-2-design.md 9.4, package house-accounts). Off until the owner turns them on
// (Paperwork → House accounts). A customer gets an account (a limit, 0 for none, and terms, "30 days"); she buys "On
// account" at the register (tender ACCOUNT) or on a repair ticket (payment "Invoice (on account)"), pays against it, and
// gets a monthly statement (printed, or emailed with Messages on). "Owed to us" lists every account by age. Books: the
// charges are accounts receivable until paid. Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { money, str, toCents } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { moduleOn } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { addMonths, dayStart, parseYmd, ymdOf, zonedTime } from "@/lib/zoned";
import { queueToCustomer } from "@/lib/messaging/queue";
import { firstName } from "@/lib/messaging/templates";
import { agingOf, balanceOf, statementOf } from "@/lib/house-accounts-math";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient;
const MAX_CENTS = 10_000_000;
export const PAY_METHODS = { CASH: "Cash", CHECK: "Check", CARD: "Card", OTHER: "Other" } as const;

const adminOnly = (user: CurrentUser) => {
  if (user.role === "TECH") throw new UserError("Only an owner or admin handles house accounts.");
};

async function requireOnFor(shopId: string) {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { houseAccountsOn: true } });
  if (!s.houseAccountsOn) throw new UserError("House accounts are off. The owner turns them on under Paperwork, House accounts.");
}

/** The owner's switch (off by default). Turning it off keeps the accounts and their money; new charges stop. */
export async function setHouseAccountsOnFor(user: CurrentUser, on: boolean): Promise<string> {
  await requireBaseWritable(user);
  if (user.role !== "OWNER") throw new UserError("Only the owner turns house accounts on or off.");
  await db.shop.update({ where: { id: user.shopId }, data: { houseAccountsOn: on } });
  return on ? "House accounts are on." : "House accounts are off: nothing new goes on account. What is owed stays.";
}

function termsFrom(fd: FormData) {
  const rawLimit = str(fd.get("limit"));
  const limitCents = rawLimit ? toCents(rawLimit) : 0;
  if (limitCents == null || limitCents < 0 || limitCents > MAX_CENTS) throw new UserError("The limit: dollars, like 500 (blank for none).");
  const termsDays = Math.round(Number(str(fd.get("terms")) ?? "30"));
  if (!Number.isFinite(termsDays) || termsDays < 0 || termsDays > 120) throw new UserError("Terms: days to pay, like 30.");
  return { limitCents, termsDays, note: str(fd.get("note"))?.slice(0, 300) ?? null };
}

/** Opens (or changes) a customer's account. */
export async function saveAccountFor(user: CurrentUser, customerId: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  adminOnly(user);
  await requireOnFor(user.shopId);
  const c = await db.customer.findFirst({ where: { id: assertId(customerId), shopId: user.shopId }, select: { id: true, name: true } });
  if (!c) throw new UserError("Customer not found.");
  const t = termsFrom(fd);
  const status = str(fd.get("status")) === "CLOSED" ? "CLOSED" : "OPEN";
  await db.houseAccount.upsert({ where: { shopId_customerId: { shopId: user.shopId, customerId: c.id } }, create: { shopId: user.shopId, customerId: c.id, ...t, status }, update: { ...t, status } });
  return status === "CLOSED" ? `${c.name}'s account is closed to new charges.` : `${c.name} can buy on account${t.limitCents ? ` up to ${money(t.limitCents)}` : ""}, ${t.termsDays} days to pay.`;
}

async function entriesOf(db_: Tx | typeof db, accountId: string) {
  return db_.accountEntry.findMany({ where: { accountId }, select: { kind: true, amountCents: true, at: true, voidedAt: true } });
}

// ---------------------------------------------------------------------------------------------------------------
// The register and tickets

/** Before a sale with "On account" payments: her open account, within its limit. Returns the account's id, or null. */
export async function prepareAccountTender(shopId: string, customerId: string | null, tenders: { method: string; amountCents: number }[]): Promise<string | null> {
  const onAccount = tenders.filter((t) => t.method === "ACCOUNT");
  if (!onAccount.length) return null;
  await requireOnFor(shopId);
  if (!customerId) throw new UserError("Pick the customer whose account it goes on.");
  const a = await db.houseAccount.findFirst({ where: { shopId, customerId } });
  if (!a) throw new UserError("This customer has no house account. Open one on her page, or take another payment.");
  const amount = onAccount.reduce((x, t) => x + t.amountCents, 0);
  if (amount > 0 && a.status !== "OPEN") throw new UserError("Her account is closed to new charges.");
  if (amount > 0 && a.limitCents > 0) {
    const owed = balanceOf(await entriesOf(db, a.id));
    if (owed + amount > a.limitCents) throw new UserError(`That's over her ${money(a.limitCents)} limit: she owes ${money(owed)} already.`);
  }
  return a.id;
}

/** In the sale's transaction: the charge (or, negative, a refund to the account). */
export async function applyAccountTender(tx: Tx, a: { shopId: string; accountId: string | null; saleId: string; saleNumber: number; amountCents: number; at: Date; userId: string }) {
  if (!a.accountId || !a.amountCents) return;
  await tx.accountEntry.create({ data: { shopId: a.shopId, accountId: a.accountId, kind: "CHARGE", amountCents: a.amountCents, saleId: a.saleId, note: `Sale #${a.saleNumber}`, byUserId: a.userId, at: a.at } });
}

/** The sale is voided: its charge comes off. */
export async function voidAccountOfSale(tx: Tx, shopId: string, saleId: string, at: Date) {
  await tx.accountEntry.updateMany({ where: { shopId, saleId, voidedAt: null }, data: { voidedAt: at } });
}

/** A ticket payment "Invoice (on account)" for a customer with a house account (and its removal) goes on it. */
export async function accountFromTicketPayment(tx: Tx, a: { shopId: string; customerId: string | null; ticketId: string; ticketNumber: number; paymentId: string; method: string; amountCents: number; userId: string }) {
  if (a.method !== "INVOICE" || !a.customerId) return;
  const shop = await tx.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { houseAccountsOn: true } });
  if (!shop.houseAccountsOn) return;
  const acct = await tx.houseAccount.findFirst({ where: { shopId: a.shopId, customerId: a.customerId } });
  if (!acct) return;
  if (a.amountCents > 0 && acct.status !== "OPEN") throw new UserError("Her account is closed to new charges.");
  // Within her limit, as at the register (read in this transaction).
  if (a.amountCents > 0 && acct.limitCents > 0) {
    const owed = balanceOf(await entriesOf(tx, acct.id));
    if (owed + a.amountCents > acct.limitCents) throw new UserError(`That's over her ${money(acct.limitCents)} limit: she owes ${money(owed)} already.`);
  }
  await tx.accountEntry.create({ data: { shopId: a.shopId, accountId: acct.id, kind: "CHARGE", amountCents: a.amountCents, ticketId: a.ticketId, paymentId: a.paymentId, note: `Ticket #${String(a.ticketNumber).padStart(4, "0")}`, byUserId: a.userId } });
}

// ---------------------------------------------------------------------------------------------------------------
// Payments against the account

export async function takeAccountPaymentFor(user: CurrentUser, accountId: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  const a = await db.houseAccount.findFirst({ where: { id: assertId(accountId), shopId: user.shopId } });
  if (!a) throw new UserError("Account not found.");
  const cents = toCents(str(fd.get("amount")) ?? "");
  if (cents == null || cents <= 0 || cents > MAX_CENTS) throw new UserError("The amount paid: dollars, like 120.00.");
  const method = str(fd.get("method")) ?? "CHECK";
  if (!(method in PAY_METHODS)) throw new UserError("Pick how she paid.");
  const note = str(fd.get("note"))?.slice(0, 120) ?? null;
  if (method === "CHECK" && !note) throw new UserError("Type the check number.");
  const raw = str(fd.get("on"));
  const ymd = raw ? parseYmd(raw) : null;
  if (raw && !ymd) throw new UserError("Enter the date as a date.");
  const at = ymd ? zonedTime(ymd, 12 * 60, await shopTimeZone(user.shopId)) : new Date();
  if (at.getTime() > Date.now() + 86_400_000) throw new UserError("That date is in the future.");
  await db.accountEntry.create({ data: { shopId: user.shopId, accountId: a.id, kind: "PAYMENT", amountCents: cents, method, note, byUserId: user.id, at } });
  return `${money(cents)} paid on the account.`;
}

/** Undo a payment recorded by mistake. Owner or admin. */
export async function undoAccountEntryFor(user: CurrentUser, entryId: string): Promise<string> {
  await requireBaseWritable(user);
  adminOnly(user);
  const e = await db.accountEntry.findFirst({ where: { id: assertId(entryId), shopId: user.shopId } });
  if (!e) throw new UserError("Not found.");
  if (e.kind !== "PAYMENT") throw new UserError("A charge comes off by voiding its sale or removing its ticket payment.");
  if (e.voidedAt) return "Already undone.";
  await db.accountEntry.updateMany({ where: { id: e.id, shopId: user.shopId }, data: { voidedAt: new Date() } });
  return "Payment undone.";
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

/** Every account with what is owed by age, the most past due first. */
export async function accountsOwed(shopId: string, now = new Date()) {
  const accounts = await db.houseAccount.findMany({ where: { shopId }, include: { entries: { select: { kind: true, amountCents: true, at: true, voidedAt: true } } } });
  const names = new Map((await db.customer.findMany({ where: { shopId, id: { in: accounts.map((a) => a.customerId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  return accounts
    .map((a) => ({ id: a.id, customerId: a.customerId, name: names.get(a.customerId) ?? "Deleted customer", status: a.status, limitCents: a.limitCents, termsDays: a.termsDays, aging: agingOf(a.entries, now) }))
    .sort((x, y) => y.aging.d90 - x.aging.d90 || y.aging.d60 - x.aging.d60 || y.aging.d30 - x.aging.d30 || y.aging.total - x.aging.total || x.name.localeCompare(y.name));
}

export async function accountOf(shopId: string, customerId: string) {
  const a = await db.houseAccount.findFirst({ where: { shopId, customerId } });
  if (!a) return null;
  const entries = await db.accountEntry.findMany({ where: { accountId: a.id, shopId }, orderBy: { at: "desc" }, take: 50 });
  return { ...a, entries, balanceCents: balanceOf(await entriesOf(db, a.id)), aging: agingOf(await entriesOf(db, a.id), new Date()) };
}

export async function accountView(shopId: string, accountId: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(accountId)) return null;
  const a = await db.houseAccount.findFirst({ where: { id: accountId, shopId } });
  if (!a) return null;
  return accountOf(shopId, a.customerId);
}

/** A month's statement ("2026-09"), in the shop's days, with what is due and by when. */
export async function statementFor(shopId: string, accountId: string, month: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(accountId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const a = await db.houseAccount.findFirst({ where: { id: accountId, shopId } });
  if (!a) return null;
  const [tz, customer, shop, all] = await Promise.all([
    shopTimeZone(shopId),
    db.customer.findFirst({ where: { id: a.customerId, shopId }, select: { name: true, address: true, email: true } }),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, address: true, phone: true } }),
    db.accountEntry.findMany({ where: { accountId: a.id, shopId }, orderBy: { at: "asc" } }),
  ]);
  const first = `${month}-01`;
  const next = addMonths(first, 1)!;
  const s = statementOf(all, dayStart(first, tz), dayStart(next, tz));
  const lines = all.filter((e) => !e.voidedAt && e.at >= dayStart(first, tz) && e.at < dayStart(next, tz));
  const due = new Date(dayStart(next, tz).getTime() + a.termsDays * 86_400_000);
  return { account: a, customer, shop, month, tz, ...s, lines, due, monthLabel: new Date(`${first}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" }) };
}

/** Last month in the shop's zone ("2026-09"), the month statements are usually made for. */
export async function lastMonth(shopId: string) {
  const today = ymdOf(new Date(), await shopTimeZone(shopId));
  return addMonths(`${today.slice(0, 7)}-01`, -1)!.slice(0, 7);
}

/** Emails a month's statement to her (Messages on): what she owes and by when, the shop's phone for questions. */
export async function emailStatementFor(user: CurrentUser, accountId: string, month: string): Promise<string> {
  adminOnly(user);
  const st = await statementFor(user.shopId, accountId, month);
  if (!st) throw new UserError("Account not found.");
  if (!(await moduleOn(user.shopId, "marketing"))) throw new UserError("Emailing statements needs Messages. Print it instead.");
  if (!st.customer?.email) throw new UserError("She has no email address. Print it instead.");
  const body = `Hi ${firstName(st.customer.name)}, your ${st.shop.name} account statement for ${st.monthLabel}: owed at the start ${money(st.opening)}, charges ${money(st.charges)}, payments ${money(st.payments)}, now owed ${money(st.closing)}${st.closing > 0 ? `, due by ${st.due.toLocaleDateString("en-US", { timeZone: st.tz, month: "long", day: "numeric" })}` : ""}.${st.shop.phone ? ` Questions? Call ${st.shop.phone}.` : ""}`;
  const r = await db.$transaction((tx) =>
    queueToCustomer(tx, {
      shopId: user.shopId,
      customerId: st.account.customerId,
      kind: "order_notice",
      channels: ["email"],
      content: () => ({ subject: `${st.shop.name}: your statement for ${st.monthLabel}`, body }),
      dedupeKey: `statement:${accountId}:${month}`,
      refType: "statement",
      refId: accountId,
      byUserId: user.id,
    }),
  );
  if (!r.queued.length) throw new UserError("Not sent: she can't be emailed (or it was sent already). Print it instead.");
  return "The statement is on its way.";
}
