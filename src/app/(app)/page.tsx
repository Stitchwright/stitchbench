import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { IN_CUSTODY, OPEN_STATUSES, STATUS_LABEL, STATUS_ORDER } from "@/lib/constants";
import { money, ticketNo, fmtDate } from "@/lib/format";
import { PageHeader, Section, StatusPill, Empty } from "@/components/ui";
import { MarketTodo } from "@/components/market-todo";
import { startOfToday } from "@/lib/sales";
import { PartnerTodo } from "@/components/partner-todo";
import { redirect } from "next/navigation";

function daysSince(d: Date) {
  return (Date.now() - d.getTime()) / 86400000;
}

export default async function Dashboard() {
  const user = await requireUser();
  const shopId = user.shopId;
  const tz = (await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } })).timeZone;
  const [shop, open, lowStock, todayPay] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shopId } }),
    db.ticket.findMany({
      where: { shopId, status: { in: OPEN_STATUSES } },
      include: { machine: true, customer: true, viaAccount: true },
      orderBy: { intakeAt: "asc" },
    }),
    db.part.findMany({ where: { shopId }, orderBy: { partNumber: "asc" } }).then((ps) => ps.filter((p) => p.qtyOnHand <= p.reorderAt)),
    db.payment.aggregate({
      where: { ticket: { shopId }, paidAt: { gte: startOfToday(tz) } },
      _sum: { amountCents: true },
    }),
  ]);
  // A sewing shop without a repair bench starts at the register.
  if (!shop.doesRepair) redirect("/register");

  const byStatus = new Map(STATUS_ORDER.map((s) => [s, 0]));
  for (const t of open) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  const custody = open.filter((t) => IN_CUSTODY.includes(t.status)).length;
  const ready = open.filter((t) => t.status === "READY_FOR_PICKUP" || t.status === "READY_IN_TRUCK");
  const overdue = ready.filter((t) => t.readyAt && daysSince(t.readyAt) > shop.abandonedAfterDays);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bench"
        sub={`${custody} machine${custody === 1 ? "" : "s"} in our custody · ${open.length} open ticket${open.length === 1 ? "" : "s"} · ${money(todayPay._sum.amountCents ?? 0)} taken today`}
        actions={
          <Link href="/tickets/new" className="btn btn-primary">
            Check in a machine
          </Link>
        }
      />

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {STATUS_ORDER.filter((s) => OPEN_STATUSES.includes(s)).map((s) => (
          <Link key={s} href={`/tickets?status=${s}`} className="card card-pad hover:border-navy">
            <div className="num text-2xl font-semibold">{byStatus.get(s)}</div>
            <div className="muted text-xs">{STATUS_LABEL[s]}</div>
          </Link>
        ))}
      </div>

      <MarketTodo shopId={shopId} />
      <PartnerTodo shopId={shopId} />

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
                        <td className="num whitespace-nowrap">{fmtDate(t.intakeAt)}</td>
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
        </Section>
      </div>
    </div>
  );
}
