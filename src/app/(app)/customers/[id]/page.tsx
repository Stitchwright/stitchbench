import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money, ticketNo } from "@/lib/format";
import { ticketTotals } from "@/lib/ticket-math";
import { PageHeader, Section, StatusPill, Empty } from "@/components/ui";
import { CustomerForm } from "@/components/customer-form";
import { saveCustomer } from "@/actions/records";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const c = await db.customer.findFirst({
    where: { id, shopId: user.shopId },
    include: {
      machines: { orderBy: { createdAt: "desc" } },
      tickets: { where: { shopId: user.shopId }, orderBy: { intakeAt: "desc" }, include: { machine: true, lines: true, payments: true } },
      viaTickets: { where: { shopId: user.shopId }, orderBy: { intakeAt: "desc" }, include: { machine: true, customer: true, lines: true, payments: true } },
    },
  });
  if (!c) notFound();
  // Machines from a partner sewing shop earn it the partnership's commission (as billed on the statement).
  const partnerCommission = new Map(
    (await db.repairJob.findMany({ where: { shopId: user.shopId, side: "repair", ticketId: { in: c.viaTickets.map((t) => t.id) } }, select: { ticketId: true, commissionCents: true } })).map(
      (j) => [j.ticketId!, j.commissionCents],
    ),
  );
  const tickets = c.kind === "TRADE" ? c.viaTickets : c.tickets;
  const owed = tickets.reduce((s, t) => s + Math.max(0, ticketTotals(t.lines, t.payments, t.taxRatePct).balance), 0);
  const commission =
    c.kind === "TRADE"
      ? c.viaTickets.filter((t) => t.status === "COLLECTED").reduce((s, t) => s + ticketTotals(t.lines, t.payments, t.taxRatePct, c.commissionPct, partnerCommission.get(t.id)).commission, 0)
      : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/customers", label: "Customers" }}
        title={c.name}
        sub={
          <>
            {c.kind === "TRADE" ? `Shop account ${c.code ?? ""}${c.routeDay ? ` · route day ${c.routeDay}` : ""}` : "Retail customer"}
            {owed > 0 && ` · ${money(owed)} owed`}
            {commission > 0 && ` · ${money(commission)} commission earned on collected tickets`}
          </>
        }
        actions={
          c.kind === "RETAIL" ? (
            <Link href={`/tickets/new?customerId=${c.id}`} className="btn btn-primary">
              Check in a machine
            </Link>
          ) : undefined
        }
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title={c.kind === "TRADE" ? "Tickets through this shop" : "Tickets"}>
          {tickets.length === 0 ? (
            <Empty>No tickets yet.</Empty>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {tickets.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex items-center gap-2">
                    <Link href={`/tickets/${t.id}`} className="link mono">
                      #{ticketNo(t.number)}
                    </Link>
                    {t.machine.brand} {t.machine.model}
                    {"customer" in t && t.customer ? <span className="muted">({(t.customer as { name: string }).name})</span> : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="num muted">{fmtDate(t.intakeAt)}</span>
                    <StatusPill status={t.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        {c.kind === "RETAIL" && (
          <Section title="Machines">
            {c.machines.length === 0 ? (
              <Empty>None on file.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {c.machines.map((m) => (
                  <li key={m.id} className="py-2">
                    <Link href={`/machines/${m.id}`} className="link">
                      {m.brand} {m.model}
                    </Link>{" "}
                    {m.serial && <span className="mono muted">SN {m.serial}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
        <Section title="Details">
          <CustomerForm action={saveCustomer.bind(null, c.id)} customer={c} submitLabel="Save" />
        </Section>
      </div>
    </div>
  );
}
