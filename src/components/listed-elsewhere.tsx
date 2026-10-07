// "Also listed on" (shop-features-round-2-design.md 9.7): where else a machine or an item is for sale (eBay, Etsy,
// Marketplace) with the links; the register asks to take those down when it sells. Server component.
import { LISTED_PLACES, placesText, readListed } from "@/lib/listed-math";
import { saveListed } from "@/actions/commissions";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export function ListedSection({ what, id, listedOn }: { what: "part" | "unit"; id: string; listedOn: unknown }) {
  const list = readListed(listedOn);
  const has = (p: string) => list.find((x) => x.where.toLowerCase() === p.toLowerCase());
  const other = list.find((x) => !(LISTED_PLACES as readonly string[]).some((p) => p.toLowerCase() === x.where.toLowerCase()));
  return (
    <Section title="Also listed on">
      {list.length > 0 && (
        <p className="mb-2 text-base">
          For sale on {placesText(list)} too.{" "}
          {list
            .filter((x) => x.url)
            .map((x) => (
              <a key={x.where} href={x.url!} target="_blank" rel="noreferrer" className="link mr-2">
                Open on {x.where}
              </a>
            ))}
          <span className="muted block text-sm">Selling it at the register asks you to take it down there first.</span>
        </p>
      )}
      <details>
        <summary className="link cursor-pointer text-sm">{list.length ? "Change" : "Listed on eBay, Etsy or Marketplace too?"}</summary>
        <ActionForm action={saveListed.bind(null, what, id)} className="mt-2 space-y-2">
          {LISTED_PLACES.map((p) => (
            <div key={p} className="flex flex-wrap items-center gap-2">
              <label className="flex min-h-11 w-56 items-center gap-2 text-base">
                <input type="checkbox" name="place" value={p} className="check" defaultChecked={!!has(p)} /> {p}
              </label>
              <input name={`url:${p}`} aria-label={`Link on ${p}`} className="input min-w-64 flex-1" placeholder="https://... (optional)" defaultValue={has(p)?.url ?? ""} />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <input name="otherPlace" aria-label="Somewhere else" className="input w-56" placeholder="Somewhere else" defaultValue={other?.where ?? ""} />
            <input name="url:other" aria-label="Link somewhere else" className="input min-w-64 flex-1" placeholder="https://... (optional)" defaultValue={other?.url ?? ""} />
          </div>
          <Submit className="btn">Save</Submit>
        </ActionForm>
      </details>
    </Section>
  );
}
