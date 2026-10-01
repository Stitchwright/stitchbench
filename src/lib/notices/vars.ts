import "server-only";
// The merge fields a ticket or a partner job gives a notice (scheduling-messaging-design.md section 9.1).
import type { OutMessage, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { money, ticketNo } from "@/lib/format";
import { fmtDay } from "@/lib/zoned";
import type { MessagingView } from "@/lib/messaging/settings";
import { firstName } from "@/lib/messaging/templates";
import { abandonDate, abandonStages, sendable, stageKey, type AbandonStage } from "@/lib/notices/abandon";
import { ticketTotals } from "@/lib/ticket-math";

type Db = Prisma.TransactionClient | typeof db;

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function common(shop: { name: string; phone: string | null }, customer: { name: string } | null) {
  return { first_name: firstName(customer?.name ?? ""), name: customer?.name ?? "", shop_name: shop.name, shop_phone: shop.phone ?? "" };
}

/**
 * direct = a customer of this shop, not brought in through a trade account, and not a repair this shop does for a partner
 * sewing shop. A central vac install (SITE) is `jobType "SITE"`; its machine reads "central vac install".
 */
export async function ticketVars(tx: Db, ticketId: string, shopId: string): Promise<{ customerId: string | null; direct: boolean; jobType: string; vars: Record<string, string> } | null> {
  const t = await tx.ticket.findFirst({
    where: { id: ticketId, shopId },
    select: {
      number: true,
      customerId: true,
      viaAccountId: true,
      jobType: true,
      taxRatePct: true,
      customer: { select: { name: true } },
      machine: { select: { brand: true, model: true } },
      lines: { select: { kind: true, qty: true, unitPriceCents: true, taxable: true } },
      payments: { select: { amountCents: true, method: true } },
      shop: { select: { name: true, phone: true } },
    },
  });
  if (!t) return null;
  const job = await tx.repairJob.findFirst({ where: { shopId, ticketId }, select: { id: true } });
  const balance = ticketTotals(t.lines, t.payments, t.taxRatePct).balance;
  return {
    customerId: t.customerId,
    direct: !!t.customerId && !t.viaAccountId && !job,
    jobType: t.jobType,
    vars: {
      ...common(t.shop, t.customer),
      machine: t.jobType === "SITE" ? "central vac install" : clean(`${t.machine.brand} ${t.machine.model}`),
      ref: `ticket ${ticketNo(t.number)}`,
      amount_line: balance > 0 ? ` Balance: ${money(balance)}.` : "",
    },
  };
}

/** The retail side of a partner job (the sewing shop's own customer); ref reads "tag 101". */
export async function jobVars(tx: Db, jobId: string, shopId: string): Promise<{ customerId: string | null; vars: Record<string, string> } | null> {
  const j = await tx.repairJob.findUnique({
    where: { shopId_id: { shopId, id: jobId } },
    select: { side: true, tag: true, brand: true, model: true, customerId: true, totalCents: true, repairPaidCents: true, paidCents: true, customer: { select: { name: true } }, shop: { select: { name: true, phone: true } } },
  });
  if (!j || j.side !== "retail") return null;
  const owed = j.totalCents == null ? 0 : j.totalCents - (j.repairPaidCents ?? 0) - (j.paidCents ?? 0);
  return {
    customerId: j.customerId,
    vars: {
      ...common(j.shop, j.customer),
      machine: clean(`${j.brand} ${j.model}`),
      ref: `tag ${j.tag}`,
      amount_line: owed > 0 ? ` Balance: ${money(owed)}.` : "",
    },
  };
}

// ---------- uncollected-machine notices: what a ticket or retail job gives the stages ----------

export type AbandonTarget = {
  kind: "ticket" | "job";
  id: string;
  customerId: string;
  /** The day the clock counts from: pickupReadyAt (ticket) or backAt (retail job). */
  start: Date;
  abandonedAfterDays: number;
  tz: string;
  storageFeeCents: number;
  vars: Record<string, string>;
};

/** The abandon rule a partnership names (`terms.abandonedAfterDays`), else the shop's own. */
function termDays(terms: unknown, fallback: number): number {
  const v = terms && typeof terms === "object" ? (terms as { abandonedAfterDays?: unknown }).abandonedAfterDays : undefined;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * A direct ticket waiting on the pickup shelf (not SITE), or a retail job back at our counter and not picked up, as the
 * stages need it; null for anything else. Always looked up by shop.
 */
export async function abandonTarget(tx: Db, shopId: string, ref: { ticketId?: string | null; jobId?: string | null }): Promise<AbandonTarget | null> {
  const shop = await tx.shop.findUnique({ where: { id: shopId }, select: { timeZone: true, abandonedAfterDays: true, storageFeeCents: true } });
  if (!shop) return null;
  if (ref.ticketId) {
    const t = await tx.ticket.findFirst({ where: { id: ref.ticketId, shopId }, select: { status: true, pickupReadyAt: true } });
    if (!t || t.status !== "READY_FOR_PICKUP" || !t.pickupReadyAt) return null;
    const v = await ticketVars(tx, ref.ticketId, shopId);
    if (!v || !v.direct || v.jobType === "SITE" || !v.customerId) return null;
    return { kind: "ticket", id: ref.ticketId, customerId: v.customerId, start: t.pickupReadyAt, abandonedAfterDays: shop.abandonedAfterDays, tz: shop.timeZone, storageFeeCents: shop.storageFeeCents, vars: v.vars };
  }
  if (ref.jobId) {
    const j = await tx.repairJob.findUnique({ where: { shopId_id: { shopId, id: ref.jobId } }, select: { side: true, linkId: true, customerId: true, pickedUpAt: true, backAt: true } });
    if (!j || j.side !== "retail" || !j.customerId || j.pickedUpAt || !j.backAt) return null;
    const [v, link] = await Promise.all([jobVars(tx, ref.jobId, shopId), tx.partnerLink.findUnique({ where: { shopId_id: { shopId, id: j.linkId } }, select: { terms: true } })]);
    if (!v) return null;
    return { kind: "job", id: ref.jobId, customerId: j.customerId, start: j.backAt, abandonedAfterDays: termDays(link?.terms, shop.abandonedAfterDays), tz: shop.timeZone, storageFeeCents: shop.storageFeeCents, vars: v.vars };
  }
  return null;
}

// ---------- the schedule of an uncollected machine, as the ticket page, job page and to-do lines show it ----------

export type StageState = "sent" | "undelivered" | "waiting" | "not_sent" | "due" | "coming" | "past" | "replaced";
export type StageView = { stage: AbandonStage; key: string; state: StageState; /** every row for this stage (sent, queued, skipped, by hand) */ rows: OutMessage[] };

/** A text the carrier says didn't arrive isn't proof of notice. */
export const notDelivered = (m: { channel: string; deliveryStatus: string | null }) => m.channel === "sms" && (m.deliveryStatus === "undelivered" || m.deliveryStatus === "failed");

/**
 * Each stage's state from the rows that exist for the machine (`rows` are its `abandon` rows with a stage key; any
 * status, sent by the worker or recorded by hand). A stage nothing happened for is `coming` before its date; `due` while
 * it can still go out; `past` when it was the latest due and its window is over (decide by hand); `replaced` when a later
 * stage fell due before it went.
 */
export function scheduleFor(start: Date, abandonedAfterDays: number, tz: string, ms: Pick<MessagingView, "abandonDays" | "finalNoticeDays" | "reminderHour">, now: Date, rows: OutMessage[]): { stages: StageView[]; abandonAt: Date } {
  const stages = abandonStages(start, ms.abandonDays, abandonedAfterDays, ms.finalNoticeDays, ms.reminderHour, tz);
  const abandonAt = abandonDate(start, abandonedAfterDays, tz);
  const now1 = sendable(stages, now, abandonAt);
  const latestDue = stages.filter((s) => s.due.getTime() <= now.getTime()).at(-1) ?? null;
  const views = stages.map((s): StageView => {
    const key = stageKey(start, s);
    const mine = rows.filter((r) => r.refId === key);
    let state: StageState;
    if (mine.some((r) => r.status === "SENT" && !notDelivered(r))) state = "sent";
    else if (mine.some((r) => r.status === "SENT")) state = "undelivered";
    else if (mine.some((r) => r.status === "QUEUED" || r.status === "SENDING")) state = "waiting";
    else if (mine.length) state = "not_sent";
    else if (s.due.getTime() > now.getTime()) state = "coming";
    else if (now1?.key === s.key) state = "due";
    else if (latestDue?.key === s.key) state = "past";
    else state = "replaced";
    return { stage: s, key, state, rows: mine };
  });
  return { stages: views, abandonAt };
}

/** The abandon rows of a ticket or retail job (any status), for scheduleFor. */
export async function stageRows(tx: Db, shopId: string, ref: { ticketId?: string | null; jobId?: string | null }): Promise<OutMessage[]> {
  if (!ref.ticketId && !ref.jobId) return [];
  return tx.outMessage.findMany({
    where: { shopId, kind: "abandon", refType: "stage", ...(ref.ticketId ? { ticketId: ref.ticketId } : { repairJobId: ref.jobId }) },
    orderBy: { createdAt: "asc" },
  });
}

/** The merge fields a stage's wording adds to the ticket's or job's own: when it was ready, the abandon date, the fee. */
export function abandonVars(t: AbandonTarget): Record<string, string> {
  return {
    ...t.vars,
    ready_date: fmtDay(t.start, t.tz),
    abandon_date: fmtDay(abandonDate(t.start, t.abandonedAfterDays, t.tz), t.tz),
    storage_fee: money(t.storageFeeCents),
  };
}
