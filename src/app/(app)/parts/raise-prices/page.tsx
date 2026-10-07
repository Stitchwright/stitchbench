// Raise prices (shop-features-round-2-design.md 4.4): choose whose prices (a supplier, a maker, a kind, a collection, or
// the items under the margin floor), by how much and how to round; the page shows the old and new price of every item;
// "Raise them" writes them, and "Undo" puts them back for a day. Owners and admins; a tech sees the page but can't raise.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";
import { ROUNDINGS, isRounding, pctInput, ruleWords, type RaiseRule } from "@/lib/repricing-math";
import { previewRaise, raiseChoices, recentRaises, ruleFrom } from "@/lib/repricing";
import { isUserError } from "@/lib/user-error";
import { raisePrices, undoRaise } from "@/actions/repricing";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader, Section } from "@/components/ui";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const pctText = (m: number | null) => (m == null ? "-" : `${Math.round(m)}%`);

export default async function RaisePrices({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const shopId = user.shopId;
  const who = one(sp.who);
  const pctRaw = one(sp.pct);
  const round = isRounding(one(sp.round)) ? one(sp.round) : "99";
  const [choices, raises, tz] = await Promise.all([raiseChoices(shopId), recentRaises(shopId), shopTimeZone(shopId)]);
  let rule: RaiseRule | null = null;
  let problem: string | null = null;
  if (who) {
    try {
      const [whose, ...rest] = who.split("|");
      rule = ruleFrom({ whose, value: rest.join("|"), pct: pctInput(pctRaw), round });
    } catch (e) {
      if (!isUserError(e)) throw e;
      problem = e.message;
    }
  }
  let lines: Awaited<ReturnType<typeof previewRaise>> = [];
  if (rule) {
    try {
      lines = await previewRaise(shopId, rule);
    } catch (e) {
      if (!isUserError(e)) throw e;
      problem = e.message;
    }
  }
  const admin = user.role !== "TECH";
  const floorPick = who === "floor";
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Raise prices" sub="Raise a group of prices at once. You see every old and new price before anything changes, and Undo works for a day." back={{ href: "/parts", label: "Inventory" }} />

      <form method="get" className="card card-pad space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="field">
            <label htmlFor="rp-who" className="label">
              Whose prices
            </label>
            <select id="rp-who" name="who" defaultValue={who} className="select text-base" required>
              <option value="">Choose...</option>
              {choices.underFloor > 0 && <option value="floor">Under your margin floor ({choices.underFloor})</option>}
              {choices.supplier.length > 0 && (
                <optgroup label="Supplier">
                  {choices.supplier.map((s) => (
                    <option key={s} value={`supplier|${s}`}>
                      {s}
                    </option>
                  ))}
                </optgroup>
              )}
              {choices.brand.length > 0 && (
                <optgroup label="Maker">
                  {choices.brand.map((s) => (
                    <option key={s} value={`brand|${s}`}>
                      {s}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Kind">
                {choices.kind.map((k) => (
                  <option key={k.value} value={`kind|${k.value}`}>
                    {k.label}
                  </option>
                ))}
              </optgroup>
              {choices.collection.length > 0 && (
                <optgroup label="Collection">
                  {choices.collection.map((s) => (
                    <option key={s} value={`collection|${s}`}>
                      {s}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rp-pct" className="label">
              By how much (%)
            </label>
            <input id="rp-pct" name="pct" inputMode="decimal" defaultValue={pctRaw || "10"} className="input num text-base" placeholder="10" />
            <span className="muted text-sm">Not used for &ldquo;Under your margin floor&rdquo;: those go up to the floor.</span>
          </div>
          <div className="field">
            <label htmlFor="rp-round" className="label">
              Round the new prices
            </label>
            <select id="rp-round" name="round" defaultValue={round} className="select text-base">
              {Object.entries(ROUNDINGS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end">
          <button type="submit" className="btn min-h-11 text-base">
            Show the new prices
          </button>
        </div>
      </form>

      {problem && (
        <p className="card card-pad text-base" role="alert">
          {problem}
        </p>
      )}

      {rule && !problem && (
        <Section title={lines.length ? `${lines.length} item${lines.length === 1 ? "" : "s"}: ${ruleWords(rule)}` : "Nothing to change"}>
          {lines.length === 0 ? (
            <Empty>{floorPick ? "No item is under its margin floor." : "No item with a price matches, or the prices are already there."}</Empty>
          ) : (
            <>
              <div className="scroll-x">
                <table className="table text-base">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="text-right">Now</th>
                      <th className="text-right">New</th>
                      <th className="text-right">Margin now</th>
                      <th className="text-right">Margin after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.partId}>
                        <td>
                          <Link href={`/parts/${l.partId}`} className="link mono">
                            {l.partNumber}
                          </Link>
                          <div className="muted text-sm">{l.description}</div>
                        </td>
                        <td className="num text-right">
                          {money(l.oldCents)}
                          {l.unit === "yd" ? "/yd" : ""}
                        </td>
                        <td className="num text-right font-semibold">
                          {money(l.newCents)}
                          {l.unit === "yd" ? "/yd" : ""}
                        </td>
                        <td className="num text-right">{pctText(l.marginBefore)}</td>
                        <td className="num text-right">{pctText(l.marginAfter)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {admin ? (
                <ActionForm action={raisePrices} className="mt-4 flex justify-end">
                  <input type="hidden" name="who" value={who} />
                  <input type="hidden" name="pct" value={pctRaw} />
                  <input type="hidden" name="round" value={round} />
                  <Submit className="btn btn-primary min-h-11 text-base">
                    Raise them ({lines.length} item{lines.length === 1 ? "" : "s"})
                  </Submit>
                </ActionForm>
              ) : (
                <p className="muted mt-3 text-base">Only an owner or admin can change prices.</p>
              )}
            </>
          )}
        </Section>
      )}

      <Section title="Raises">
        {raises.length === 0 ? (
          <Empty>No prices raised here yet. Choose whose prices above, then Show the new prices.</Empty>
        ) : (
          <ul className="divide-y divide-line text-base">
            {raises.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {fmtWhen(r.at, tz)}: {r.count} item{r.count === 1 ? "" : "s"}, {ruleWords(r.rule)}
                  {r.undoneAt ? <span className="muted"> (undone)</span> : null}
                </span>
                {r.canUndo && admin && (
                  <ActionButton action={undoRaise.bind(null, r.id)} className="btn btn-sm min-h-11">
                    Undo
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
