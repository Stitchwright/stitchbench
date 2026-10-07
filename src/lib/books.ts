import "server-only";
// The bookkeeping export (later-round-1-design.md 3.4): one summary journal entry per day, as a CSV in QuickBooks Online's
// journal-entry import layout and as an IIF for QuickBooks Desktop (General Journal). Every day's entry balances by
// construction: the money tendered (less change) equals the lines less discounts plus tax, and a repair is booked through
// a clearing account (payments in, handed-back bills out). Cost of goods and inventory are left out.
//
// The day is the shop's. A counter sale counts on its day, its void on the void's day; a repair when the machine is handed
// back; repair payments when they are taken; an online order on the day it was paid.
import { db } from "@/lib/db";
import type { Tender } from "@/lib/register-math";
import { saleLines } from "@/lib/reports/sales";
import { SALE_KIND_LABEL } from "@/lib/sale-kind";
import { lineTotal, ticketTotals } from "@/lib/ticket-math";
import { dateIn } from "@/lib/time-zone";
import { accountName, cleanAccount, DEFAULT_BOOKS, readAccounts, type AccountKey, type BooksConfig } from "@/lib/books-accounts";
import type { LineKind } from "@/generated/prisma/enums";

export type BooksSettingsView = BooksConfig & { exportedThrough: string | null };

export async function loadBooks(shopId: string): Promise<BooksSettingsView> {
  const row = await db.booksSettings.findUnique({ where: { shopId } });
  if (!row) return { ...DEFAULT_BOOKS, exportedThrough: null };
  return { accounts: readAccounts(row.accounts), byCategory: row.byCategory, netDiscounts: row.netDiscounts, cardClearing: row.cardClearing.trim(), exportedThrough: row.exportedThrough };
}

export type BookLine = { account: string; debitCents: number; creditCents: number };
export type DayEntry = { day: string; number: string; lines: BookLine[] };

export type BooksResult = {
  days: DayEntry[];
  /** Sales whose lines and payments did not match to the cent (their difference went to the sales account); 0 is expected. */
  unbalancedSales: number;
  /** What the repair clearing account holds at the end of the range: deposits on machines still in and unpaid bills of collected ones. */
  repairClearingCents: number;
};

const REPAIR_KIND_LABEL: Record<LineKind, string> = { SERVICE: "Service", LABOR: "Labor", PART: "Parts", FEE: "Fees", DISCOUNT: "Discounts" };

/** Where a payment or tender lands on the debit side. */
function tenderKey(method: string, cfg: BooksConfig): { account: string } {
  switch (method) {
    case "CARD":
      return { account: cfg.cardClearing.trim() ? cleanAccount(cfg.cardClearing) : accountName(cfg, "undeposited") };
    case "ONLINE":
      return { account: accountName(cfg, "stripe") };
    case "GIFT":
      return { account: accountName(cfg, "giftLiability") };
    case "CREDIT":
      return { account: accountName(cfg, "creditLiability") };
    case "INVOICE":
      return { account: accountName(cfg, "receivable") };
    case "SHOP_COLLECTED":
      return { account: accountName(cfg, "dueFromPartners") };
    default:
      return { account: accountName(cfg, "undeposited") };
  }
}

export async function buildBooks(shopId: string, tz: string, start: Date, end: Date, cfg: BooksConfig): Promise<BooksResult> {
  const days = new Map<string, Map<string, number>>(); // day -> account -> net debit (credit is negative)
  const inRange = (d: Date | null) => d != null && d >= start && d < end;
  const post = (ledger: Map<string, number>, account: string, debit: number) => {
    if (debit) ledger.set(account, (ledger.get(account) ?? 0) + debit);
  };
  const dayLedger = (d: Date) => {
    const k = dateIn(d, tz);
    let m = days.get(k);
    if (!m) days.set(k, (m = new Map()));
    return m;
  };
  const merge = (into: Map<string, number>, from: Map<string, number>) => {
    for (const [a, v] of from) post(into, a, v);
  };
  const acct = (k: AccountKey) => accountName(cfg, k);
  const salesAccount = (kind: string) => (cfg.byCategory ? `${acct("sales")} - ${SALE_KIND_LABEL[kind] ?? kind}` : acct("sales"));
  let unbalancedSales = 0;

  // ----- counter and online sales, their returns and voids -----
  const sales = await db.sale.findMany({
    where: { shopId, OR: [{ createdAt: { gte: start, lt: end } }, { status: "VOIDED", voidedAt: { gte: start, lt: end } }] },
    include: { lines: { include: { part: { select: { kind: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  for (const s of sales) {
    const lines = saleLines(s);
    const events: { at: Date; sign: 1 | -1 }[] = [];
    if (inRange(s.createdAt)) events.push({ at: s.createdAt, sign: 1 });
    if (s.status === "VOIDED" && inRange(s.voidedAt)) events.push({ at: s.voidedAt!, sign: -1 });
    for (const { at, sign } of events) {
      const one = new Map<string, number>();
      for (const t of s.tenders as Tender[]) post(one, tenderKey(t.method, cfg).account, sign * t.amountCents);
      if (s.changeCents) post(one, acct("undeposited"), -sign * s.changeCents);
      for (const x of lines) {
        const a = x.amount;
        if (x.kind === "GIFT_CARD") post(one, acct("giftLiability"), -sign * a);
        else if (x.kind === "TRADE_IN") post(one, acct("tradeIns"), -sign * a);
        else if (x.kind === "REPAIR") post(one, acct("dueToPartners"), -sign * a);
        else if (!cfg.netDiscounts && x.discount > 0 && x.line.qty * x.line.unitPriceCents > 0) {
          post(one, salesAccount(x.kind), -sign * (a + x.discount));
          post(one, acct("discounts"), sign * x.discount);
        } else post(one, salesAccount(x.kind), -sign * a);
      }
      post(one, acct("salesTax"), -sign * s.taxCents);
      const off = [...one.values()].reduce((a, v) => a + v, 0);
      if (off !== 0) {
        unbalancedSales++;
        post(one, acct("sales"), -off);
      }
      merge(dayLedger(at), one);
    }
  }

  // ----- repairs, when the machine goes home -----
  const closed = await db.ticket.findMany({
    where: { shopId, status: { in: ["COLLECTED", "RETURNED_UNREPAIRED"] }, closedAt: { gte: start, lt: end } },
    include: { lines: true, payments: true },
  });
  for (const t of closed) {
    const x = ticketTotals(t.lines, t.payments, t.taxRatePct);
    const led = dayLedger(t.closedAt!);
    post(led, acct("repairClearing"), x.total);
    const byKind = new Map<LineKind, number>();
    for (const l of t.lines) byKind.set(l.kind, (byKind.get(l.kind) ?? 0) + lineTotal(l));
    for (const [k, v] of byKind) post(led, `${acct("repairIncome")} - ${REPAIR_KIND_LABEL[k]}`, -v);
    post(led, acct("salesTax"), -x.tax);
  }

  // ----- repair money, when it is taken -----
  const pays = await db.payment.findMany({ where: { ticket: { shopId }, paidAt: { gte: start, lt: end } }, select: { amountCents: true, method: true, paidAt: true } });
  for (const p of pays) {
    const led = dayLedger(p.paidAt);
    post(led, tenderKey(p.method, cfg).account, p.amountCents);
    post(led, acct("repairClearing"), -p.amountCents);
  }

  // ----- a card's balance fixed by hand or an existing card added: the offset is its own account -----
  const entries = await db.giftCardEntry.findMany({ where: { shopId, at: { gte: start, lt: end }, reason: { in: ["ADJUSTED", "OPENING"] } }, select: { cardId: true, at: true, amountCents: true } });
  if (entries.length) {
    const kinds = new Map((await db.giftCard.findMany({ where: { shopId, id: { in: [...new Set(entries.map((e) => e.cardId))] } }, select: { id: true, kind: true } })).map((c) => [c.id, c.kind]));
    for (const e of entries) {
      const led = dayLedger(e.at);
      post(led, kinds.get(e.cardId) === "credit" ? acct("creditLiability") : acct("giftLiability"), -e.amountCents);
      post(led, acct("giftAdjust"), e.amountCents);
    }
  }

  const out: DayEntry[] = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, m]) => {
      const lines = [...m.entries()]
        .filter(([, v]) => v !== 0)
        .map(([account, v]) => ({ account, debitCents: v > 0 ? v : 0, creditCents: v < 0 ? -v : 0 }))
        .sort((a, b) => Number(b.debitCents > 0) - Number(a.debitCents > 0) || a.account.localeCompare(b.account));
      return { day, number: `SB-${day.replace(/-/g, "")}`, lines };
    })
    .filter((d) => d.lines.length > 0);

  // The clearing account's balance: everything taken on repairs less every bill handed back, up to the end of the range.
  const taken = await db.payment.aggregate({ where: { ticket: { shopId }, paidAt: { lt: end } }, _sum: { amountCents: true } });
  const done = await db.ticket.findMany({ where: { shopId, status: { in: ["COLLECTED", "RETURNED_UNREPAIRED"] }, closedAt: { lt: end } }, include: { lines: true } });
  const billed = done.reduce((a, t) => a + ticketTotals(t.lines, [], t.taxRatePct).total, 0);
  return { days: out, unbalancedSales, repairClearingCents: (taken._sum.amountCents ?? 0) - billed };
}

/** True when the day's debits equal its credits. */
export const balanced = (d: DayEntry) => d.lines.reduce((a, l) => a + l.debitCents - l.creditCents, 0) === 0;

const usDate = (day: string) => `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;
const dollars = (c: number) => (c / 100).toFixed(2);

/** QuickBooks Online's journal entry import: one row per account per day, the entry's number and date on each row. */
export function toJournalCsvRows(days: DayEntry[]): string[][] {
  const rows: string[][] = [["*JournalNo", "*JournalDate", "*AccountName", "*Debits", "*Credits", "Description", "Name"]];
  for (const d of days) for (const l of d.lines) rows.push([d.number, usDate(d.day), l.account, l.debitCents ? dollars(l.debitCents) : "", l.creditCents ? dollars(l.creditCents) : "", "Daily sales summary", ""]);
  return rows;
}

/** QuickBooks Desktop's IIF: a GENERAL JOURNAL transaction a day (the first line the TRNS, the others SPL; amounts are debits positive, credits negative). */
export function toIif(days: DayEntry[]): string {
  const out = ["!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO", "!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO", "!ENDTRNS"];
  for (const d of days) {
    d.lines.forEach((l, i) => {
      const amount = dollars(l.debitCents - l.creditCents);
      out.push([i === 0 ? "TRNS" : "SPL", "", "GENERAL JOURNAL", usDate(d.day), l.account, amount, d.number, "Daily sales summary"].join("\t"));
    });
    out.push("ENDTRNS");
  }
  return out.join("\r\n") + "\r\n";
}
