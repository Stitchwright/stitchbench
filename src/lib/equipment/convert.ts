import "server-only";
// Changing what a machine is across equipments (a vacuum logged as a sewing machine years ago): admin only, the source
// workable and the target kind usable, never a unit for sale, never with work on an open ticket (modules-design.md 9.5).
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { CLOSING_STATUSES } from "@/lib/constants";
import type { CurrentUser } from "@/lib/session";
import { requireModule } from "@/lib/modules";
import { str } from "@/lib/format";
import { machineWorkable } from "./gate";
import { kindOf, usableKind } from "./shop";

export async function convertMachineKindFor(user: CurrentUser, machineId: string, fd: FormData) {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can change this.");
  const m = await db.machine.findFirst({ where: { id: machineId, shopId: user.shopId }, select: { id: true, equipment: true, kind: true, machineType: true, stock: { select: { id: true } } } });
  if (!m) throw new UserError("Machine not found.");
  const from = await kindOf(user.shopId, m);
  if (!(await machineWorkable(user.shopId, m.id))) throw new UserError(`${from.label}: its module has ended, so it can't be changed into something else.`);
  const target = await usableKind(user.shopId, str(fd.get("kind")));
  if (!target) throw new UserError("Pick what it is.");
  if (target.module) await requireModule(user, target.module);
  if (m.stock) throw new UserError("It's in Vac Shop → For sale.");
  const busy = await db.ticket.findFirst({
    where: { machineId: m.id, shopId: user.shopId, status: { notIn: CLOSING_STATUSES }, OR: [{ lines: { some: {} } }, { payments: { some: {} } }] },
    select: { id: true },
  });
  if (busy) throw new UserError(`It has work on an open ticket. Close that ticket first, or check it in again as ${target.noun.startsWith("a") ? "an" : "a"} ${target.noun}.`);
  await db.machine.updateMany({
    where: { id: m.id, shopId: user.shopId },
    data: { equipment: target.equipment, kind: target.key, machineType: m.machineType && target.types.includes(m.machineType) ? m.machineType : null },
  });
  const tickets = await db.ticket.findMany({ where: { machineId: m.id, shopId: user.shopId }, select: { id: true } });
  revalidatePath(`/machines/${m.id}`);
  for (const t of tickets) revalidatePath(`/tickets/${t.id}`);
  revalidatePath("/tickets");
  revalidatePath("/machines");
}
