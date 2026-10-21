// One decorating order (docs/plans/decorators-proposal.md): where it stands with the one next step as the main button,
// the price as worked out and kept, the garments and the decorations (with each design file), collecting it (paid at the
// register), turning it down with a reason, and changing it while it is open.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { orderView } from "@/lib/decor";
import { DECOR_MOVES, DECOR_TONE, PLACEMENTS, decorStatusLabel } from "@/lib/decor-math";
import { addDecorLine, addDecorPlacement, collectDecorOrder, removeDecorLine, removeDecorPlacement, requoteDecorOrder, saveDecorOrder, setDecorStatus, turnDownDecorOrder } from "@/actions/decorating";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";
import { DecorFrame, decorPageState } from "@/components/decorating/decor-page";
import { ymdOf } from "@/lib/zoned";

const NEXT: Record<string, string> = { QUOTED: "APPROVED", APPROVED: "IN_PRODUCTION", IN_PRODUCTION: "READY" };
const NEXT_WORD: Record<string, string> = { APPROVED: "The customer approved it", IN_PRODUCTION: "Start production", READY: "It is ready" };

export default async function DecorOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const shopId = user.shopId;
  const [s, o, tz] = await Promise.all([decorPageState(user, true), orderView(shopId, id), shopTimeZone(shopId)]);
  if (!o) notFound();
  const write = s.gate === "write";
  const moves = DECOR_MOVES[o.status] ?? [];
  const next = NEXT[o.status];
  const editable = write && ["QUOTED", "APPROVED"].includes(o.status);
  const decorationCents = o.placements.reduce((t, p) => t + p.quotedEachCents * o.pieces, 0);
  return (
    <DecorFrame
      title={`Order #${o.number}: ${o.title}`}
      what="This order"
      sub={
        <>
          <span className={`pill ${DECOR_TONE[o.status] ?? ""}`}>{decorStatusLabel(o.status)}</span> for{" "}
          {o.customerId ? (
            <Link href={`/customers/${o.customerId}`} className="link">
              {o.name}
            </Link>
          ) : (
            o.name
          )}
          {o.dueAt ? ` · wanted by ${fmtDate(o.dueAt, tz)}` : ""}
        </>
      }
      actions={
        <span className="flex flex-wrap gap-2">
          <Link href={`/decorating/${o.id}/print`} className="btn" target="_blank">
            Production worksheet
          </Link>
          <Link href="/decorating" className="btn">
            All orders
          </Link>
        </span>
      }
      {...s}
    >
      {write && (next || moves.length > 0) && (
        <div className="card card-pad flex flex-wrap items-center gap-2">
          {next && (
            <ActionButton action={setDecorStatus.bind(null, o.id, next)} className="btn btn-primary">
              {NEXT_WORD[next] ?? decorStatusLabel(next)}
            </ActionButton>
          )}
          {moves
            .filter((to) => to !== next)
            .map((to) => (
              <ActionButton key={to} action={setDecorStatus.bind(null, o.id, to)} className="btn" confirm={to === "CANCELLED" ? "Tap again to cancel this order" : undefined}>
                {to === "CANCELLED" ? "Cancel the order" : `Back to ${decorStatusLabel(to).toLowerCase()}`}
              </ActionButton>
            ))}
        </div>
      )}
      {o.status === "READY" && write && (
        <div className="card card-pad space-y-2">
          <h2 className="text-base font-semibold">Picked up: take the payment</h2>
          <ActionForm action={collectDecorOrder.bind(null, o.id)} className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="do-method">
              Paid by
            </label>
            <select id="do-method" name="method" defaultValue="CASH" className="select w-32">
              <option value="CASH">Cash</option>
              <option value="CARD">Card</option>
              <option value="CHECK">Check</option>
              <option value="GIFT">Gift card</option>
              <option value="OTHER">Other</option>
            </select>
            <Submit className="btn btn-primary">Collected: take {money(o.quoteCents)} plus tax</Submit>
          </ActionForm>
        </div>
      )}
      {o.status === "TURNED_DOWN" && <p className="card card-pad text-base">Turned down: {o.turnedDownWhy}</p>}
      {o.sale && (
        <p className="text-base">
          Paid on{" "}
          <Link href={`/register/sales/${o.sale.id}`} className="link">
            sale #{o.sale.number}
          </Link>
          {o.collectedAt ? `, ${fmtDateTime(o.collectedAt, tz)}` : ""}.
        </p>
      )}

      <Section title={`Garments (${o.pieces} ${o.pieces === 1 ? "piece" : "pieces"})`}>
        {o.lines.length ? (
          <ul className="divide-y divide-line">
            {o.lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-base">
                <span>
                  {l.qty} × {l.description}
                  {l.color ? `, ${l.color}` : ""}
                  {l.sizes ? <span className="muted text-sm"> · {l.sizes}</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  <span className="num">{l.garmentCents > 0 ? `${money(l.garmentCents)} each = ${money(l.garmentCents * l.qty)}` : "customer brings them"}</span>
                  {editable && (
                    <ActionButton action={removeDecorLine.bind(null, o.id, l.id)} className="btn btn-sm">
                      Remove
                    </ActionButton>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted text-sm">No garments yet. Add what the decoration goes on.</p>
        )}
        {editable && (
          <details className="mt-2" open={o.lines.length === 0}>
            <summary className="link cursor-pointer text-sm">Add a garment</summary>
            <ActionForm action={addDecorLine.bind(null, o.id)} reset className="mt-2 grid gap-3 sm:grid-cols-2">
              <div className="field sm:col-span-2">
                <label className="label" htmlFor="dl-desc">
                  Garment
                </label>
                <input id="dl-desc" name="description" className="input" required maxLength={120} placeholder="Port Authority polo" />
              </div>
              <div className="field">
                <label className="label" htmlFor="dl-color">
                  Colour
                </label>
                <input id="dl-color" name="color" className="input" maxLength={40} />
              </div>
              <div className="field">
                <label className="label" htmlFor="dl-sizes">
                  Sizes and counts
                </label>
                <input id="dl-sizes" name="sizes" className="input" maxLength={120} placeholder="S 2, M 4, L 4" />
              </div>
              <div className="field">
                <label className="label" htmlFor="dl-qty">
                  How many (or leave empty to add up the sizes)
                </label>
                <input id="dl-qty" name="qty" inputMode="numeric" className="input num w-28" />
              </div>
              <div className="field">
                <label className="label" htmlFor="dl-garment">
                  You charge for each garment ($, empty if they bring them)
                </label>
                <input id="dl-garment" name="garment" inputMode="decimal" className="input num w-28" />
              </div>
              <div className="sm:col-span-2">
                <Submit className="btn">Add the garment</Submit>
              </div>
            </ActionForm>
          </details>
        )}
      </Section>

      <Section title="Decorations (on every piece)">
        {o.placements.length ? (
          <ul className="divide-y divide-line">
            {o.placements.map((p) => (
              <li key={p.id} className="space-y-1 py-2 text-base">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {p.location} <span className="muted text-sm font-normal">· embroidery</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="num">{money(p.quotedEachCents)} each</span>
                    {editable && (
                      <ActionButton action={removeDecorPlacement.bind(null, o.id, p.id)} className="btn btn-sm">
                        Remove
                      </ActionButton>
                    )}
                  </span>
                </div>
                <p className="muted text-sm">
                  {p.stitches.toLocaleString("en-US")} stitches · {p.colors} {p.colors === 1 ? "colour" : "colours"}
                  {p.widthMm != null && p.heightMm != null ? ` · ${p.widthMm} × ${p.heightMm} mm` : ""} · about {p.runMinutesEach} min a piece
                  {p.priceEachCents != null ? " · price agreed, not from the table" : ""}
                  {p.newDesign ? " · new design (digitizing fee)" : ""}
                </p>
                {p.hasFile && (
                  <p className="text-sm">
                    <a href={`/api/decorating/designs/${p.id}`} className="link">
                      Download {p.fileName}
                    </a>
                    <span className="muted"> · {p.fileReadable ? `${p.fileFormat} file, read` : `${p.fileFormat ?? "file"} kept as sent (stitch count typed)`}</span>
                  </p>
                )}
                {p.note && <p className="muted text-sm">{p.note}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted text-sm">No decorations yet. Add where each design goes and give its file or its stitch count.</p>
        )}
        {editable && (
          <details className="mt-2" open={o.placements.length === 0}>
            <summary className="link cursor-pointer text-sm">Add a decoration</summary>
            <ActionForm action={addDecorPlacement.bind(null, o.id)} reset className="mt-2 grid gap-3 sm:grid-cols-2">
              <div className="field">
                <label className="label" htmlFor="dpl-loc">
                  Where it goes
                </label>
                <input id="dpl-loc" name="location" list="decor-places" className="input" required maxLength={40} placeholder="Left chest" />
                <datalist id="decor-places">
                  {PLACEMENTS.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label className="label" htmlFor="dpl-file">
                  The design file (a DST is read for its stitch count)
                </label>
                <input id="dpl-file" name="file" type="file" className="input" accept=".dst,.pes,.jef,.exp,.vp3,.xxx,.u01,.hus,.pec,.sew,.shv,.csd,.pcs,.tbf,.emb,.ofm,.zip,.png,.jpg,.jpeg,.pdf,.ai,.svg" />
                <p className="muted text-sm">Kept with the order for repeat orders. 10 MB at most.</p>
              </div>
              <div className="field">
                <label className="label" htmlFor="dpl-st">
                  Stitches (when there is no DST)
                </label>
                <input id="dpl-st" name="stitches" inputMode="numeric" className="input num w-32" />
              </div>
              <div className="field">
                <label className="label" htmlFor="dpl-col">
                  Colours
                </label>
                <input id="dpl-col" name="colors" inputMode="numeric" className="input num w-24" defaultValue="1" />
              </div>
              <div className="field">
                <label className="label" htmlFor="dpl-w">
                  Width (mm)
                </label>
                <input id="dpl-w" name="width" inputMode="decimal" className="input num w-28" />
              </div>
              <div className="field">
                <label className="label" htmlFor="dpl-h">
                  Height (mm)
                </label>
                <input id="dpl-h" name="height" inputMode="decimal" className="input num w-28" />
              </div>
              <div className="field">
                <label className="label" htmlFor="dpl-price">
                  Agreed price for each piece ($, empty to use your table)
                </label>
                <input id="dpl-price" name="price" inputMode="decimal" className="input num w-28" />
              </div>
              <div className="field">
                <label className="label" htmlFor="dpl-note">
                  Note
                </label>
                <input id="dpl-note" name="note" className="input" maxLength={300} />
              </div>
              <label className="flex min-h-11 items-center gap-2 text-base sm:col-span-2">
                <input type="checkbox" name="newDesign" value="on" className="check" /> We digitized this design for this order (charge the digitizing fee)
              </label>
              <div className="sm:col-span-2">
                <Submit className="btn">Add the decoration</Submit>
              </div>
            </ActionForm>
          </details>
        )}
      </Section>

      <Section title="The price">
        <ul className="space-y-1 text-base">
          <li>
            Garments: {money(o.garmentCents)}
          </li>
          <li>Decoration: {money(decorationCents)}</li>
          {o.digitizingCents > 0 && <li>Digitizing: {money(o.digitizingCents)}</li>}
          {o.setupCents > 0 && <li>Set-up: {money(o.setupCents)}</li>}
          <li className="text-xl font-semibold">Total {money(o.quoteCents)} before tax</li>
          {o.runMinutesTotal > 0 && <li className="muted text-sm">About {Math.floor(o.runMinutesTotal / 60)} h {o.runMinutesTotal % 60} min on the machine for the whole order, at your set speed.</li>}
        </ul>
        {editable && s.admin && (
          <div className="mt-2">
            <ActionButton action={requoteDecorOrder.bind(null, o.id)} className="btn btn-sm">
              Work the price out again from today&apos;s table
            </ActionButton>
          </div>
        )}
      </Section>

      {o.note && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-base">{o.note}</p>
        </Section>
      )}
      {write && ["QUOTED", "APPROVED", "IN_PRODUCTION", "READY"].includes(o.status) && (
        <details className="card card-pad">
          <summary className="cursor-pointer text-base">Change the title, date or notes</summary>
          <ActionForm action={saveDecorOrder.bind(null, o.id)} className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="field sm:col-span-2">
              <label className="label" htmlFor="dc-title">
                What is it?
              </label>
              <input id="dc-title" name="title" className="input" required maxLength={120} defaultValue={o.title} />
            </div>
            <div className="field">
              <label className="label" htmlFor="dc-due">
                Wanted by
              </label>
              <input id="dc-due" name="due" type="date" className="input" defaultValue={o.dueAt ? ymdOf(o.dueAt, tz) : ""} />
            </div>
            <div className="field">
              <label className="label" htmlFor="dc-note">
                Note
              </label>
              <input id="dc-note" name="note" className="input" maxLength={1000} defaultValue={o.note ?? ""} />
            </div>
            <label className="flex min-h-11 items-center gap-2 text-base">
              <input type="hidden" name="taxable" value="off" />
              <input type="checkbox" name="taxable" value="on" className="check" defaultChecked={o.taxable} /> Taxable
            </label>
            <div className="sm:col-span-2">
              <Submit className="btn">Save</Submit>
            </div>
          </ActionForm>
        </details>
      )}
      {write && ["QUOTED", "APPROVED"].includes(o.status) && (
        <details className="card card-pad">
          <summary className="cursor-pointer text-base">Turn it down</summary>
          <ActionForm action={turnDownDecorOrder.bind(null, o.id)} className="mt-2 flex flex-wrap items-end gap-2">
            <div className="field min-w-64 flex-1">
              <label className="label" htmlFor="do-why">
                Why (a copied logo, a trademark you cannot use...)
              </label>
              <input id="do-why" name="why" className="input" maxLength={300} required />
            </div>
            <Submit className="btn">Turn it down</Submit>
          </ActionForm>
        </details>
      )}
    </DecorFrame>
  );
}
