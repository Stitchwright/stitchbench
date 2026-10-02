import "server-only";
// The customer's answer to an estimate, as the counter, a link or a text reply records it (design section 4.1).
import type { Prisma, RepairJob } from "@/generated/prisma/client";
import { sendToPartner, type JobEvent } from "@/lib/partners";
import type { HookCtx } from "@/lib/notices/context";
import { changeTicketStatus, type TicketForStatus } from "@/lib/ticket-status";
import { ticketWorkable } from "@/lib/equipment/gate";
import { money } from "@/lib/format";
import { fmtDateTime } from "@/lib/format";

export type AnswerVia = "counter" | "link" | "text reply" | "phone";

const viaText = (via: AnswerVia) => (via === "counter" ? "" : ` (by ${via})`);

/**
 * Retail side: records the answer on the partner job (only if nobody answered first) and tells the repair shop.
 * False when the job already had an answer or isn't waiting for one (the caller says so).
 */
export async function answerRetailEstimate(
  tx: Prisma.TransactionClient,
  a: { shopId: string; job: RepairJob; approval: "APPROVED" | "DECLINED"; approvedCents: number | null; note: string | null; byName: string; via: AnswerVia; at: Date },
): Promise<boolean> {
  const events = [
    ...((a.job.events as JobEvent[]) ?? []),
    { at: a.at.toISOString(), note: `Customer ${a.approval === "APPROVED" ? "approved" : "declined"}${a.note ? `: ${a.note}` : ""} (${a.byName})${viaText(a.via)}` },
  ];
  const r = await tx.repairJob.updateMany({
    where: { shopId: a.shopId, id: a.job.id, approval: null, status: "WAITING_CUSTOMER_OK" },
    data: { approval: a.approval, approvedCents: a.approvedCents, events: events as Prisma.InputJsonValue },
  });
  if (!r.count) return false;
  await sendToPartner(a.shopId, a.job.linkId, "job.reply", { id: a.job.id, approval: a.approval, approvedCents: a.approvedCents, note: a.note, name: a.byName, at: a.at.toISOString() }, tx);
  return true;
}

/**
 * A direct ticket: the answer goes into the notes; an approval sets approvedCents and moves a waiting ticket to the
 * bench (through changeTicketStatus, so the status hook runs). An approved install quote (jobType SITE) becomes Booked,
 * not In progress; a ticket whose module has ended keeps its status for staff to decide (modules-design.md 12.4 #4).
 */
export async function answerTicketEstimate(
  tx: Prisma.TransactionClient,
  a: { ticket: TicketForStatus & { notes: string | null }; warrantyDays: number; approval: "APPROVED" | "DECLINED"; approvedCents: number | null; note: string | null; via: AnswerVia; at: Date; tz: string; ctx: HookCtx },
): Promise<void> {
  const when = fmtDateTime(a.at, a.tz, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const line = `${when}: customer ${a.approval === "APPROVED" ? `approved${a.approvedCents != null ? ` ${money(a.approvedCents)}` : ""}` : "declined"} by ${a.via}.${a.note ? ` Note: ${a.note}` : ""}`;
  await tx.ticket.updateMany({
    where: { id: a.ticket.id, shopId: a.ticket.shopId },
    data: {
      notes: [a.ticket.notes, line].filter(Boolean).join("\n").slice(-20_000),
      estimateAnswer: a.approval,
      estimateAnsweredAt: a.at,
      ...(a.approval === "APPROVED" && a.approvedCents != null ? { approvedCents: a.approvedCents } : {}),
    },
  });
  if (a.approval === "APPROVED" && a.ticket.status === "WAITING_CUSTOMER_OK") {
    const site = (await tx.ticket.findFirst({ where: { id: a.ticket.id, shopId: a.ticket.shopId }, select: { jobType: true } }))?.jobType === "SITE";
    if (await ticketWorkable(a.ticket.shopId, a.ticket.id)) {
      await changeTicketStatus(tx, a.ticket, site ? "AT_SHOP_AWAITING_PICKUP" : "ON_BENCH", a.at, a.warrantyDays, a.ctx);
    }
  }
}
