// Under a machine's heading on its page and its repair tickets (modules-design.md 10.c; every kind since
// tax-machine-sales-layaway-design.md section 3, "warranty at intake"): "Sold here Mar 12, 2026 · warranty through
// Mar 12, 2027 (Brother) · not registered yet", the maker's terms as the shop typed them, and its service plans
// ("Covered: Free yearly cleaning (1 of 3 used), through ..."), so the tech knows before quoting. "In stock · $499" or
// "Traded in on sale #1042" for a unit still for sale. A machine with no unit whose latest ticket was abandoned gets
// "Put up for sale" for admins while its kind may be sold.
import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDate, money } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { UNIT_STATUS_LABEL, UNIT_STATUS_TONE } from "@/lib/constants";
import { canWorkOn } from "@/lib/equipment/gate";
import { machinePlansFor } from "@/lib/units/plans";
import { fmtYmdLong, makerTermsFor, termsOf, termsText, warrantyThrough } from "@/lib/units/units";
import { unitFromAbandoned } from "@/actions/units";
import { ActionButton } from "@/components/action-form";

/** `at`: the day that counts (a ticket's intake), for which plans and warranty were in force. */
export async function UnitBadge({ machineId, user, at }: { machineId: string; user: CurrentUser; at?: Date }) {
  const shopId = user.shopId;
  const tz = await shopTimeZone(shopId);
  const [unit, machine, plans] = await Promise.all([
    db.stockUnit.findFirst({ where: { machineId, shopId } }),
    db.machine.findFirst({ where: { id: machineId, shopId }, select: { brand: true, equipment: true } }),
    machinePlansFor(shopId, machineId, tz, at),
  ]);
  if (!machine) return null;
  const covered = plans.filter((p) => p.current);
  const planLine = covered.length > 0 && (
    <p className="text-sm">
      <span className="pill tone-ready">Covered: {covered.map((p) => p.text).join("; ")}</span>
    </p>
  );
  if (!unit) {
    if (user.role === "TECH") return planLine || null;
    const last = await db.ticket.findFirst({ where: { machineId, shopId }, orderBy: { intakeAt: "desc" }, select: { status: true, number: true } });
    if (last?.status !== "ABANDONED" || !(await canWorkOn(shopId, machine.equipment))) return planLine || null;
    return (
      <>
        {planLine}
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="pill tone-bad">Abandoned (ticket #{last.number})</span>
          <ActionButton action={unitFromAbandoned.bind(null, machineId)} className="btn btn-sm" confirm="Put this machine up for sale as Used? Its cost will be the ticket's unpaid balance. You can change the price after.">
            Put up for sale
          </ActionButton>
        </p>
      </>
    );
  }
  const parts: string[] = [];
  let terms: string | null = null;
  if (unit.status === "SOLD") {
    parts.push(`Sold here${unit.soldAt ? ` ${fmtDate(unit.soldAt, tz)}` : ""}`);
    const now = at ?? new Date();
    if (unit.warrantyUntil) parts.push(`${now < unit.warrantyUntil ? "warranty through" : "warranty ended"} ${fmtYmdLong(warrantyThrough(unit.warrantyUntil, tz))}${unit.warrantyBy ? ` (${unit.warrantyBy})` : ""}`);
    parts.push(unit.registeredAt ? `registered ${fmtDate(unit.registeredAt, tz)}` : "not registered yet");
    const maker = termsOf(await makerTermsFor(shopId, [machine.brand]), machine.brand);
    if (maker && termsText(maker)) terms = `${maker.brand}'s warranty, as you noted it: ${termsText(maker)}`;
  } else if (unit.tradeInLineId && unit.status === "IN_STOCK") {
    const line = await db.saleLine.findFirst({ where: { id: unit.tradeInLineId, sale: { shopId } }, select: { sale: { select: { number: true } } } });
    parts.push(line ? `Traded in on sale #${line.sale.number}` : "Traded in");
    parts.push(unit.priceCents != null ? money(unit.priceCents) : "no price yet");
  } else {
    parts.push(UNIT_STATUS_LABEL[unit.status] ?? unit.status);
    if (unit.status === "IN_STOCK") parts.push(unit.priceCents != null ? money(unit.priceCents) : "no price yet");
  }
  return (
    <>
      <p className="text-sm">
        <Link href={`/units/${unit.id}`} className={`pill tone-${UNIT_STATUS_TONE[unit.status] ?? "neutral"}`}>
          {parts.join(" · ")}
        </Link>
        {terms && <span className="muted ml-2">{terms}</span>}
      </p>
      {planLine}
    </>
  );
}
