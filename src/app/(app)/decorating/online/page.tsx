// Decorating › Online orders (docs/plans/makerfoundry-orders-plan.md package 2): take orders from MakerFoundry, what the shop sells
// there and at what price. Owner or admin. Customers are charged only the prices published here.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { onlineView } from "@/lib/shop-orders/online";
import { breaksText, METHOD_WORDS, type OfferIn } from "@/lib/shop-orders/catalog";
import { publishOnlineCatalog, removeOnlineOffer, removeOnlineProduct, saveOnlineOffer, saveOnlineProduct, saveOnlineShipping, setOnlineOrders } from "@/actions/online-orders";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Empty, Section } from "@/components/ui";
import { DecorFrame, decorPageState } from "@/components/decorating/decor-page";

export default async function OnlineOrdersPage() {
  const user = await requireUser();
  const [s, tz] = await Promise.all([decorPageState(user, true), shopTimeZone(user.shopId)]);
  const write = s.gate === "write";
  if (!s.admin) {
    return (
      <DecorFrame title="Online orders" sub="Orders from MakerFoundry." {...s}>
        <Empty>Only an owner or admin sets what the shop sells through MakerFoundry.</Empty>
      </DecorFrame>
    );
  }
  const v = await onlineView(user.shopId);
  const r = v.row;
  const state = r.upgradeNeeded ? "update" : r.optedIn ? "on" : "off";
  return (
    <DecorFrame
      title="Online orders"
      what="Online orders"
      sub="Customers order decorated garments from your shop on MakerFoundry and pay there. The order arrives here as a decorating order, already paid."
      actions={
        <Link href="/decorating" className="btn">
          All orders
        </Link>
      }
      {...s}
    >
      <Section title="Take orders from MakerFoundry">
        <p className="mb-2 text-base">
          {state === "on" && <span className="pill tone-ready">Taking orders</span>}
          {state === "off" && <span className="pill tone-neutral">Not taking orders</span>}
          {state === "update" && <span className="pill tone-bad">Update needed</span>}{" "}
          {r.catalogPublishedAt && <span className="muted text-sm">Catalogue published {fmtDate(r.catalogPublishedAt, tz)}.</span>}
        </p>
        {r.upgradeNeeded && <p className="mb-2 text-base">{r.upgradeNeeded}</p>}
        {r.lastError && state === "on" && <p className="muted mb-2 text-sm">Last try to reach the hub: {r.lastError}</p>}
        {v.failedOut > 0 && <p className="mb-2 text-base">{v.failedOut} {v.failedOut === 1 ? "message was" : "messages were"} refused by the hub and will not be sent again.</p>}
        {!v.hub && <p className="muted mb-2 text-sm">Join the community hub first (Settings → StitchHub): orders come through it.</p>}
        {write && (
          <ActionForm action={setOnlineOrders} success="Saved" className="flex flex-wrap items-end gap-3">
            <div className="field">
              <label className="label" htmlFor="oo-max">
                Most open orders at once
              </label>
              <input id="oo-max" name="maxOpen" inputMode="numeric" className="input num w-28" defaultValue={r.maxOpen} />
            </div>
            <input type="hidden" name="on" value={r.optedIn ? "off" : "on"} />
            <Submit className="btn btn-primary">{r.optedIn ? "Stop taking new orders" : "Take orders from MakerFoundry"}</Submit>
          </ActionForm>
        )}
        <p className="muted mt-2 text-sm">
          MakerFoundry takes the customer&apos;s payment and keeps 10%; you pay the card fee. Your share is on each order. Customers are charged only the prices below, as last published.
        </p>
      </Section>

      <Section title="Garments you sell">
        {v.products.length === 0 ? (
          <Empty>No garments yet. Add the blanks you can supply: the price here is what a customer pays for the garment before the decoration.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {v.products.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-base">
                  <span className="font-semibold">{p.name}</span> <span className="muted text-sm">· {p.sku} · {p.colours} · {p.sizes}</span>
                </span>
                <span className="flex items-center gap-2 text-base">
                  <span className="num">{money(p.blankCents)}</span>
                  {write && (
                    <ActionButton action={removeOnlineProduct.bind(null, p.id)} confirm="Remove?" success="Removed">
                      Remove
                    </ActionButton>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {write && (
          <ActionForm action={saveOnlineProduct} success="Saved" className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="field">
              <label className="label" htmlFor="op-name">
                Garment
              </label>
              <input id="op-name" name="name" className="input" maxLength={120} placeholder="Heavy cotton tee" />
            </div>
            <div className="field">
              <label className="label" htmlFor="op-sku">
                Code (yours; the same code again changes it)
              </label>
              <input id="op-sku" name="sku" className="input" maxLength={60} placeholder="TEE-01" />
            </div>
            <div className="field">
              <label className="label" htmlFor="op-colours">
                Colours (commas)
              </label>
              <input id="op-colours" name="colours" className="input" maxLength={600} placeholder="Black, Navy, White" />
            </div>
            <div className="field">
              <label className="label" htmlFor="op-sizes">
                Sizes (commas)
              </label>
              <input id="op-sizes" name="sizes" className="input" maxLength={200} placeholder="S, M, L, XL" />
            </div>
            <div className="field">
              <label className="label" htmlFor="op-blank">
                The garment itself ($)
              </label>
              <input id="op-blank" name="blank" inputMode="decimal" className="input num w-28" placeholder="9.00" />
            </div>
            <div className="field">
              <label className="label" htmlFor="op-kind">
                Kind
              </label>
              <input id="op-kind" name="kind" className="input" maxLength={30} defaultValue="shirt" />
            </div>
            <div className="sm:col-span-2">
              <Submit className="btn btn-primary">Save the garment</Submit>
            </div>
          </ActionForm>
        )}
      </Section>

      <Section title="Decorations you offer">
        {v.offers.length === 0 ? (
          <Empty>No decorations yet. Each is a flat price for each piece, lower for more pieces.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {v.offers.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-base">
                  <span className="font-semibold">{METHOD_WORDS[o.method as keyof typeof METHOD_WORDS] ?? o.method}, {o.placement.toLowerCase()}</span>{" "}
                  <span className="muted text-sm">
                    · {(o.breaks as OfferIn["breaks"]).map((b) => `${b.min}+ ${money(b.cents)}`).join(", ")} each · set-up {money(o.setupCents)}
                    {o.maxStitches ? ` · up to ${o.maxStitches.toLocaleString("en-US")} stitches` : ""}
                  </span>
                </span>
                {write && (
                  <ActionButton action={removeOnlineOffer.bind(null, o.id)} confirm="Remove?" success="Removed">
                    Remove
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {write && (
          <ActionForm action={saveOnlineOffer} success="Saved" className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="field">
              <label className="label" htmlFor="of-method">
                Method
              </label>
              <select id="of-method" name="method" className="select" defaultValue="embroidery">
                <option value="embroidery">Embroidery</option>
                <option value="screen_print">Screen print</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="of-place">
                Where it goes
              </label>
              <input id="of-place" name="placement" className="input" maxLength={40} placeholder="Left chest" />
            </div>
            <div className="field">
              <label className="label" htmlFor="of-breaks">
                Price each piece, by quantity
              </label>
              <textarea id="of-breaks" name="breaks" rows={3} className="textarea num" defaultValue={breaksText([{ min: 1, cents: 1200 }, { min: 12, cents: 1000 }])} />
              <p className="muted text-sm">Pieces from, a colon, dollars each. The first line is 1 piece. The garment is added to this.</p>
            </div>
            <div className="field">
              <label className="label" htmlFor="of-setup">
                Set-up for the order ($)
              </label>
              <input id="of-setup" name="setup" inputMode="decimal" className="input num w-28" defaultValue="0" />
              <label className="label mt-2" htmlFor="of-max">
                Biggest design the price covers (stitches)
              </label>
              <input id="of-max" name="maxStitches" inputMode="numeric" className="input num w-28" placeholder="8000" />
              <p className="muted text-sm">A bigger design is yours to turn down, with a full refund.</p>
            </div>
            <div className="sm:col-span-2">
              <Submit className="btn btn-primary">Save the decoration</Submit>
            </div>
          </ActionForm>
        )}
      </Section>

      <Section title="Shipping">
        <p className="muted mb-2 text-sm">Orders are pickup only until you decide how shipping is priced and who collects sales tax; the catalogue says pickup.</p>
        {write && (
          <ActionForm action={saveOnlineShipping} success="Saved" className="flex flex-wrap items-end gap-3">
            <label className="flex min-h-11 items-center gap-2 text-base">
              <input type="checkbox" name="ships" value="on" className="check" defaultChecked={r.shipsOrders} /> I ship orders
            </label>
            <div className="field">
              <label className="label" htmlFor="sh-cents">
                Flat shipping for an order ($)
              </label>
              <input id="sh-cents" name="shipping" inputMode="decimal" className="input num w-28" defaultValue={(r.shippingCents / 100).toFixed(2)} />
            </div>
            <Submit className="btn">Save shipping</Submit>
          </ActionForm>
        )}
      </Section>

      {write && r.optedIn && (
        <Section title="Catalogue">
          <p className="muted mb-2 text-sm">Every change above is published at once. Publish again if you want to be sure customers see the latest.</p>
          <ActionButton action={publishOnlineCatalog} className="btn" success="Published">
            Publish the catalogue again
          </ActionButton>
        </Section>
      )}
    </DecorFrame>
  );
}
