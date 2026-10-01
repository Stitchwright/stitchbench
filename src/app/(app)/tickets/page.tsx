import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { firstValues } from "@/lib/search-params";
import { OPEN_STATUSES, STATUS_LABEL, STATUS_ORDER } from "@/lib/constants";
import { fmtDate, money, ticketNo } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { ticketTotals } from "@/lib/ticket-math";
import { shopKinds } from "@/lib/equipment/shop";
import { PageHeader, StatusPill, Empty } from "@/components/ui";
import { KindChips } from "@/components/equipment/kind-chips";
import type { TicketStatus } from "@/generated/prisma/enums";

export default async function TicketsPage({ searchParams }: { searchParams: Promise<{ status?: string; all?: string; kind?: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const sp = firstValues(await searchParams);
  const status = STATUS_ORDER.includes(sp.status as TicketStatus) ? (sp.status as TicketStatus) : undefined;
  const all = sp.all === "1";
  // The kinds to filter by: those that may take new work, plus any a ticket here already has (a module that ended).
  const [kinds, used] = await Promise.all([
    shopKinds(user.shopId),
    db.machine.findMany({ where: { shopId: user.shopId, tickets: { some: {} } }, distinct: ["kind"], select: { kind: true } }),
  ]);
  const usedKeys = new Set(used.map((m) => m.kind));
  const chipKinds = kinds.all.filter((k) => usedKeys.has(k.key) || kinds.usable.some((u) => u.key === k.key));
  const kind = chipKinds.some((k) => k.key === sp.kind) ? sp.kind! : undefined;
  // Bench tickets only: central vac installs have their own list.
  const tickets = await db.ticket.findMany({
    where: { shopId: user.shopId, jobType: "BENCH", status: status ? status : all ? undefined : { in: OPEN_STATUSES }, ...(kind ? { machine: { kind } } : {}) },
    include: { machine: true, customer: true, viaAccount: true, lines: true, payments: true },
    orderBy: { number: "desc" },
    take: 300,
  });
  // The status links keep the kind filter, and the kind chips keep the status filter.
  const link = (o: { status?: TicketStatus; all?: boolean; kind?: string | null }) => {
    const q = [o.status ? `status=${o.status}` : o.all ? "all=1" : "", o.kind ? `kind=${encodeURIComponent(o.kind)}` : ""].filter(Boolean).join("&");
    return `/tickets${q ? `?${q}` : ""}`;
  };

  return (
    <div>
      <PageHeader
        title="Tickets"
        sub={status ? STATUS_LABEL[status] : all ? "All tickets (latest 300)" : "Open tickets"}
        actions={
          <Link href={kind ? `/tickets/new?kind=${encodeURIComponent(kind)}` : "/tickets/new"} className="btn btn-primary">
            Check in a machine
          </Link>
        }
      />
      <div className="no-print mb-4 flex flex-wrap gap-2 text-sm">
        <Link href={link({ kind })} className={`btn btn-sm ${!status && !all ? "btn-primary" : ""}`}>
          Open
        </Link>
        {STATUS_ORDER.map((s) => (
          <Link key={s} href={link({ status: s, kind })} className={`btn btn-sm ${status === s ? "btn-primary" : ""}`}>
            {STATUS_LABEL[s]}
          </Link>
        ))}
        <Link href={link({ all: true, kind })} className={`btn btn-sm ${all ? "btn-primary" : ""}`}>
          All
        </Link>
      </div>
      {chipKinds.length > 1 && (
        <div className="no-print mb-4 flex flex-wrap items-center gap-2 text-sm">
          <Link href={link({ status, all })} className={`btn btn-sm ${!kind ? "btn-primary" : ""}`}>
            Every kind
          </Link>
          <KindChips kinds={chipKinds} active={kind ?? null} hrefFor={(key) => link({ status, all, kind: key })} />
        </div>
      )}
      <div className="card">
        {tickets.length === 0 ? (
          <div className="card-pad">
            <Empty>No tickets here.</Empty>
          </div>
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
                  <th className="text-right">Total</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => {
                  const tot = ticketTotals(t.lines, t.payments, t.taxRatePct);
                  return (
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
                      <td className="num text-right">{money(tot.total)}</td>
                      <td className={`num text-right ${tot.balance > 0 ? "font-semibold" : "muted"}`}>{money(tot.balance)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
