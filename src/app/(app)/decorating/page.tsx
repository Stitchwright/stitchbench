// Decorating (docs/plans/decorators-proposal.md): the open orders (soonest due first), "Take an order", the latest finished
// ones, and for an owner or admin the price table (stitch tiers, quantity breaks, fees, the machine's speed).
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { decorPrices, ordersFor, type OrderRow } from "@/lib/decor";
import { inboxFor } from "@/lib/decor-inbox";
import { DECOR_TONE, breaksText, decorOrderLabel, screenRowsText, tiersText } from "@/lib/decor-math";
import { saveDecorPrices, startDecorOrder } from "@/actions/decorating";
import { ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { Empty, Section } from "@/components/ui";
import { DecorFrame, decorPageState } from "@/components/decorating/decor-page";
import { InboxSection } from "@/components/decorating/inbox";

function Rows({ rows, tz }: { rows: OrderRow[]; tz: string }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((o) => (
        <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="text-base">
            <Link href={`/decorating/${o.id}`} className="link">
              #{o.number} {o.title}
            </Link>{" "}
            <span className="muted text-sm">
              · {o.name} · {o.pieces} {o.pieces === 1 ? "piece" : "pieces"}
            </span>
            {o.online && <span className="pill tone-work ml-2">MakerFoundry</span>}
          </span>
          <span className="flex flex-wrap items-center gap-2 text-base">
            <span className="num">{money(o.quoteCents)}</span>
            {o.dueAt && <span className={o.overdue ? "pill tone-bad" : "muted text-sm"}>{o.overdue ? "late: " : "by "}{fmtDate(o.dueAt, tz)}</span>}
            <span className={`pill ${DECOR_TONE[o.status] ?? ""}`}>{decorOrderLabel(o.status, o.ship ? "SHIP" : null)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function DecoratingPage({ searchParams }: { searchParams: Promise<{ inbox?: string }> }) {
  const user = await requireUser();
  const shopId = user.shopId;
  const { inbox: inboxId } = await searchParams;
  const [s, open, done, prices, tz, inbox] = await Promise.all([decorPageState(user), ordersFor(shopId), ordersFor(shopId, { closed: true, take: 30 }), decorPrices(shopId), shopTimeZone(shopId), inboxFor(shopId)]);
  const write = s.gate === "write";
  const fromInbox = write ? inbox.items.find((i) => i.id === inboxId) ?? null : null;
  const dollars = (c: number) => (c / 100).toFixed(2);
  return (
    <DecorFrame
      title="Decorating"
      what="Decorating orders"
      sub="Embroidery and screen print orders from quote to pickup: the garments, the design on each, a price from your own tables, collected and paid at the register."
      actions={
        <>
          {s.admin && (
            <Link href="/decorating/online" className="btn">
              Online orders
            </Link>
          )}
          <Link href="/decorating/production" className="btn">
            Production list
          </Link>
        </>
      }
      {...s}
    >
      <Section title={`Open (${open.length})`}>{open.length ? <Rows rows={open} tz={tz} /> : <Empty>No open orders. When a customer asks for embroidery or printing, take the order below.</Empty>}</Section>
      {write && inbox.state !== "not-joined" && <InboxSection view={inbox} orders={open.filter((o) => o.status === "QUOTED" || o.status === "APPROVED").map((o) => ({ id: o.id, number: o.number, title: o.title }))} />}
      {write && (
        <Section title="Take an order">
          <ActionForm action={startDecorOrder} className="grid gap-3 sm:grid-cols-2">
            {fromInbox && (
              <div className="card card-pad space-y-2 sm:col-span-2" id="take">
                <input type="hidden" name="inboxItem" value={fromInbox.id} />
                <p className="text-base">
                  This order starts with <strong>{fromInbox.fileName}</strong> from StitchFoundry as its first decoration.
                </p>
                <div className="field">
                  <label className="label" htmlFor="do-loc">
                    Where it goes
                  </label>
                  <input id="do-loc" name="location" className="input" maxLength={40} defaultValue={fromInbox.meta.placement ?? "Left chest"} />
                </div>
              </div>
            )}
            <CustomerPicker initial={null} />
            <div className="field sm:col-span-2">
              <label className="label" htmlFor="do-title">
                What is it?
              </label>
              <input id="do-title" name="title" className="input" required maxLength={120} placeholder="Riverside Fire Dept polos" defaultValue={fromInbox?.meta.job ?? fromInbox?.meta.customer ?? ""} />
            </div>
            <div className="field">
              <label className="label" htmlFor="do-due">
                Wanted by
              </label>
              <input id="do-due" name="due" type="date" className="input" defaultValue={fromInbox?.meta.due ?? ""} />
            </div>
            <div className="field">
              <label className="label" htmlFor="do-note">
                Note
              </label>
              <input id="do-note" name="note" className="input" maxLength={1000} />
            </div>
            <label className="flex min-h-11 items-center gap-2 text-base">
              <input type="hidden" name="taxable" value="off" />
              <input type="checkbox" name="taxable" value="on" className="check" defaultChecked /> Taxable
            </label>
            <div className="sm:col-span-2">
              <Submit className="btn btn-primary">Take the order</Submit>
              <span className="muted ml-2 text-sm">Next: add the garments and the designs.</span>
            </div>
          </ActionForm>
        </Section>
      )}
      {done.length > 0 && (
        <Section title="Finished lately">
          <Rows rows={done} tz={tz} />
        </Section>
      )}
      {s.admin && write && (
        <Section title="Your prices">
          <p className="muted mb-2 text-sm">These are starting values: change them to your own. Orders already quoted keep the price they were quoted at.</p>
          <ActionForm action={saveDecorPrices} success="Saved" className="grid gap-3 sm:grid-cols-2">
            <div className="field">
              <label className="label" htmlFor="dp-tiers">
                Price for each piece, by stitch count
              </label>
              <textarea id="dp-tiers" name="tiers" rows={5} className="textarea num" defaultValue={tiersText(prices.tiers)} />
              <p className="muted text-sm">One line each: stitches up to, a colon, dollars. Like 5000: 6.00</p>
            </div>
            <div className="field">
              <label className="label" htmlFor="dp-breaks">
                Quantity breaks
              </label>
              <textarea id="dp-breaks" name="breaks" rows={5} className="textarea num" defaultValue={breaksText(prices.breaks)} />
              <p className="muted text-sm">Pieces from, a colon, percent off the decoration. Like 12: 5. Empty for none.</p>
            </div>
            <div className="field">
              <label className="label" htmlFor="dp-extra">
                Each extra 1,000 stitches past the last line ($)
              </label>
              <input id="dp-extra" name="extra" inputMode="decimal" className="input num w-28" defaultValue={dollars(prices.extraPer1000Cents)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="dp-dig">
                Digitizing a new design ($)
              </label>
              <input id="dp-dig" name="digitizing" inputMode="decimal" className="input num w-28" defaultValue={dollars(prices.digitizingCents)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="dp-setup">
                Set-up for each order ($)
              </label>
              <input id="dp-setup" name="setup" inputMode="decimal" className="input num w-28" defaultValue={dollars(prices.setupCents)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="dp-spm">
                Machine speed (stitches a minute)
              </label>
              <input id="dp-spm" name="spm" inputMode="numeric" className="input num w-28" defaultValue={prices.stitchesPerMinute} />
            </div>
            <div className="field">
              <label className="label" htmlFor="dp-cc">
                Seconds for a colour change
              </label>
              <input id="dp-cc" name="colorSeconds" inputMode="numeric" className="input num w-28" defaultValue={prices.colorChangeSeconds} />
            </div>
            <div className="field sm:col-span-2">
              <label className="label" htmlFor="dp-screen">
                Screen print: price for each piece, by quantity and colours
              </label>
              <textarea id="dp-screen" name="screenRows" rows={5} className="textarea num" defaultValue={screenRowsText(prices.screen.rows)} />
              <p className="muted text-sm">One line each: pieces from, a colon, then the price for 1 colour, 2 colours and so on. Like 24: 2.75, 3.50, 4.25. Fewer pieces than the first line pay its price.</p>
            </div>
            <div className="field">
              <label className="label" htmlFor="dp-sx">
                Each colour past the last column ($)
              </label>
              <input id="dp-sx" name="screenExtra" inputMode="decimal" className="input num w-28" defaultValue={dollars(prices.screen.extraColorCents)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="dp-sf">
                One screen, when it has to be made ($)
              </label>
              <input id="dp-sf" name="screenFee" inputMode="decimal" className="input num w-28" defaultValue={dollars(prices.screen.screenCents)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="dp-pph">
                Prints an hour through the press
              </label>
              <input id="dp-pph" name="printsPerHour" inputMode="numeric" className="input num w-28" defaultValue={prices.screen.printsPerHour} />
            </div>
            <div className="field">
              <label className="label" htmlFor="dp-ssu">
                Minutes to set up each colour on the press
              </label>
              <input id="dp-ssu" name="screenSetup" inputMode="numeric" className="input num w-28" defaultValue={prices.screen.setupMinutesPerColor} />
            </div>
            <div className="sm:col-span-2">
              <Submit className="btn">Save the prices</Submit>
            </div>
          </ActionForm>
        </Section>
      )}
    </DecorFrame>
  );
}
