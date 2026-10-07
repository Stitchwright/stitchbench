// "Fits their machines" on a customer's page (shop-features-round-2-design.md 2.4): for each machine they own, what is on
// the shelf that fits it (its own models or a fit group). Nothing when none of their machines has anything.
import Link from "next/link";
import { fitsForCustomer } from "@/lib/fits";
import { Section } from "@/components/ui";
import { money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";

export async function CustomerFitsSection({ shopId, customerId }: { shopId: string; customerId: string }) {
  const fits = await fitsForCustomer(shopId, customerId, 12);
  if (!fits.length) return null;
  return (
    <Section title="Fits their machines">
      <div className="space-y-4">
        {fits.map((f) => (
          <div key={f.machineId}>
            <h3 className="text-base font-semibold">
              {f.label}: {f.items.length} {f.items.length === 1 ? "item" : "items"} on the shelf
            </h3>
            <ul className="divide-y divide-line">
              {f.items.map((it) => (
                <li key={it.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <Link href={`/parts/${it.id}`} className="link">
                    {it.description}
                  </Link>
                  <span className="text-sm">
                    {qtyText(it.qtyOnHand, it.unit)} on the shelf · {money(it.priceCents)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
