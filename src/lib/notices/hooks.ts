/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the notices package fills in the bodies */
import "server-only";
// Where automatic notices hang off ticket and job changes (scheduling-messaging-design.md section 7.1). Foundation
// stub (owner: notices): the exported names and signatures are a contract; only the bodies change.
import type { Prisma, OutMessage } from "@/generated/prisma/client";
import type { TicketStatus } from "@/generated/prisma/enums";
import type { TicketForStatus } from "@/lib/ticket-status";
import type { HookCtx } from "@/lib/notices/context";

type Tx = Prisma.TransactionClient;

export type JobForHook = { id: string; shopId: string; linkId: string; customerId: string | null; status: string; backAt: Date | null; pickedUpAt: Date | null };

/**
 * Inside the transaction that changed a ticket's status (only when it really changed). Returns the line for the staff
 * toast ("A text goes to Mary Smith at 10:44 am...") or null. Never opens another connection: use tx and ctx.
 */
export async function onTicketStatus(tx: Tx, t: TicketForStatus, status: TicketStatus, at: Date, ctx: HookCtx): Promise<string | null> {
  return null;
}

/** Retail side, inside the transaction that applied a partner's job.update whose status changed. */
export async function onJobStatus(tx: Tx, job: JobForHook, status: string, at: Date, ctx: HookCtx): Promise<void> {}

/** Retail side: these jobs are back at our counter (a run's delivered list, "It's back"). `backAt` is already set. */
export async function onJobsBack(tx: Tx, shopId: string, jobIds: string[], at: Date, byUserId: string | null, ctx: HookCtx): Promise<string | null> {
  return null;
}

/** Worker, right before sending: a reason to cancel ("The machine was picked up"), or null to send. */
export async function stillWanted(row: OutMessage): Promise<string | null> {
  return null;
}
