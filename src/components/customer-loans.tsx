// What a customer has of the shop's (shop-features-round-2-design.md 1.7 and 1.8): loaners, demos and rentals out with
// her, due days; nothing when she has none.
import Link from "next/link";
import { fmtYmdLong } from "@/lib/units/units";
import { LOAN_KIND_LABEL, loansFor } from "@/lib/loans";
import { Section } from "@/components/ui";

export async function CustomerLoans({ shopId, customerId }: { shopId: string; customerId: string }) {
  const out = await loansFor(shopId, { customerId, out: true });
  if (!out.length) return null;
  return (
    <Section title="Machines out with her">
      <ul className="divide-y divide-line text-base">
        {out.map((l) => (
          <li key={l.id} className="flex flex-wrap justify-between gap-2 py-2">
            <Link href={`/units/loans/${l.id}`} className="link">
              {LOAN_KIND_LABEL[l.kind]}: {l.machine}
            </Link>
            <span>
              {l.dueOn ? `due ${fmtYmdLong(l.dueOn)}` : ""}
              {l.overdue && <span className="pill tone-wait ml-2">Overdue</span>}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
