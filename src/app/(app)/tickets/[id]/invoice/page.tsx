import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money, ticketNo } from "@/lib/format";
import { lineTotal, ticketTotals } from "@/lib/ticket-math";
import { PAYMENT_LABEL } from "@/lib/constants";
import { PrintButton } from "@/components/print-button";
import { PageHeader } from "@/components/ui";

export default async function Invoice({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const t = await db.ticket.findFirst({
    where: { id, shopId: user.shopId },
    include: { shop: true, machine: true, customer: true, lines: { orderBy: { createdAt: "asc" } }, payments: { orderBy: { paidAt: "asc" } } },
  });
  if (!t) notFound();
  const tot = ticketTotals(t.lines, t.payments, t.taxRatePct);
  const s = t.shop;

  return (
    <div>
      <div className="no-print">
        <PageHeader back={{ href: `/tickets/${t.id}`, label: `Ticket #${ticketNo(t.number)}` }} title="Invoice" actions={<PrintButton />} />
      </div>
      <article className="card mx-auto max-w-3xl bg-white p-8 text-black print:border-0 print:p-0">
        <header className="flex flex-wrap justify-between gap-4 border-b border-line pb-4">
          <div>
            <div className="text-xl font-bold">{s.name}</div>
            {s.address && <div className="text-sm whitespace-pre-line">{s.address}</div>}
            <div className="text-sm">{[s.phone, s.email].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="text-right text-sm">
            <div className="text-lg font-semibold">
              Invoice <span className="mono">#{ticketNo(t.number)}</span>
            </div>
            <div>Received {fmtDate(t.intakeAt)}</div>
            {t.closedAt && <div>Returned {fmtDate(t.closedAt)}</div>}
          </div>
        </header>

        <section className="grid gap-4 border-b border-line py-4 text-sm sm:grid-cols-2">
          <div>
            <div className="label">Customer</div>
            <div className="font-semibold">{t.customer?.name ?? "-"}</div>
            <div>{[t.customer?.phone, t.customer?.email].filter(Boolean).join(" · ")}</div>
          </div>
          <div>
            <div className="label">Machine</div>
            <div className="font-semibold">
              {t.machine.brand} {t.machine.model}
            </div>
            {t.machine.serial && <div className="mono">SN {t.machine.serial}</div>}
          </div>
        </section>

        {(t.workDone || t.diagnosis) && (
          <section className="border-b border-line py-4 text-sm">
            <div className="label">Work performed</div>
            <p className="whitespace-pre-wrap">{t.workDone ?? t.diagnosis}</p>
          </section>
        )}

        <table className="table my-4">
          <thead>
            <tr>
              <th>Description</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Each</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="num text-right">{l.qty}</td>
                <td className="num text-right">{money(l.unitPriceCents)}</td>
                <td className="num text-right">{money(lineTotal(l))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="num ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
          <dt>Subtotal</dt>
          <dd className="text-right">{money(tot.subtotal)}</dd>
          {tot.tax > 0 && (
            <>
              <dt>Sales tax ({t.taxRatePct}%)</dt>
              <dd className="text-right">{money(tot.tax)}</dd>
            </>
          )}
          <dt className="font-semibold">Total</dt>
          <dd className="text-right font-semibold">{money(tot.total)}</dd>
          {t.payments.map((p) => (
            <div key={p.id} className="contents">
              <dt>
                Paid {fmtDate(p.paidAt)} ({PAYMENT_LABEL[p.method]})
              </dt>
              <dd className="text-right">-{money(p.amountCents)}</dd>
            </div>
          ))}
          <dt className="border-t border-line pt-1 font-semibold">Balance due</dt>
          <dd className="border-t border-line pt-1 text-right font-semibold">{money(tot.balance)}</dd>
        </dl>

        <footer className="mt-8 border-t border-line pt-4 text-xs">
          {s.warrantyDays > 0 && (
            <p>
              {s.warrantyDays}-day warranty on our work
              {t.warrantyUntil ? ` (through ${fmtDate(t.warrantyUntil)})` : ""}. Parts we didn&apos;t install are not covered.
            </p>
          )}
          {t.accessories.length > 0 && <p className="mt-1">Returned with the machine: {t.accessories.join(", ")}.</p>}
          <p className="mt-1">Thank you for your business.</p>
        </footer>
      </article>
    </div>
  );
}
