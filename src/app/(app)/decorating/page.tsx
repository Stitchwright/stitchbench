// Decorating (docs/plans/decorators-proposal.md): the open orders (soonest due first), "Take an order", the latest finished
// ones, and for an owner or admin the price table (stitch tiers, quantity breaks, fees, the machine's speed).
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { decorPrices, ordersFor, type OrderRow } from "@/lib/decor";
import { DECOR_TONE, breaksText, decorStatusLabel, tiersText } from "@/lib/decor-math";
import { saveDecorPrices, startDecorOrder } from "@/actions/decorating";
import { ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { Empty, Section } from "@/components/ui";
import { DecorFrame, decorPageState } from "@/components/decorating/decor-page";

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
          </span>
          <span className="flex flex-wrap items-center gap-2 text-base">
            <span className="num">{money(o.quoteCents)}</span>
            {o.dueAt && <span className={o.overdue ? "pill tone-bad" : "muted text-sm"}>{o.overdue ? "late: " : "by "}{fmtDate(o.dueAt, tz)}</span>}
            <span className={`pill ${DECOR_TONE[o.status] ?? ""}`}>{decorStatusLabel(o.status)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function DecoratingPage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const [s, open, done, prices, tz] = await Promise.all([decorPageState(user), ordersFor(shopId), ordersFor(shopId, { closed: true, take: 30 }), decorPrices(shopId), shopTimeZone(shopId)]);
  const write = s.gate === "write";
  const dollars = (c: number) => (c / 100).toFixed(2);
  return (
    <DecorFrame
      title="Decorating"
      what="Decorating orders"
      sub="Embroidery orders from quote to pickup: the garments, the design on each, a price from your stitch-count table, collected and paid at the register."
      actions={
        <Link href="/decorating/production" className="btn">
          Production list
        </Link>
      }
      {...s}
    >
      <Section title={`Open (${open.length})`}>{open.length ? <Rows rows={open} tz={tz} /> : <Empty>No open orders. When a customer asks for embroidery, take the order below.</Empty>}</Section>
      {write && (
        <Section title="Take an order">
          <ActionForm action={startDecorOrder} className="grid gap-3 sm:grid-cols-2">
            <CustomerPicker initial={null} />
            <div className="field sm:col-span-2">
              <label className="label" htmlFor="do-title">
                What is it?
              </label>
              <input id="do-title" name="title" className="input" required maxLength={120} placeholder="Riverside Fire Dept polos" />
            </div>
            <div className="field">
              <label className="label" htmlFor="do-due">
                Wanted by
              </label>
              <input id="do-due" name="due" type="date" className="input" />
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
            <div className="sm:col-span-2">
              <Submit className="btn">Save the prices</Submit>
            </div>
          </ActionForm>
        </Section>
      )}
    </DecorFrame>
  );
}
