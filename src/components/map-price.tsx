// Minimum advertised price (shop-features-round-2-design.md 9.3): an item's or a machine's MAP box, and the list of
// prices that would advertise below one (on the sales settings and the campaign pages). Server components.
import Link from "next/link";
import { money } from "@/lib/format";
import { belowMap } from "@/lib/map-math";
import { mapProblems } from "@/lib/map-prices";
import { saveMapPrice } from "@/actions/map-prices";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export function MapPriceSection({ what, id, priceCents, mapCents, admin, online }: { what: "part" | "unit"; id: string; priceCents: number | null; mapCents: number | null; admin: boolean; online?: boolean }) {
  const below = belowMap(priceCents, mapCents);
  if (!admin && mapCents == null) return null;
  return (
    <Section title="Minimum advertised price">
      {below && (
        <p className="mb-2 text-base" role="note">
          <span className="pill tone-bad mr-2">Below the minimum</span>
          {money(priceCents)} is under the maker&apos;s {money(mapCents)}.{" "}
          {online ? "Online it shows " + money(mapCents) + " and \"Add to cart to see our price\"; the cart shows the real price." : "Don't advertise this price."}
        </p>
      )}
      {admin ? (
        <ActionForm action={saveMapPrice.bind(null, what, id)} className="flex flex-wrap items-end gap-2">
          <div className="field">
            <label className="label" htmlFor={`map-${id}`}>
              The maker&apos;s minimum advertised price ($)
            </label>
            <input id={`map-${id}`} name="map" inputMode="decimal" className="input num w-32" defaultValue={mapCents == null ? "" : (mapCents / 100).toFixed(2)} />
            <p className="muted text-sm">Blank if the maker sets none. The price in the shop can still be lower.</p>
          </div>
          <Submit className="btn">Save</Submit>
        </ActionForm>
      ) : (
        <p className="text-base">The maker&apos;s minimum advertised price: {money(mapCents)}</p>
      )}
    </Section>
  );
}

/** Prices that would advertise below a minimum advertised price; nothing when there are none. */
export async function MapWarnings({ shopId, promosOnly = false }: { shopId: string; promosOnly?: boolean }) {
  const rows = (await mapProblems(shopId)).filter((r) => !promosOnly || r.where.startsWith("the sale"));
  if (!rows.length) return null;
  return (
    <div className="card card-pad space-y-1 text-base" role="note">
      <p className="font-semibold">Below the maker&apos;s minimum advertised price</p>
      <ul className="space-y-1">
        {rows.slice(0, 12).map((r) => (
          <li key={r.key}>
            <Link href={r.href} className="link">
              {r.what}
            </Link>{" "}
            {money(r.priceCents)} (minimum {money(r.mapCents)}) in {r.where}
          </li>
        ))}
      </ul>
      {rows.length > 12 && <p className="muted text-sm">and {rows.length - 12} more</p>}
    </div>
  );
}
