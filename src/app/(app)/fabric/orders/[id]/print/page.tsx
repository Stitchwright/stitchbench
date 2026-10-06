// A purchase order to print or save as a PDF for the rep.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { money, fmtDate } from "@/lib/format";
import { orderFor } from "@/lib/fabric-orders";
import { lineCostTotal, lineYards } from "@/lib/fabric-orders-math";
import { yards } from "@/lib/register-math";
import { PrintButton } from "@/components/print-button";

export default async function OrderPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const o = await orderFor(user.shopId, id);
  if (!o) notFound();
  return (
    <div className="space-y-4">
      <div className="no-print">
        <PrintButton />
      </div>
      <div>
        <h1 className="h1">Purchase order #{o.number}</h1>
        <p className="text-sm">
          From {o.shopName} to {o.supplier.name}
          {o.supplier.orderEmail ? ` (${o.supplier.orderEmail})` : ""} · {fmtDate(o.sentAt ?? o.createdAt, o.timeZone)}
        </p>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Item number</th>
            <th>Description</th>
            <th className="text-right">Amount</th>
            <th className="text-right">Yards</th>
            <th className="text-right">Cost a yard</th>
            <th className="text-right">Line total</th>
          </tr>
        </thead>
        <tbody>
          {o.lines.map((l) => (
            <tr key={l.id}>
              <td className="mono">{l.itemNumber}</td>
              <td>{l.description}</td>
              <td className="num text-right">{l.unit === "BOLT" ? `${l.qty} ${l.qty === 1 ? "bolt" : "bolts"}` : `${yards(l.qty)} yd`}</td>
              <td className="num text-right">{yards(lineYards(l))}</td>
              <td className="num text-right">{l.costCents == null ? "" : money(l.costCents)}</td>
              <td className="num text-right">{l.costCents == null ? "" : money(lineCostTotal(l))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="font-semibold">
              Total
            </td>
            <td className="num text-right font-semibold">{yards(o.totalYards)}</td>
            <td />
            <td className="num text-right font-semibold">{o.totalCents ? money(o.totalCents) : ""}</td>
          </tr>
        </tfoot>
      </table>
      {o.note && <p className="text-sm">{o.note}</p>}
    </div>
  );
}
