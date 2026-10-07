// One purchase order (fabric-smarts-design.md section 5; any item since shop-features-round-2-design.md 1.1): edit a
// draft, send it (email text, print page and spreadsheet), receive what came against it, cancel or close it. Fabric lines
// are in yards or bolts, every other item in pieces.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { mailtoFor, orderFor } from "@/lib/fabric-orders";
import { PO_STATUS_LABEL, amountText, costPer, lineCostTotal, measureText, outstandingYards } from "@/lib/fabric-orders-math";
import { fmtDate } from "@/lib/format";
import { connectorFor } from "@/lib/connectors/registry";
import { PageHeader } from "@/components/ui";
import { AddLineForm, CancelOrderButton, OrderEditForm, ReceiveForm, SendButton } from "@/components/fabric-orders-forms";

const TONE = { DRAFT: "tone-neutral", SENT: "tone-work", PARTLY_RECEIVED: "tone-wait", RECEIVED: "tone-ready", CANCELLED: "tone-bad" } as const;

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const o = await orderFor(user.shopId, id);
  if (!o) notFound();
  const draft = o.status === "DRAFT";
  const receiving = o.status === "SENT" || o.status === "PARTLY_RECEIVED";
  const conn = connectorFor(o.supplier.connector);
  const sendLabel = conn.channel === "file" ? "Send order (prepare the upload file)" : o.supplier.orderEmail ? `Send order by email to ${o.supplier.orderEmail}` : "Send order";
  const under = o.supplier.minOrderCents > 0 && o.totalCents > 0 && o.totalCents < o.supplier.minOrderCents;
  const tech = user.role === "TECH";
  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: "/parts/orders", label: "Orders to suppliers" }}
        title={
          <>
            Order #{o.number} <span className="muted font-normal">to {o.supplier.name}</span>
          </>
        }
        sub={
          <>
            <span className={`pill ${TONE[o.status]}`}>{PO_STATUS_LABEL[o.status]}</span>{" "}
            {o.sentAt ? `Sent ${fmtDate(o.sentAt, o.timeZone)}. ` : `Started ${fmtDate(o.createdAt, o.timeZone)}. `}
            Usually arrives in {o.supplier.lead.days} days ({o.supplier.lead.from === "learned" ? "learned from received orders" : o.supplier.lead.from === "supplier" ? "this supplier's own figure" : "the shop's default"}).
          </>
        }
      />
      {under && (
        <p className="rounded border border-line p-3 text-sm" role="status">
          {o.supplier.name} asks for a {money(o.supplier.minOrderCents)} minimum; this order is {money(o.totalCents)}.
        </p>
      )}
      <div className="card card-pad space-y-3">
        <h2 className="text-base font-semibold">
          {o.lines.length} {o.lines.length === 1 ? "line" : "lines"}: {o.amountText}
          {o.totalCents > 0 ? `, ${money(o.totalCents)} at cost` : ""}
        </h2>
        {draft ? (
          <>
            <OrderEditForm
              orderId={o.id}
              note={o.note ?? ""}
              lockCost={tech}
              lines={o.lines.map((l) => ({
                id: l.id,
                itemNumber: l.itemNumber,
                description: l.description,
                unit: l.unit,
                qty: l.qty,
                costDollars: l.costCents == null ? "" : (l.costCents / 100).toFixed(2),
                yardsText: `${amountText(l)}${l.costCents != null ? `, ${money(lineCostTotal(l))}` : ""}`,
              }))}
            />
            <AddLineForm orderId={o.id} lockCost={tech} />
          </>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right">Ordered</th>
                  <th className="text-right">Came</th>
                  <th className="text-right">Still to come</th>
                  <th className="text-right">Cost</th>
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
                      <div className="muted text-sm">{l.description}</div>
                    </td>
                    <td className="num text-right">{amountText(l)}</td>
                    <td className="num text-right">{measureText(l, l.receivedYards)}</td>
                    <td className="num text-right">{o.status === "RECEIVED" || o.status === "CANCELLED" ? "-" : measureText(l, outstandingYards(l))}</td>
                    <td className="num text-right">{l.costCents == null ? "-" : `${money(l.costCents)}${costPer(l)}`}</td>
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
          <SendButton orderId={o.id} label={sendLabel} />
          <CancelOrderButton orderId={o.id} />
          <span className="muted text-sm">
            {conn.channel === "file"
              ? `Sending marks the order sent (what's on it counts as on order) and readies the spreadsheet to upload on ${o.supplier.name}'s site.`
              : "Sending emails it from your own mail account when Settings -> Messages has one (otherwise it opens your mail program below); either way what's on it counts as on order."}
          </span>
        </div>
      ) : (
        o.status !== "CANCELLED" && (
          <div className="card card-pad space-y-2">
            <h2 className="text-base font-semibold">Send it to {o.supplier.name}</h2>
            {o.sentVia === "smtp" && <p className="text-sm">Emailed to {o.supplier.orderEmail} from your mail account, with the spreadsheet attached.</p>}
            <div className="flex flex-wrap gap-2">
              {conn.channel === "file" && (
                <a className="btn" href={`/api/fabric/orders/${o.id}/csv`}>
                  Download the upload spreadsheet (CSV)
                </a>
              )}
              <a className="btn" href={mailtoFor(o)}>
                Email it{o.supplier.orderEmail ? ` to ${o.supplier.orderEmail}` : ""} from my mail program
              </a>
              <Link className="btn" href={`/parts/orders/${o.id}/print`} target="_blank">
                Print page
              </Link>
              {conn.channel !== "file" && (
                <a className="btn" href={`/api/fabric/orders/${o.id}/csv`}>
                  Download spreadsheet (CSV)
                </a>
              )}
            </div>
            <p className="muted text-sm">
              {conn.channel === "file" ? `Upload the spreadsheet on ${o.supplier.name}'s site (cart upload or quick order). This program never logs in to a wholesaler's site.` : "The mail-program link opens your own mail program with the order filled in; attach the spreadsheet if the order is long."}
            </p>
          </div>
        )
      )}
      {receiving && (
        <div className="card card-pad space-y-2">
          <h2 className="text-base font-semibold">When the box arrives</h2>
          <p className="muted text-sm">Each line starts at what is still to come: change it to what actually came, then press Receive. It goes onto the shelf; the first delivery also teaches {o.supplier.name}&apos;s delivery time.</p>
          <ReceiveForm
            orderId={o.id}
            partly={o.status === "PARTLY_RECEIVED"}
            lines={o.lines.map((l) => ({ id: l.id, itemNumber: l.itemNumber, description: l.description, each: l.unit === "EACH", outstanding: outstandingYards(l), received: l.receivedYards, text: `${amountText(l)} ordered, ${measureText(l, l.receivedYards)} came so far` }))}
          />
          {o.status === "SENT" && <CancelOrderButton orderId={o.id} />}
        </div>
      )}
    </div>
  );
}
