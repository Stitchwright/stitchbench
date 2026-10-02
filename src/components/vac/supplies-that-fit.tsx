// Bags, belts and filters that fit a vacuum, on its machine page (modules-design.md 10.b): the first ten supplies, the
// shop's stock of each, and "All in the finder". Nothing unless the Vac Shop module is active.
import Link from "next/link";
import { money } from "@/lib/format";
import { getModules } from "@/lib/modules";
import type { CurrentUser } from "@/lib/session";
import { finderHref, suppliesFor } from "@/lib/vac/finder";
import { Empty, Section } from "@/components/ui";

const SHORT: Record<string, string> = {
  "Vacuum bag": "Bag",
  "Vacuum belt": "Belt",
  "Vacuum filter": "Filter",
};

export async function SuppliesThatFit({ brand, model, bagType, user }: { brand: string; model: string; bagType: string | null; user: CurrentUser }) {
  const mods = await getModules(user.shopId);
  if (!mods.states.vac.active) return null;
  const { supplies } = await suppliesFor(user.shopId, {
    brand,
    model,
    text: bagType,
  });
  const shown = supplies.slice(0, 10);
  const href = finderHref({ brand, model, text: bagType });
  return (
    <Section
      title="Bags, belts and filters"
      actions={
        <Link href={href} className="btn btn-sm">
          All in the finder
        </Link>
      }
    >
      {shown.length === 0 ? (
        <Empty>
          Nothing listed for the {brand} {model} yet.{" "}
          <Link href={href} className="link">
            Add what fits
          </Link>
          .
        </Empty>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {shown.map((s) => {
            const first = s.items[0];
            return (
              <li key={s.xpartId ?? `local:${first?.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="muted text-xs">{s.category ? SHORT[s.category] : "Other"} · </span>
                  {s.xpartId ? (
                    <Link href={`/xref/${s.xpartId}`} className="link">
                      {s.name}
                    </Link>
                  ) : (
                    <Link href={`/parts/${first?.id}`} className="link">
                      {s.name}
                    </Link>
                  )}
                  {s.numbers[0] && <span className="mono muted ml-2 text-xs">{s.numbers[0].number}</span>}
                  {s.close && <span className="pill tone-wait ml-2">Close match: {s.close}</span>}
                </span>
                {first ? (
                  <Link href={`/parts/${first.id}`} className={`pill ${first.qtyOnHand > 0 ? "tone-ready" : "tone-wait"}`}>
                    {first.qtyOnHand} on hand
                    {first.priceCents != null ? ` · ${money(first.priceCents)}` : ""}
                    {s.items.length > 1 ? ` · +${s.items.length - 1} more` : ""}
                  </Link>
                ) : (
                  <span className="muted text-xs">not stocked</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
