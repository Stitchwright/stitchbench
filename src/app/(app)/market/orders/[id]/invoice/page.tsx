import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import type { HubOrder } from "@/lib/hub";
import { PrintButton } from "@/components/print-button";
import { PageHeader } from "@/components/ui";
import { CONDITION_LABEL } from "@/components/market-ui";

// The invoice for a marketplace order, from the seller to the buyer. The buyer pays the seller directly.
export default async function MarketInvoice({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const row = await db.marketOrder.findUnique({ where: { id } });
  if (!row) notFound();
  const o = row.data as unknown as HubOrder;
  if (!["ACCEPTED", "PAID", "SHIPPED", "RECEIVED"].includes(o.status)) notFound();
  const accepted = o.events.find((e) => e.action === "accepted")?.at ?? o.createdAt;
  const paid = ["PAID", "SHIPPED", "RECEIVED"].includes(o.status) && o.paidAt;
  const s = o.sellerContact;

  return (
    <div>
      <div className="no-print">
        <PageHeader back={{ href: `/market/orders/${o.id}`, label: `Order ${o.number}` }} title="Invoice" actions={<PrintButton />} />
      </div>
      <article className="card mx-auto max-w-3xl bg-white p-8 text-black print:border-0 print:p-0">
        <header className="flex flex-wrap justify-between gap-4 border-b border-line pb-4">
          <div>
            <div className="text-xl font-bold">{o.sellerShop}</div>
            {s?.address && <div className="text-sm whitespace-pre-line">{s.address}</div>}
            <div className="text-sm">{[s?.phone, s?.email].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="text-right text-sm">
            <div className="text-lg font-semibold">
              Invoice <span className="mono">{o.number}</span>
            </div>
            <div>Date {fmtDate(accepted)}</div>
            {paid && <div className="font-semibold">Paid {fmtDate(o.paidAt)}</div>}
          </div>
        </header>

        <section className="grid gap-4 border-b border-line py-4 text-sm sm:grid-cols-2">
          <div>
            <div className="label">Bill to</div>
            <div className="font-semibold">{o.buyerShop}</div>
            {o.buyerContact?.name && <div>{o.buyerContact.name}</div>}
            <div>{[o.buyerContact?.phone, o.buyerContact?.email].filter(Boolean).join(" · ")}</div>
          </div>
          <div>
            <div className="label">Ship to</div>
            <div className="whitespace-pre-line">{o.shipTo}</div>
          </div>
        </section>

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
            <tr>
              <td>
                {o.item.title}
                <div className="text-xs">
                  {[o.item.brand, o.item.partNumber, CONDITION_LABEL[o.item.condition] ?? o.item.condition].filter(Boolean).join(" · ")}
                </div>
              </td>
              <td className="num text-right">{o.qty}</td>
              <td className="num text-right">{money(o.unitPriceCents)}</td>
              <td className="num text-right">{money(o.unitPriceCents * o.qty)}</td>
            </tr>
            <tr>
              <td>Shipping</td>
              <td />
              <td />
              <td className="num text-right">{money(o.shippingCents ?? 0)}</td>
            </tr>
          </tbody>
        </table>

        <dl className="num ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
          <dt className="font-semibold">Total</dt>
          <dd className="text-right font-semibold">{money(o.totalCents)}</dd>
          <dt className="border-t border-line pt-1 font-semibold">Balance due</dt>
          <dd className="border-t border-line pt-1 text-right font-semibold">{money(paid ? 0 : o.totalCents)}</dd>
        </dl>

        <footer className="mt-8 space-y-1 border-t border-line pt-4 text-sm">
          {!paid && o.payInstructions && (
            <p className="whitespace-pre-wrap">
              <strong>How to pay:</strong> {o.payInstructions}
            </p>
          )}
          {o.tracking && (
            <p>
              Shipped {o.shippedAt ? fmtDate(o.shippedAt) : ""} by {o.carrier}, tracking <span className="mono">{o.tracking}</span>
            </p>
          )}
          <p className="text-xs">Sold between repair shops on the StitchHub marketplace. Thank you for your business.</p>
        </footer>
      </article>
    </div>
  );
}
