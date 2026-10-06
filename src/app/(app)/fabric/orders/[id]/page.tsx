// One purchase order (fabric-smarts-design.md section 5): edit a draft, send it (email text, print page and spreadsheet:
// nothing is emailed from here), receive yards against it, cancel or close it.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { mailtoFor, orderFor, type OrderView } from "@/lib/fabric-orders";
import { PO_STATUS_LABEL, lineCostTotal, lineYards, outstandingYards } from "@/lib/fabric-orders-math";
import { yards } from "@/lib/register-math";
import { fmtDate } from "@/lib/format";
import { PageHeader } from "@/components/ui";
import { AddLineForm, CancelOrderButton, OrderEditForm, ReceiveForm, SendButton } from "@/components/fabric-orders-forms";

const TONE = { DRAFT: "tone-neutral", SENT: "tone-work", PARTLY_RECEIVED: "tone-wait", RECEIVED: "tone-ready", CANCELLED: "tone-bad" } as const;

const amount = (l: OrderView["lines"][number]) => (l.unit === "BOLT" ? `${l.qty} ${l.qty === 1 ? "bolt" : "bolts"} (${yards(lineYards(l))} yd)` : `${yards(l.qty)} yd`);

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const { id } = await params;
  const o = await orderFor(user.shopId, id);
  if (!o) notFound();
  const draft = o.status === "DRAFT";
  const receiving = o.status === "SENT" || o.status === "PARTLY_RECEIVED";
  const under = o.supplier.minOrderCents > 0 && o.totalCents > 0 && o.totalCents < o.supplier.minOrderCents;
  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: "/fabric?tab=reorder", label: "Reorder" }}
        title={
          <>
            Order #{o.number} <span className="muted font-normal">to {o.supplier.name}</span>
          </>
        }
        sub={
          <>
            <span className={`pill ${TONE[o.status]}`}>{PO_STATUS_LABEL[o.status]}</span>{" "}
            {o.sentAt ? `Sent ${fmtDate(o.sentAt, o.timeZone)}. ` : `Started ${fmtDate(o.createdAt, o.timeZone)}. `}
            Lead time {o.supplier.lead.days} days ({o.supplier.lead.from === "learned" ? "learned from received orders" : o.supplier.lead.from === "supplier" ? "this supplier's own figure" : "the shop's default"}).
          </>
        }
      />
      {under && (
        <p className="rounded border border-line p-3 text-sm" role="status">
          {o.supplier.name} asks for a {money(o.supplier.minOrderCents)} minimum; this order is {money(o.totalCents)}.
        </p>
      )}
      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">
          {o.lines.length} {o.lines.length === 1 ? "line" : "lines"}: {yards(o.totalYards)} yd{o.totalCents > 0 ? `, ${money(o.totalCents)} at cost` : ""}
        </h2>
        {draft ? (
          <>
            <OrderEditForm
              orderId={o.id}
              note={o.note ?? ""}
              lines={o.lines.map((l) => ({ id: l.id, itemNumber: l.itemNumber, description: l.description, unit: l.unit, qty: l.qty, costDollars: l.costCents == null ? "" : (l.costCents / 100).toFixed(2), yardsText: `${yards(lineYards(l))} yd${l.costCents != null ? `, ${money(lineCostTotal(l))}` : ""}` }))}
            />
            <AddLineForm orderId={o.id} />
          </>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right">Ordered</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Still to come</th>
                  <th className="text-right">Cost a yard</th>
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.partId ? (
                        <Link href={`/parts/${l.partId}`} className="link mono">
                          {l.itemNumber}
                        </Link>
                      ) : (
                        <span className="mono">{l.itemNumber}</span>
                      )}
                      <div className="muted text-xs">{l.description}</div>
                    </td>
                    <td className="num text-right">{amount(l)}</td>
                    <td className="num text-right">{yards(l.receivedYards)} yd</td>
                    <td className="num text-right">{o.status === "RECEIVED" || o.status === "CANCELLED" ? "-" : `${yards(outstandingYards(l))} yd`}</td>
                    <td className="num text-right">{l.costCents == null ? "-" : money(l.costCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {o.note && !draft && <p className="text-sm">Note: {o.note}</p>}
      </div>
      {draft ? (
        <div className="card card-pad flex flex-wrap items-center gap-2">
          <SendButton orderId={o.id} />
          <CancelOrderButton orderId={o.id} />
          <span className="muted text-sm">Sending marks the order sent (its yards count as on order). Email text, a print page and a spreadsheet appear here after.</span>
        </div>
      ) : (
        o.status !== "CANCELLED" && (
          <div className="card card-pad space-y-2">
            <h2 className="text-sm font-semibold">Send it to {o.supplier.name}</h2>
            <div className="flex flex-wrap gap-2">
              <a className="btn" href={mailtoFor(o)}>
                Email it{o.supplier.orderEmail ? ` to ${o.supplier.orderEmail}` : ""}
              </a>
              <Link className="btn" href={`/fabric/orders/${o.id}/print`} target="_blank">
                Print page
              </Link>
              <a className="btn" href={`/api/fabric/orders/${o.id}/csv`}>
                Download spreadsheet (CSV)
              </a>
            </div>
            <p className="muted text-xs">Email opens your own mail program with the order filled in; nothing is sent from StitchShop.</p>
          </div>
        )
      )}
      {receiving && (
        <div className="card card-pad space-y-2">
          <h2 className="text-sm font-semibold">Receive</h2>
          <p className="muted text-sm">Enter the yards that came on each line. They go onto the shelf and start each fabric&apos;s age clock; the first delivery also teaches {o.supplier.name}&apos;s lead time.</p>
          <ReceiveForm
            orderId={o.id}
            partly={o.status === "PARTLY_RECEIVED"}
            lines={o.lines.map((l) => ({ id: l.id, itemNumber: l.itemNumber, description: l.description, outstanding: outstandingYards(l), text: `${amount(l)} ordered, ${yards(l.receivedYards)} yd received` }))}
          />
          {o.status === "SENT" && <CancelOrderButton orderId={o.id} />}
        </div>
      )}
    </div>
  );
}
