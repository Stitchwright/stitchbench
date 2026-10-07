// "Colors she bought" on a customer's page (shop-features-round-2-design.md 2.2): the threads, filament and other items
// with a color she bought, newest first, with what is on the shelf now, for "the same as last time". Nothing when none.
import Link from "next/link";
import { colorsBoughtBy } from "@/lib/colors";
import { Section } from "@/components/ui";
import { ColorDot } from "@/components/color-dot";
import { qtyText } from "@/lib/register-math";

export async function CustomerColors({ shopId, customerId }: { shopId: string; customerId: string }) {
  const hits = await colorsBoughtBy(shopId, customerId);
  if (!hits.length) return null;
  return (
    <Section title="Colors bought before">
      <ul className="divide-y divide-line">
        {hits.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <ColorDot hex={h.colorHex} />
              <Link href={`/parts/${h.id}`} className="link">
                {h.details || h.description}
              </Link>
            </span>
            <span className="text-sm">
              {h.qtyOnHand > 0 ? `${qtyText(h.qtyOnHand, h.unit)} on the shelf` : <span className="pill tone-wait">none on the shelf</span>}
              <span className="muted"> · last bought {h.boughtText}</span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
