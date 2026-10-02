// Vac Shop home (modules-design.md 10.0): the tabs, five short cards, "Check in a vacuum", the counts, and for admins
// the number of vacuums that may be filed as sewing machines.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { OPEN_STATUSES } from "@/lib/constants";
import { brandMatches, VACUUM_BRANDS } from "@/lib/equipment/vacuum";
import { bagsDueCount } from "@/lib/vac/bags-due";
import { siteJobsBetween } from "@/lib/vac/installs";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, dayStart, weekStart, ymdOf } from "@/lib/zoned";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

const CARDS: { href: string; title: string; text: string }[] = [
  { href: "/tickets?kind=vacuum", title: "Repairs", text: "Vacuum tickets: intake with bag type and power, the vacuum checklist, suction and amp readings." },
  { href: "/vac/finder", title: "Finder", text: "Which bags, belts and filters fit a model, from your stock and the community's cross-references." },
  { href: "/vac/units", title: "For sale", text: "New, used and trade-in vacuums with serials and warranties, sold at the register." },
  { href: "/vac/bags-due", title: "Bags due", text: "Customers whose bagged vacuum is due for bags, to call or remind." },
  { href: "/vac/installs", title: "Installs", text: "Central vac installs: the site, the quote, the schedule and the checklist." },
];

export default async function VacHome() {
  const user = await requireUser();
  const s = await vacPageState(user);
  const shopId = user.shopId;
  const tz = await shopTimeZone(shopId);
  const today = ymdOf(new Date(), tz);
  const week = weekStart(today);
  const [open, inStock, bagsDue, installs, misfiled] = await Promise.all([
    db.ticket.count({ where: { shopId, status: { in: OPEN_STATUSES }, machine: { equipment: "VACUUM" } } }),
    db.stockUnit.count({ where: { shopId, status: "IN_STOCK" } }),
    bagsDueCount(shopId),
    siteJobsBetween(shopId, dayStart(week, tz), dayStart(addDays(week, 7), tz)).then((l) => l.length),
    s.admin
      ? db.machine.findMany({ where: { shopId, equipment: "SEWING", OR: [{ brand: { in: VACUUM_BRANDS, mode: "insensitive" } }, { machineType: { contains: "vac", mode: "insensitive" } }] }, select: { brand: true, machineType: true } }).then((rows) => rows.filter((m) => brandMatches(m.brand) || /vac/i.test(m.machineType ?? "")).length)
      : Promise.resolve(0),
  ]);
  const counts: Record<string, string> = {
    Repairs: `${open} open ticket${open === 1 ? "" : "s"}`,
    "For sale": `${inStock} in stock`,
    "Bags due": `${bagsDue} due`,
    Installs: `${installs} this week`,
  };
  return (
    <VacFrame title="Vac Shop" tab={null} needsRegister {...s}>
      {s.shop.doesRepair && s.gate === "write" && (
        <div>
          <Link href="/tickets/new?kind=vacuum" className="btn btn-primary">
            Check in a vacuum
          </Link>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {CARDS.map((c) => (
          <Link key={c.href} href={c.href} className="card card-pad block hover:bg-surface-2">
            <div className="font-semibold">{c.title}</div>
            <div className="muted text-sm">{c.text}</div>
            {counts[c.title] && <div className="mt-2 text-sm">{counts[c.title]}</div>}
          </Link>
        ))}
      </div>
      {s.admin && misfiled > 0 && (
        <p className="card card-pad text-sm">
          {misfiled} vacuum{misfiled === 1 ? "" : "s"} may be filed as sewing machines.{" "}
          <Link href="/vac/convert" className="link">
            Have a look
          </Link>
        </p>
      )}
    </VacFrame>
  );
}
