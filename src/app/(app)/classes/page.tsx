// Classes and workshops: the list (scheduling-messaging-design.md 12.1). Tabs Upcoming / Past / Cancelled.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";
import { CLASS_STATUS_LABEL, CLASS_STATUS_TONE } from "@/lib/constants";
import { nextMeetings, seatCounts } from "@/lib/classes";
import { ModuleOff } from "@/components/module-off";
import { Empty, PageHeader } from "@/components/ui";

type Tab = "upcoming" | "past" | "cancelled";

export default async function ClassesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const { tab: tabRaw } = await searchParams;
  const tab: Tab = tabRaw === "past" || tabRaw === "cancelled" ? tabRaw : "upcoming";
  const admin = user.role !== "TECH" && gate === "on";
  const now = new Date();
  const [shop, tz] = await Promise.all([db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { sellsRetail: true } }), shopTimeZone(shopId)]);
  const where =
    tab === "cancelled"
      ? { shopId, status: "CANCELLED" }
      : tab === "past"
        ? { shopId, status: { not: "CANCELLED" }, lastAt: { lt: now } }
        : { shopId, status: { not: "CANCELLED" }, OR: [{ lastAt: null }, { lastAt: { gte: now } }] };
  const classes = await db.shopClass.findMany({ where, orderBy: tab === "past" ? { lastAt: "desc" } : { firstAt: "asc" }, take: 200, include: { _count: { select: { meetings: { where: { cancelled: false } } } } } });
  const [counts, next] = await Promise.all([seatCounts(db, classes.map((c) => c.id)), nextMeetings(db, classes.map((c) => c.id), now)]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Classes"
        sub={!shop.sellsRetail ? "Classes are for shops with the counter: turn 'sells retail' on in Settings." : undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/classes/print" className="btn">
              Print this month
            </Link>
            {admin && shop.sellsRetail && (
              <>
                <Link href="/classes/new" className="btn btn-primary">
                  New class
                </Link>
                <Link href="/classes/new?kind=RETREAT" className="btn">
                  New retreat or event
                </Link>
              </>
            )}
          </div>
        }
      />
      {gate === "readonly" && <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />}
      <div className="flex flex-wrap gap-2 text-sm" role="navigation" aria-label="Classes">
        {(["upcoming", "past", "cancelled"] as Tab[]).map((t) => (
          <Link key={t} href={t === "upcoming" ? "/classes" : `/classes?tab=${t}`} className={`btn btn-sm ${tab === t ? "btn-primary" : ""}`} aria-current={tab === t ? "page" : undefined}>
            {t === "upcoming" ? "Upcoming" : t === "past" ? "Past" : "Cancelled"}
          </Link>
        ))}
      </div>
      {classes.length === 0 ? (
        <Empty>{tab === "upcoming" ? "No classes coming up." : tab === "past" ? "No past classes." : "No cancelled classes."}</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Class</th>
                <th>Next meeting</th>
                <th className="num">Meetings</th>
                <th>Teacher</th>
                <th>Seats</th>
                <th className="num">Fee</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => {
                const k = counts.get(c.id) ?? { enrolled: 0, waiting: 0 };
                const n = next.get(c.id);
                return (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/classes/${c.id}`} className="link">
                        {c.title}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap">{n ? fmtWhen(n.startsAt, tz) : c.lastAt ? "Over" : "No meetings yet"}</td>
                    <td className="num">{c._count.meetings}</td>
                    <td>{c.teacher ?? ""}</td>
                    <td>
                      {k.enrolled} of {c.seats}
                      {k.waiting ? ` (${k.waiting} waiting)` : ""}
                    </td>
                    <td className="num">{c.feeCents ? money(c.feeCents) : "Free"}</td>
                    <td>
                      <span className={`pill tone-${CLASS_STATUS_TONE[c.status] ?? "neutral"}`}>{CLASS_STATUS_LABEL[c.status] ?? c.status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
