// Parts on order (online-and-parts-design.md section 1): every open wait across tickets, by supplier, with Received
// per row (and "Received all of these" per supplier) and Cancel. `?part=<id>` narrows it to one stocked part.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, ticketNo } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { groupBySupplier, openWaits } from "@/lib/part-waits";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { cancelWait, receiveWaits } from "@/actions/part-waits";
import { ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader } from "@/components/ui";

export default async function PartsOnOrder({ searchParams }: { searchParams: Promise<{ part?: string | string[] }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const partId = typeof sp.part === "string" ? sp.part : null;
  const shopId = user.shopId;
  const [rows, tz, marketing] = await Promise.all([openWaits(shopId, { partId }), shopTimeZone(shopId), gateFor(shopId, "marketing")]);
  const today = ymdOf(new Date(), tz);
  const groups = groupBySupplier(rows);
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Parts on order"
        sub={`${rows.length} part${rows.length === 1 ? "" : "s"} customers are waiting for${partId ? " (one part)" : ""}. Mark them received when the order is checked in${marketing === "on" ? ": the customer hears the part is in." : "."}`}
        back={{ href: "/parts", label: "Parts" }}
      />
      {partId && (
        <p className="text-sm">
          <Link href="/parts/on-order" className="link">
            Show every part on order
          </Link>
        </p>
      )}
      {rows.length === 0 ? (
        <Empty>Nothing on order. A part is recorded from its ticket (&quot;Waiting on a part&quot;).</Empty>
      ) : (
        groups.map((g) => (
          <section key={g.supplier ?? "-"} className="card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h2 className="h2">
                {g.supplier ?? "No supplier named"} <span className="muted text-sm">({g.rows.length})</span>
              </h2>
              {g.rows.length > 1 && (
                <ActionForm action={receiveWaits.bind(null, null)} className="flex flex-wrap items-end gap-2">
                  {g.rows.map((w) => (
                    <input key={w.id} type="hidden" name="wait" value={w.id} />
                  ))}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="backOnBench" className="check" defaultChecked /> Tickets back on the bench
                  </label>
                  <Submit className="btn btn-sm btn-primary">Received all of these</Submit>
                </ActionForm>
              )}
            </div>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Part</th>
                    <th>Qty</th>
                    <th>Ticket</th>
                    <th>Customer</th>
                    <th>Ordered</th>
                    <th>Expected</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((w) => (
                    <tr key={w.id}>
                      <td>
                        {w.description}
                        {w.part && <span className="mono muted ml-2 text-xs">{w.part.partNumber}</span>}
                        {w.note && <div className="muted text-xs">{w.note}</div>}
                      </td>
                      <td className="num">{w.qty}</td>
                      <td>
                        <Link href={`/tickets/${w.ticket.id}`} className="link mono">
                          #{ticketNo(w.ticket.number)}
                        </Link>
                        <div className="muted text-xs">
                          {w.ticket.machine.brand} {w.ticket.machine.model}
                        </div>
                      </td>
                      <td>
                        {w.ticket.customer ? (
                          <Link href={`/customers/${w.ticket.customer.id}`} className="link">
                            {w.ticket.customer.name}
                          </Link>
                        ) : (
                          <span className="muted">no customer</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">{fmtDate(w.orderedAt, tz)}</td>
                      <td className="whitespace-nowrap">{w.expectedOn ? <span className={`pill ${w.expectedOn < today ? "tone-bad" : "tone-wait"}`}>{w.expectedOn}</span> : ""}</td>
                      <td>
                        <div className="flex flex-wrap items-end justify-end gap-2">
                          <ActionForm action={receiveWaits.bind(null, w.id)} className="flex items-end gap-2">
                            {w.ticket.status === "WAITING_PARTS" && <input type="hidden" name="backOnBench" value="on" />}
                            <Submit className="btn btn-sm btn-primary">Received</Submit>
                          </ActionForm>
                          <ActionForm action={cancelWait.bind(null, w.id)} success="Cancelled" className="flex items-end gap-1">
                            <label htmlFor={`why-${w.id}`} className="sr-only">
                              Why it isn&apos;t coming
                            </label>
                            <input id={`why-${w.id}`} name="why" className="input w-36" placeholder="not coming: why" />
                            <Submit className="btn btn-sm">Cancel</Submit>
                          </ActionForm>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
