// "In stock · $499", "Sold here Oct 3, 2026 · warranty through Oct 3, 2027 (Miele) · registered Oct 5" or "Traded in
// on sale #1042" under a vacuum's heading (modules-design.md 10.c), linking to the unit. A vacuum with no unit whose
// latest ticket was abandoned gets "Put up for sale" for admins while Vac Shop is active.
import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDate, money } from "@/lib/format";
import { getModules } from "@/lib/modules";
import type { CurrentUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { UNIT_STATUS_LABEL, UNIT_STATUS_TONE } from "@/lib/constants";
import { fmtYmdLong, warrantyThrough } from "@/lib/vac/units";
import { unitFromAbandoned } from "@/actions/vac-units";
import { ActionButton } from "@/components/action-form";

export async function UnitBadge({ machineId, user }: { machineId: string; user: CurrentUser }) {
  const shopId = user.shopId;
  const [unit, tz] = await Promise.all([db.stockUnit.findFirst({ where: { machineId, shopId } }), shopTimeZone(shopId)]);
  if (!unit) {
    if (user.role === "TECH") return null;
    const [mods, last] = await Promise.all([getModules(shopId), db.ticket.findFirst({ where: { machineId, shopId }, orderBy: { intakeAt: "desc" }, select: { status: true, number: true } })]);
    if (!mods.states.vac.active || last?.status !== "ABANDONED") return null;
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="pill tone-bad">Abandoned (ticket #{last.number})</span>
        <ActionButton action={unitFromAbandoned.bind(null, machineId)} className="btn btn-sm" confirm="Put this vacuum up for sale as Used? Its cost will be the ticket's unpaid balance.">
          Put up for sale
        </ActionButton>
      </p>
    );
  }
  const parts: string[] = [];
  if (unit.status === "SOLD") {
    parts.push(`Sold here${unit.soldAt ? ` ${fmtDate(unit.soldAt, tz)}` : ""}`);
    if (unit.warrantyUntil) parts.push(`warranty through ${fmtYmdLong(warrantyThrough(unit.warrantyUntil, tz))}${unit.warrantyBy ? ` (${unit.warrantyBy})` : ""}`);
    parts.push(unit.registeredAt ? `registered ${fmtDate(unit.registeredAt, tz)}` : "not registered yet");
  } else if (unit.tradeInLineId && unit.status === "IN_STOCK") {
    const line = await db.saleLine.findFirst({ where: { id: unit.tradeInLineId, sale: { shopId } }, select: { sale: { select: { number: true } } } });
    parts.push(line ? `Traded in on sale #${line.sale.number}` : "Traded in");
    parts.push(unit.priceCents != null ? money(unit.priceCents) : "no price yet");
  } else {
    parts.push(UNIT_STATUS_LABEL[unit.status] ?? unit.status);
    if (unit.status === "IN_STOCK") parts.push(unit.priceCents != null ? money(unit.priceCents) : "no price yet");
  }
  return (
    <p className="text-sm">
      <Link href={`/vac/units/${unit.id}`} className={`pill tone-${UNIT_STATUS_TONE[unit.status] ?? "neutral"}`}>
        {parts.join(" · ")}
      </Link>
    </p>
  );
}
