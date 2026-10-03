import "server-only";
// A ticket's readings and intake answers for its kind (bodies of the saveReadings / saveIntake actions).
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { kickPartnerSync } from "@/lib/partners";
import { requireEquipment } from "./gate";
import { readAnswers, readReadings } from "./form";
import { kindOf } from "./shop";

async function workTicket(user: CurrentUser, ticketId: string) {
  const t = await db.ticket.findFirst({
    where: { id: ticketId, shopId: user.shopId },
    select: { id: true, intakeAt: true, status: true, intake: true, readings: true, machine: { select: { id: true, equipment: true, kind: true, details: true } } },
  });
  if (!t) throw new UserError("Ticket not found.");
  await requireEquipment(user, t.machine.equipment, { ticket: t, closing: true });
  return t;
}

function refresh(ticketId: string) {
  kickPartnerSync();
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/tickets");
  revalidatePath("/");
}

export async function saveReadingsFor(user: CurrentUser, ticketId: string, fd: FormData) {
  const t = await workTicket(user, ticketId);
  const kind = await kindOf(user.shopId, t.machine);
  const readings = readReadings(kind.readings, fd);
  await db.ticket.updateMany({ where: { id: t.id, shopId: user.shopId }, data: { readings } });
  refresh(t.id);
}

export async function saveIntakeFor(user: CurrentUser, ticketId: string, fd: FormData) {
  const t = await workTicket(user, ticketId);
  const kind = await kindOf(user.shopId, t.machine);
  const intake = readAnswers(kind.intakeFields, "ticket", fd, (t.intake as Record<string, unknown>) ?? {});
  const details = readAnswers(kind.intakeFields, "machine", fd, (t.machine.details as Record<string, unknown>) ?? {});
  await db.$transaction([
    db.ticket.updateMany({ where: { id: t.id, shopId: user.shopId }, data: { intake } }),
    db.machine.updateMany({ where: { id: t.machine.id, shopId: user.shopId }, data: { details } }),
  ]);
  refresh(t.id);
  revalidatePath(`/machines/${t.machine.id}`);
}
