import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money, ticketNo } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { ticketTotals } from "@/lib/ticket-math";
import { PageHeader, Empty, StatusPill } from "@/components/ui";

const TABS = [
  { key: "unpaid", label: "Unpaid" },
  { key: "paid", label: "Paid" },
  { key: "all", label: "All" },
] as const;
type Tab = (typeof TABS)[number]["key"];
const LIMIT = 500;

export default async function Invoices({ searchParams }: { searchParams: Promise<{ show?: string; q?: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const sp = await searchParams;
  const show: Tab = TABS.some((t) => t.key === sp.show) ? (sp.show as Tab) : "unpaid";
  const term = sp.q?.trim() ?? "";
  const num = /^\d+$/.test(term) ? Number(term) : null;

  // An invoice is a ticket with something billed on it. Every one's amounts are read (just the money columns), so
  // Unpaid and the totals take in old debts too; the list itself shows the newest LIMIT of them.
  const amounts = await db.ticket.findMany({
    where: {
      shopId: user.shopId,
      lines: { some: {} },
      ...(term
        ? {
            OR: [
              ...(num != null ? [{ number: num }] : []),
              { customer: { name: { contains: term, mode: "insensitive" } } },
              { machine: { serial: { contains: term, mode: "insensitive" } } },
              { machine: { model: { contains: term, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      taxRatePct: true,
      lines: { select: { kind: true, qty: true, unitPriceCents: true, taxable: true } },
      payments: { select: { amountCents: true, method: true } },
    },
    orderBy: { number: "desc" },
  });
  const matched = amounts
    .map((t) => ({ id: t.id, tot: ticketTotals(t.lines, t.payments, t.taxRatePct) }))
    .filter(({ tot }) => (show === "unpaid" ? tot.balance > 0 : show === "paid" ? tot.balance <= 0 : true));
  const owed = matched.reduce((s, r) => s + Math.max(0, r.tot.balance), 0);
  const billed = matched.reduce((s, r) => s + r.tot.total, 0);
  const listed = matched.slice(0, LIMIT);
  const details = new Map(
    (
      await db.ticket.findMany({
        where: { shopId: user.shopId, id: { in: listed.map((r) => r.id) } },
        select: {
          id: true,
          number: true,
          status: true,
          intakeAt: true,
          readyAt: true,
          closedAt: true,
          customer: { select: { id: true, name: true } },
          machine: { select: { brand: true, model: true, serial: true } },
        },
      })
    ).map((t) => [t.id, t]),
  );
  const rows = listed.flatMap((r) => {
    const t = details.get(r.id);
    return t ? [{ t, tot: r.tot }] : [];
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Invoices" sub="Every ticket with charges on it. Open one to print it or save it as a PDF." />
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex gap-2" aria-label="Invoice filter">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={`/invoices?show=${t.key}${term ? `&q=${encodeURIComponent(term)}` : ""}`}
              className={`btn btn-sm ${show === t.key ? "btn-primary" : ""}`}
              aria-current={show === t.key ? "page" : undefined}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <form className="flex gap-2">
          <input type="hidden" name="show" value={show} />
          <label htmlFor="iq" className="sr-only">
            Search invoices
          </label>
          <input id="iq" name="q" defaultValue={term} className="input w-72" placeholder="Invoice #, customer, serial or model" />
          <button className="btn btn-sm">Search</button>
        </form>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card card-pad">
          <div className="label">Invoices</div>
          <div className="num text-2xl font-semibold">{matched.length}</div>
        </div>
        <div className="card card-pad">
          <div className="label">Billed</div>
          <div className="num text-2xl font-semibold">{money(billed)}</div>
        </div>
        <div className="card card-pad">
          <div className="label">Still owed</div>
          <div className="num text-2xl font-semibold">{money(owed)}</div>
        </div>
      </div>
      <div className="card">
        {rows.length === 0 ? (
          <div className="card-pad">
            <Empty>{show === "unpaid" ? "Nothing owed. Every invoice is paid." : "No invoices match."}</Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Machine</th>
                  <th>Status</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Paid</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ t, tot }) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/tickets/${t.id}/invoice`} className="link mono font-semibold">
                        #{ticketNo(t.number)}
                      </Link>
                    </td>
                    <td className="num whitespace-nowrap">{fmtDate(t.closedAt ?? t.readyAt ?? t.intakeAt, tz)}</td>
                    <td>{t.customer ? <Link href={`/customers/${t.customer.id}`} className="link">{t.customer.name}</Link> : "-"}</td>
                    <td>
                      {t.machine.brand} {t.machine.model}
                      {t.machine.serial && <div className="mono muted text-xs">SN {t.machine.serial}</div>}
                    </td>
                    <td>
                      <StatusPill status={t.status} />
                    </td>
                    <td className="num text-right">{money(tot.total)}</td>
                    <td className="num text-right">{money(tot.paid)}</td>
                    <td className={`num text-right ${tot.balance > 0 ? "font-semibold" : "muted"}`}>{money(tot.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {matched.length > rows.length && (
              <p className="muted card-pad text-sm">
                Showing the newest {rows.length} of {matched.length}; the totals above count them all. Search by invoice #, customer or serial to find an
                older one.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
