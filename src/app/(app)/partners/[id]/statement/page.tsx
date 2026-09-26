import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money, ticketNo } from "@/lib/format";
import { monthPeriod, statementFor } from "@/lib/partners";
import { qtyText } from "@/lib/register-math";
import { PageHeader, Section, Empty } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { ActionForm, Submit } from "@/components/action-form";
import { recordSettlement } from "@/actions/partners";

export default async function StatementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ month?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId: user.shopId, id } } });
  if (!link) notFound();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, timeZone: true } });
  const p = monthPeriod((await searchParams).month, shop.timeZone);
  const st = await statementFor(user.shopId, id, p.from, p.to);
  const repairName = link.side === "repair" ? shop.name : link.partnerName;
  const sewingName = link.side === "retail" ? shop.name : link.partnerName;
  const monthName = p.from.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const who = (cents: number) => (cents > 0 ? `${sewingName} owes ${repairName}` : cents < 0 ? `${repairName} owes ${sewingName}` : "Nothing owed");

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: `/partners/${id}`, label: link.partnerName }}
        title={`Statement for ${monthName}`}
        sub={`${sewingName} and ${repairName} · ${st.terms.repairCommissionPct}% commission on repairs · sewing shop keeps ${st.terms.consignSharePct}% of consigned sales`}
        actions={
          <>
            <Link href={`/partners/${id}/statement?month=${p.prev}`} className="btn">
              &larr; Previous
            </Link>
            <Link href={`/partners/${id}/statement?month=${p.next}`} className="btn">
              Next &rarr;
            </Link>
            <PrintButton />
          </>
        }
      />

      <Section title="Repairs paid this month">
        {st.repairs.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Ticket</th>
                  <th>Customer</th>
                  <th>Machine</th>
                  <th>Paid</th>
                  <th className="text-right">Bill</th>
                  <th className="text-right">Commission</th>
                  <th className="text-right">Owed to repair shop</th>
                </tr>
              </thead>
              <tbody>
                {st.repairs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.tag}</td>
                    <td className="mono">{r.ticketNumber ? `#${ticketNo(r.ticketNumber)}` : ""}</td>
                    <td>{r.customerName}</td>
                    <td>{r.machine}</td>
                    <td>
                      {fmtDate(r.paidAt)} at {r.paidWhere === "shop" ? "sewing shop" : "repair shop"}
                    </td>
                    <td className="num text-right">{money(r.totalCents)}</td>
                    <td className="num text-right">{money(r.commissionCents)}</td>
                    <td className="num text-right">{money(r.owedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Consigned stock sold">
        {st.consign.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Sold</th>
                  <th>Item</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Sales</th>
                  <th className="text-right">Sewing shop keeps</th>
                  <th className="text-right">Owed to repair shop</th>
                </tr>
              </thead>
              <tbody>
                {st.consign.map((c) => (
                  <tr key={c.id}>
                    <td>{fmtDate(c.soldAt)}</td>
                    <td>{c.item}</td>
                    <td className="num text-right">{qtyText(c.qty, null)}</td>
                    <td className="num text-right">{money(c.priceCents)}</td>
                    <td className="num text-right">{money(c.grossCents)}</td>
                    <td className="num text-right">{money(c.shopKeepsCents)}</td>
                    <td className="num text-right">{money(c.owedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Orders delivered">
        {st.orders.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {st.orders.map((o) => (
              <li key={o.id} className="flex justify-between py-1.5">
                <span>
                  <Link href={`/partners/${id}/orders/${o.id}`} className="link mono">
                    {o.number}
                  </Link>{" "}
                  delivered {fmtDate(o.deliveredAt)}
                </span>
                <span className="num">{money(o.totalCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Summary">
        <ul className="max-w-lg space-y-1 text-sm">
          <Row k="Repairs" v={st.totals.repairsCents} />
          <Row k="Consigned stock" v={st.totals.consignCents} />
          <Row k="Orders" v={st.totals.ordersCents} />
          <li className="flex justify-between border-t border-line pt-1 font-semibold">
            <span>{monthName}: {who(st.totals.periodNetCents)}</span>
            <span className="num">{money(Math.abs(st.totals.periodNetCents))}</span>
          </li>
          {st.settlements.map((x) => (
            <li key={x.id} className="flex justify-between">
              <span>
                Paid {fmtDate(x.paidAt)} ({x.netCents > 0 ? `${sewingName} to ${repairName}` : `${repairName} to ${sewingName}`}){x.note ? ` · ${x.note}` : ""}
              </span>
              <span className="num">{money(Math.abs(x.netCents))}</span>
            </li>
          ))}
          <li className="flex justify-between border-t border-line pt-1 text-base font-bold">
            <span>Balance to date: {who(st.balanceCents)}</span>
            <span className="num" data-testid="balance">
              {money(Math.abs(st.balanceCents))}
            </span>
          </li>
        </ul>
        <p className="muted mt-2 text-xs">Due within {st.terms.payWithinDays} days of the end of the month.</p>
      </Section>

      {user.role !== "TECH" && (
        <Section title={`Record a payment you made to ${link.partnerName}`}>
          <p className="muted mb-2 text-sm">The shop that pays records it; {link.partnerName} sees it on their statement. (When they pay you, they record it.)</p>
          <ActionForm action={recordSettlement.bind(null, id)} className="no-print flex flex-wrap items-end gap-2" success="Payment recorded" reset>
            <input type="hidden" name="month" value={p.month} />
            <div className="field w-32">
              <label htmlFor="amount" className="label">
                Amount paid
              </label>
              <input
                id="amount"
                name="amount"
                inputMode="decimal"
                defaultValue={(link.side === "retail" ? st.balanceCents > 0 : st.balanceCents < 0) ? (Math.abs(st.balanceCents) / 100).toFixed(2) : ""}
                className="input num"
              />
            </div>
            <div className="field w-40">
              <label htmlFor="method" className="label">
                How
              </label>
              <input id="method" name="method" className="input" placeholder="Check 1042, Zelle..." />
            </div>
            <div className="field min-w-48 flex-1">
              <label htmlFor="snote" className="label">
                Note
              </label>
              <input id="snote" name="note" className="input" />
            </div>
            <Submit>Record payment</Submit>
          </ActionForm>
        </Section>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: number }) {
  return (
    <li className="flex justify-between">
      <span>{k}</span>
      <span className="num">
        {v < 0 ? "-" : ""}
        {money(Math.abs(v))}
      </span>
    </li>
  );
}
