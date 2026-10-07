// "Waiting on a part" on a ticket (online-and-parts-design.md section 1): the parts on order for it, Received (with
// "put it back on the bench" and a done-by date), Cancel, "Not received after all" within the hour, and the form to
// record a new one. Shown for any open ticket; highlighted while the status is Waiting on parts.
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { CLOSING_STATUSES } from "@/lib/constants";
import { fmtDate } from "@/lib/format";
import { noticesOn } from "@/lib/module-gate";
import { REOPEN_WINDOW_MS, waitsForTicket } from "@/lib/part-waits";
import { shopTimeZone } from "@/lib/shop-zone";
import { addWait, cancelWait, receiveWaits, reopenWait } from "@/actions/part-waits";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function TicketWaitsSlot({ ticketId, user, canWork }: { ticketId: string; user: CurrentUser; canWork: boolean }) {
  const shopId = user.shopId;
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId }, select: { status: true, customer: { select: { name: true, phone: true } } } });
  if (!t) return null;
  const [waits, tz, tell] = await Promise.all([waitsForTicket(shopId, ticketId), shopTimeZone(shopId), noticesOn(shopId)]);
  const closed = CLOSING_STATUSES.includes(t.status);
  const open = waits.filter((w) => !w.receivedAt && !w.cancelledAt);
  const done = waits.filter((w) => w.receivedAt || w.cancelledAt).slice(0, 5);
  // Nothing to show on a ticket that never waited for anything and can't take a new wait.
  if (!waits.length && (closed || !canWork)) return null;
  const waiting = t.status === "WAITING_PARTS";
  const now = new Date().getTime();
  return (
    <Section
      title={open.length ? `Waiting on ${open.length === 1 ? "a part" : `${open.length} parts`}` : "Parts on order"}
      actions={
        <Link href="/parts/on-order" className="btn btn-sm">
          Everything on order
        </Link>
      }
    >
      <div className="space-y-3 text-sm">
        {waiting && !open.length && canWork && <p className="pill tone-wait">The status says Waiting on parts, but nothing is recorded on order. Say which part below, so the customer can be told when it comes in.</p>}
        {open.length > 0 && (
          <ul className="divide-y divide-line">
            {open.map((w) => (
              <li key={w.id} className="space-y-2 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold">{w.description}</span>
                  {w.qty !== 1 && <span className="muted">x{w.qty}</span>}
                  {w.part && <span className="mono muted text-xs">{w.part.partNumber}</span>}
                  {w.supplier && <span className="muted">from {w.supplier}</span>}
                  <span className="muted">ordered {fmtDate(w.orderedAt, tz)}</span>
                  {w.expectedOn && <span className={`pill ${w.expectedOn < new Date().toISOString().slice(0, 10) ? "tone-bad" : "tone-wait"}`}>expected {w.expectedOn}</span>}
                </div>
                {w.note && <div className="muted text-xs whitespace-pre-wrap">{w.note}</div>}
                {canWork && (
                  <div className="flex flex-wrap items-end gap-2">
                    <ActionForm action={receiveWaits.bind(null, w.id)} className="flex flex-wrap items-end gap-2">
                      <div className="field">
                        <label htmlFor={`eta-${w.id}`} className="label">
                          Done by (optional, goes in the message)
                        </label>
                        <input id={`eta-${w.id}`} name="eta" type="date" className="input" />
                      </div>
                      {waiting && (
                        <label className="flex items-center gap-2 pb-2">
                          <input type="checkbox" name="backOnBench" className="check" defaultChecked /> Put it back on the bench
                        </label>
                      )}
                      <Submit className="btn btn-sm btn-primary">Received</Submit>
                    </ActionForm>
                    <ActionForm action={cancelWait.bind(null, w.id)} success="Cancelled" className="flex items-end gap-2">
                      <div className="field">
                        <label htmlFor={`why-${w.id}`} className="label">
                          Not coming: why
                        </label>
                        <input id={`why-${w.id}`} name="why" className="input w-44" placeholder="discontinued, wrong part..." />
                      </div>
                      <Submit className="btn btn-sm">Cancel the order</Submit>
                    </ActionForm>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {open.length > 0 && !tell && (
          <p className="muted text-xs">
            Email and texts aren&apos;t set up, so nothing is sent when a part comes in: call {t.customer?.name ?? "the customer"}
            {t.customer?.phone ? ` at ${t.customer.phone}` : ""}.
          </p>
        )}
        {done.length > 0 && (
          <ul className="muted divide-y divide-line text-xs">
            {done.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-x-3 py-1">
                <span>{w.description}</span>
                {w.receivedAt ? (
                  <>
                    <span>received {fmtDate(w.receivedAt, tz)}{w.receivedBy ? ` by ${w.receivedBy}` : ""}</span>
                    {w.noticedAt ? <span className="pill tone-ready">customer told</span> : <span className="pill tone-neutral">not sent</span>}
                    {canWork && now - w.receivedAt.getTime() < REOPEN_WINDOW_MS && (
                      <ActionButton action={reopenWait.bind(null, w.id)} className="btn btn-sm" success="Reopened" confirm="Mark it not received? A queued message is cancelled.">
                        Not received after all
                      </ActionButton>
                    )}
                  </>
                ) : (
                  <span>cancelled {w.cancelledAt ? fmtDate(w.cancelledAt, tz) : ""}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {canWork && !closed && (
          <details open={waiting && !open.length}>
            <summary className="cursor-pointer font-semibold">Waiting on a part</summary>
            <ActionForm action={addWait.bind(null, ticketId)} success="Recorded" className="mt-2 space-y-3">
              <div className="grid-form">
                <div className="field">
                  <label htmlFor="pw-number" className="label">
                    Part number (if you stock it)
                  </label>
                  <input id="pw-number" name="partNumber" className="input mono" autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor="pw-desc" className="label">
                    What it is (the customer reads this)
                  </label>
                  <input id="pw-desc" name="description" className="input" placeholder="Bobbin case" autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor="pw-qty" className="label">
                    Quantity
                  </label>
                  <input id="pw-qty" name="qty" className="input num w-24" inputMode="decimal" defaultValue="1" />
                </div>
                <div className="field">
                  <label htmlFor="pw-supplier" className="label">
                    Supplier
                  </label>
                  <input id="pw-supplier" name="supplier" className="input" autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor="pw-expected" className="label">
                    Expected
                  </label>
                  <input id="pw-expected" name="expectedOn" type="date" className="input" />
                </div>
                <div className="field">
                  <label htmlFor="pw-note" className="label">
                    Note
                  </label>
                  <input id="pw-note" name="note" className="input" />
                </div>
              </div>
              {!waiting && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="markWaiting" className="check" defaultChecked /> Mark the ticket Waiting on parts
                </label>
              )}
              <Submit className="btn">Record the part on order</Submit>
            </ActionForm>
          </details>
        )}
      </div>
    </Section>
  );
}
