import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money, ticketNo, fmtDate } from "@/lib/format";
import { PAYMENT_LABEL } from "@/lib/constants";
import { ticketTotals } from "@/lib/ticket-math";
import { monthRange, paymentsBetween } from "@/lib/sales";
import { PageHeader, Section, Empty } from "@/components/ui";

export default async function Sales({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const { start, end, fromStr, toStr } = monthRange(sp.from, sp.to);
  const [payments, closed] = await Promise.all([
    paymentsBetween(user.shopId, start, end),
    db.ticket.findMany({
      where: { shopId: user.shopId, status: "COLLECTED", closedAt: { gte: start, lt: end } },
      include: { lines: true, payments: true, viaAccount: true },
    }),
  ]);
  const byMethod = new Map<string, number>();
  for (const p of payments) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amountCents);
  const taken = payments.reduce((s, p) => s + p.amountCents, 0);
  let service = 0,
    labor = 0,
    parts = 0,
    tax = 0,
    commission = 0;
  for (const t of closed) {
    const x = ticketTotals(t.lines, t.payments, t.taxRatePct, t.viaAccount?.commissionPct);
    service += x.service;
    labor += x.labor;
    parts += x.parts;
    tax += x.tax;
    commission += x.commission;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales log"
        sub={`${fmtDate(start)} to ${fmtDate(new Date(end.getTime() - 1))}`}
        actions={
          <a className="btn" href={`/api/sales?from=${fromStr}&to=${toStr}`}>
            Download CSV
          </a>
        }
      />
      <form className="flex flex-wrap items-end gap-2">
        <div className="field">
          <label htmlFor="from" className="label">
            From
          </label>
          <input id="from" name="from" type="date" defaultValue={fromStr} className="input" />
        </div>
        <div className="field">
          <label htmlFor="to" className="label">
            To
          </label>
          <input id="to" name="to" type="date" defaultValue={toStr} className="input" />
        </div>
        <button className="btn">Show</button>
      </form>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Money taken", taken],
          ["Service (collected)", service],
          ["Labor (collected)", labor],
          ["Parts (collected)", parts],
          ["Sales tax", tax],
          ["Shop commission owed", commission],
        ].map(([k, v]) => (
          <div key={k as string} className="card card-pad">
            <div className="num text-xl font-semibold">{money(v as number)}</div>
            <div className="muted text-xs">{k}</div>
          </div>
        ))}
      </div>

      <Section title="By payment method">
        {byMethod.size === 0 ? (
          <Empty>No payments in this period.</Empty>
        ) : (
          <ul className="grid gap-2 text-sm sm:grid-cols-3">
            {[...byMethod.entries()].map(([m, v]) => (
              <li key={m} className="flex justify-between rounded border border-line px-3 py-2">
                <span>{PAYMENT_LABEL[m as keyof typeof PAYMENT_LABEL]}</span>
                <span className="num font-semibold">{money(v)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Payments (${payments.length})`}>
        {payments.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Ticket</th>
                  <th>Customer</th>
                  <th>Machine</th>
                  <th>Method</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="num whitespace-nowrap">{fmtDate(p.paidAt)}</td>
                    <td className="mono">
                      <Link href={`/tickets/${p.ticketId}`} className="link">
                        {ticketNo(p.ticket.number)}
                      </Link>
                    </td>
                    <td>
                      {p.ticket.customer?.name ?? "-"}
                      {p.ticket.viaAccount && <div className="muted text-xs">via {p.ticket.viaAccount.code ?? p.ticket.viaAccount.name}</div>}
                    </td>
                    <td>
                      {p.ticket.machine.brand} {p.ticket.machine.model}
                    </td>
                    <td>{PAYMENT_LABEL[p.method]}</td>
                    <td className="num text-right">{money(p.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
