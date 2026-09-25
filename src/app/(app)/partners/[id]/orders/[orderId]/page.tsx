import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";
import type { JobEvent, OrderLine } from "@/lib/partners";
import { PageHeader, Section, OrderStatusPill } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { ActionForm, Submit } from "@/components/action-form";
import { partnerOrderAction } from "@/actions/partner-orders";

export default async function PartnerOrderPage({ params }: { params: Promise<{ id: string; orderId: string }> }) {
  const user = await requireUser();
  const { id, orderId } = await params;
  const [link, o] = await Promise.all([
    db.partnerLink.findUnique({ where: { shopId_id: { shopId: user.shopId, id } } }),
    db.partnerOrder.findUnique({ where: { shopId_id: { shopId: user.shopId, id: orderId } } }),
  ]);
  if (!link || !o || o.linkId !== id) notFound();
  const lines = o.lines as OrderLine[];
  const events = (o.events as JobEvent[]) ?? [];
  const seller = o.side === "seller";
  const act = (a: "accept" | "deliver" | "cancel" | "receive") => partnerOrderAction.bind(null, o.id, a);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: `/partners/${id}`, label: link.partnerName }}
        title={
          <>
            Order <span className="mono">{o.number}</span> <OrderStatusPill status={o.status} />
          </>
        }
        sub={`${seller ? `From ${link.partnerName}` : `To ${link.partnerName}`} · placed ${fmtDate(o.createdAt)}`}
        actions={<PrintButton />}
      />
      <Section title="Items">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Each</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.itemKey}>
                <td>
                  <span className="mono">{l.partNumber}</span> {l.description}
                </td>
                <td className="num text-right">{qtyText(l.qty, null)}</td>
                <td className="num text-right">{money(l.unitCents)}</td>
                <td className="num text-right">{money(Math.round(l.qty * l.unitCents))}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className="text-right font-semibold">
                Total (goes on the monthly statement)
              </td>
              <td className="num text-right font-semibold">{money(o.totalCents)}</td>
            </tr>
          </tbody>
        </table>
        {o.note && <p className="mt-3 text-sm">Note from the sewing shop: {o.note}</p>}
        {o.sellerNote && <p className="mt-1 text-sm">Note from the repair shop: {o.sellerNote}</p>}
        {(o.carrier || o.tracking) && (
          <p className="mt-1 text-sm">
            Shipped {o.carrier} {o.tracking}
          </p>
        )}
      </Section>

      <div className="no-print flex flex-wrap gap-3">
        {seller && o.status === "PLACED" && (
          <ActionForm action={act("accept")} className="flex items-end gap-2" success="Accepted">
            <input name="note" aria-label="Note for the sewing shop" className="input" placeholder="Note (optional)" />
            <Submit>Accept</Submit>
          </ActionForm>
        )}
        {seller && ["PLACED", "ACCEPTED"].includes(o.status) && (
          <ActionForm action={act("deliver")} className="flex flex-wrap items-end gap-2" success="Marked delivered">
            <input name="carrier" aria-label="Carrier" className="input w-32" placeholder="Carrier (if shipped)" />
            <input name="tracking" aria-label="Tracking number" className="input w-44" placeholder="Tracking (if shipped)" />
            <Submit>Delivered</Submit>
          </ActionForm>
        )}
        {!seller && o.status === "DELIVERED" && (
          <ActionForm action={act("receive")} success="Added to your inventory">
            <Submit>Received: add to inventory</Submit>
          </ActionForm>
        )}
        {((seller && ["PLACED", "ACCEPTED"].includes(o.status)) || (!seller && o.status === "PLACED")) && (
          <ActionForm action={act("cancel")} className="flex items-end gap-2" success="Cancelled">
            <input name="note" aria-label="Why it's cancelled" className="input" placeholder="Why (optional)" />
            <Submit className="btn btn-danger">Cancel order</Submit>
          </ActionForm>
        )}
      </div>

      <Section title="History">
        <ul className="space-y-1 text-sm">
          {events.map((e, i) => (
            <li key={i}>
              {new Date(e.at).toLocaleString("en-US")} · {e.status ?? ""} {e.note ?? ""}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
