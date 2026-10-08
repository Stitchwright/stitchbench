import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { IN_CUSTODY, OPEN_STATUSES, STATUS_LABEL, STATUS_ORDER } from "@/lib/constants";
import { money, ticketNo, fmtDate } from "@/lib/format";
import { PageHeader, Section, StatusPill, Empty } from "@/components/ui";
import { MarketTodo } from "@/components/market-todo";
import { MarginFloorNotice } from "@/components/margin-floor-notice";
import { PAID_ELSEWHERE } from "@/lib/sales";
import { monthRange, startOfToday } from "@/lib/time-zone";
import { registerTakenCents } from "@/lib/register-day";
import { shopTimeZone } from "@/lib/shop-zone";
import { PartnerTodo } from "@/components/partner-todo";
import { DashboardRunsSlot } from "@/components/slots/dashboard-runs";
import { TodaySlot } from "@/components/slots/today";
import { EstimatesTodoSlot } from "@/components/slots/estimates-todo";
import { TodoLinesSlot } from "@/components/slots/todo-lines";
import { redirect } from "next/navigation";
import { shopKinds } from "@/lib/equipment/shop";
import { withArticle, type EquipmentKind } from "@/lib/equipment/types";

// The low-stock list shows this many; the rest is one click away on the Parts page.
const LOW_STOCK_SHOWN = 50;

function daysSince(d: Date) {
  return (Date.now() - d.getTime()) / 86400000;
}

export default async function Dashboard() {
  const user = await requireUser();
  const shopId = user.shopId;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
  // A sewing shop without a repair bench starts at the register, before any of the bench's queries run.
  if (!shop.doesRepair) redirect("/register");
  const tz = await shopTimeZone(shopId);
  const today = monthRange(null, null, tz); // the shop's own day, [start, end)
  const low = { shopId, qtyOnHand: { lte: db.part.fields.reorderAt } };
  const [open, lowStock, lowCount, todayPay, todaySales, kinds] = await Promise.all([
    // Bench tickets only: central vac installs aren't in custody, on the status tiles or in the storage-fee list.
    db.ticket.findMany({
      where: { shopId, jobType: "BENCH", status: { in: OPEN_STATUSES } },
      include: { machine: true, customer: true, viaAccount: true },
      orderBy: { intakeAt: "asc" },
    }),
    // At or below the reorder point, found in the database, and only what the list shows.
    db.part.findMany({ where: low, select: { id: true, partNumber: true, description: true, qtyOnHand: true }, orderBy: { partNumber: "asc" }, take: LOW_STOCK_SHOWN }),
    db.part.count({ where: low }),
    // "Taken today" is the drawer and card reader: not what a partner shop collected at its counter or billed on account.
    db.payment.aggregate({
      where: { ticket: { shopId }, paidAt: { gte: startOfToday(tz) }, method: { notIn: PAID_ELSEWHERE } },
      _sum: { amountCents: true },
    }),
    // Register sales, net of returns and voids, by the shop's own day: the Register sales total.
    shop.sellsRetail ? registerTakenCents(shopId, today.start, today.end) : Promise.resolve(0),
    shopKinds(shopId),
  ]);
  const takenToday = (todayPay._sum.amountCents ?? 0) + todaySales;
  // One "Check in a machine" button while only sewing machines come in; otherwise up to three: the shop's usual kind,
  // sewing, then the rest in the usual order.
  const checkIn: EquipmentKind[] = [];
  for (const k of [kinds.usable.find((k) => k.key === shop.checkInKind), kinds.usable.find((k) => k.key === "sewing"), ...kinds.usable]) {
    if (k && !checkIn.includes(k)) checkIn.push(k);
  }
  checkIn.splice(3);

  const byStatus = new Map(STATUS_ORDER.map((s) => [s, 0]));
  for (const t of open) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  const custody = open.filter((t) => IN_CUSTODY.includes(t.status)).length;
  const ready = open.filter((t) => t.status === "READY_FOR_PICKUP" || t.status === "READY_IN_TRUCK");
  const overdue = ready.filter((t) => t.readyAt && daysSince(t.readyAt) > shop.abandonedAfterDays);

  return (
    <div className="space-y-6">
      <PageHeader
        title={shop.sellsRetail ? shop.name : "Bench"}
        sub={`${custody} machine${custody === 1 ? "" : "s"} in our custody · ${open.length} open ticket${open.length === 1 ? "" : "s"} · ${money(takenToday)} taken today`}
        actions={
          kinds.usable.length <= 1 ? (
            <Link href="/tickets/new" className="btn btn-primary">
              Check in a machine
            </Link>
          ) : (
            checkIn.map((k, i) => (
              <Link key={k.key} href={`/tickets/new?kind=${encodeURIComponent(k.key)}`} className={`btn ${i === 0 ? "btn-primary" : ""}`}>
                Check in {withArticle(k.noun)}
              </Link>
            ))
          )
        }
      />
      {user.role !== "TECH" && <MarginFloorNotice shopId={shopId} />}

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {STATUS_ORDER.filter((s) => OPEN_STATUSES.includes(s)).map((s) => (
          <Link key={s} href={s === "WAITING_PARTS" ? "/parts/on-order" : `/tickets?status=${s}`} className="card card-pad hover:border-navy">
            <div className="num text-2xl font-semibold">{byStatus.get(s)}</div>
            <div className="muted text-xs">{STATUS_LABEL[s]}</div>
          </Link>
        ))}
      </div>

      <MarketTodo shopId={shopId} />
      <PartnerTodo shopId={shopId} />
      <DashboardRunsSlot user={user} />
      <TodaySlot user={user} place="dashboard" />
      <EstimatesTodoSlot user={user} />
      <TodoLinesSlot user={user} />

      {overdue.length > 0 && (
        <div className="card card-pad tone-bad">
          <strong>{overdue.length} machine{overdue.length === 1 ? "" : "s"}</strong> ready more than {shop.abandonedAfterDays} days. The storage fee applies:{" "}
          {overdue.map((t, i) => (
            <span key={t.id}>
              {i > 0 && ", "}
              <Link className="underline" href={`/tickets/${t.id}`}>
                #{ticketNo(t.number)}
              </Link>
            </span>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title="Open tickets">
            {open.length === 0 ? (
              <Empty>Nothing on the bench. Check in a machine to start a ticket.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Machine</th>
                      <th>Customer</th>
                      <th>Status</th>
                      <th>In</th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.map((t) => (
                      <tr key={t.id}>
                        <td className="mono">
                          <Link className="link" href={`/tickets/${t.id}`}>
                            {ticketNo(t.number)}
                          </Link>
                        </td>
                        <td>
                          {t.machine.brand} {t.machine.model}
                          {t.machine.serial && <div className="muted mono text-xs">SN {t.machine.serial}</div>}
                        </td>
                        <td>
                          {t.customer?.name ?? "-"}
                          {t.viaAccount && <div className="muted text-xs">via {t.viaAccount.code ?? t.viaAccount.name}</div>}
                        </td>
                        <td>
                          <StatusPill status={t.status} />
                        </td>
                        <td className="num whitespace-nowrap">{fmtDate(t.intakeAt, tz)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
        <Section
          title="Low stock"
          actions={
            <Link href="/parts" className="link text-sm">
              All parts
            </Link>
          }
        >
          {lowStock.length === 0 ? (
            <Empty>Every part is above its reorder point.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {lowStock.map((p) => (
                <li key={p.id} className="flex justify-between gap-2">
                  <Link href={`/parts/${p.id}`} className="link min-w-0 truncate">
                    <span className="mono">{p.partNumber}</span> {p.description}
                  </Link>
                  <span className={`pill ${p.qtyOnHand <= 0 ? "tone-bad" : "tone-wait"}`}>{p.qtyOnHand} left</span>
                </li>
              ))}
            </ul>
          )}
          {lowCount > lowStock.length && (
            <p className="muted mt-2 text-sm">
              and {lowCount - lowStock.length} more.{" "}
              <Link href="/parts?low=1" className="link">
                See them all
              </Link>
            </p>
          )}
        </Section>
      </div>
    </div>
  );
}
