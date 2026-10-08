// A customer's layaways on their page (tax-machine-sales-layaway-design.md section 4): the ones being paid for, with
// what is left; nothing when they have none.
import Link from "next/link";
import { money } from "@/lib/format";
import { listLayaways } from "@/lib/layaway";
import { fmtYmdLong } from "@/lib/units/units";
import { Section } from "@/components/ui";

export async function CustomerLayaways({ shopId, customerId }: { shopId: string; customerId: string }) {
  const open = await listLayaways(shopId, "OPEN", customerId);
  if (!open.length) return null;
  return (
    <Section title="Layaways">
      <ul className="divide-y divide-line text-sm">
        {open.map((l) => (
          <li key={l.id} className="flex flex-wrap justify-between gap-2 py-2">
            <Link href={`/layaways/${l.id}`} className="link">
              #{l.number}: {l.lines.map((x) => x.description).join(", ")}
            </Link>
            <span>
              {money(l.leftCents)} left, by {fmtYmdLong(l.dueBy)}
              {l.behindCents > 0 && <span className="pill tone-wait ml-2">{money(l.behindCents)} behind</span>}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
