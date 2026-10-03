import "server-only";
// The equipment gate: tickets, machines and photos belong to a module through Machine.equipment (VACUUM -> vac,
// APPLIANCE -> appliance; SEWING is free). New work needs the module active; work that came in before a module ended
// can be finished (modules-design.md D3 and section 6.3).
import type { TicketStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { CLOSING_STATUSES } from "@/lib/constants";
import { workable } from "@/lib/license";
import { blockedMessage, type ModuleState } from "@/lib/module-info";
import { getModules, isAdminWho, type Who } from "@/lib/modules";
import { EQUIPMENT_MODULE, isEquipment } from "./index";

export type TicketGate = { intakeAt: Date; status: TicketStatus };

const NEWER = "This record was made by a newer version of StitchBench. Update the program to change it.";
const CLOSING_HINT = " You can still mark it picked up, take payment and tick off what went back.";

/** The module state the equipment depends on; null = free (sewing). Unknown equipment -> a state that blocks. */
export async function equipmentState(shopId: string, equipment: string): Promise<ModuleState | null> {
  if (!isEquipment(equipment)) return null;
  const id = EQUIPMENT_MODULE[equipment];
  if (!id) return null;
  return (await getModules(shopId)).states[id];
}

/**
 * No ticket: may new work start (sewing, or the module active)? With a ticket: also true when the module has ended
 * (lapsed, endedAt set), the ticket was opened before endedAt, and it isn't in CLOSING_STATUSES.
 */
export async function canWorkOn(shopId: string, equipment: string, ticket?: TicketGate | null): Promise<boolean> {
  if (!isEquipment(equipment)) return false;
  const s = await equipmentState(shopId, equipment);
  if (!s) return true;
  if (s.active) return true;
  if (!ticket) return false;
  if (CLOSING_STATUSES.includes(ticket.status)) return false;
  return workable(s, ticket.intakeAt);
}

/** UserError(blockedMessage) unless canWorkOn. `closing` adds the "you can still close it out" hint. */
export async function requireEquipment(who: Who, equipment: string, o: { ticket?: TicketGate | null; closing?: boolean } = {}): Promise<void> {
  const shopId = typeof who === "string" ? who : who.shopId;
  if (!isEquipment(equipment)) throw new UserError(NEWER);
  if (await canWorkOn(shopId, equipment, o.ticket)) return;
  const s = await equipmentState(shopId, equipment);
  if (!s) return;
  throw new UserError(blockedMessage(s, isAdminWho(who)) + (o.closing ? CLOSING_HINT : ""));
}

/** The ticket by { id, shopId } (intakeAt, status, machine.equipment), then canWorkOn with it. False when not found. */
export async function ticketWorkable(shopId: string, ticketId: string): Promise<boolean> {
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId }, select: { intakeAt: true, status: true, machine: { select: { equipment: true } } } });
  if (!t) return false;
  return canWorkOn(shopId, t.machine.equipment, t);
}

/** Machine-level edits and photos without a ticket: canWorkOn(equipment), or an open ticket of this machine that is workable. */
export async function machineWorkable(shopId: string, machineId: string): Promise<boolean> {
  const m = await db.machine.findFirst({ where: { id: machineId, shopId }, select: { equipment: true } });
  if (!m) return false;
  if (await canWorkOn(shopId, m.equipment)) return true;
  const open = await db.ticket.findMany({ where: { machineId, shopId, status: { notIn: CLOSING_STATUSES } }, select: { intakeAt: true, status: true } });
  for (const t of open) if (await canWorkOn(shopId, m.equipment, t)) return true;
  return false;
}
