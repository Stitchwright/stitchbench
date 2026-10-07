// A customer's special orders and pre-orders on her page (shop-features-round-2-design.md 1.2): the open ones first
// with where each is and what is left, then the last few done; nothing when she has none.
import Link from "next/link";
import { money } from "@/lib/format";
import { specialOrdersFor } from "@/lib/special-orders";
import { Section } from "@/components/ui";

export async function CustomerSpecialOrders({ shopId, customerId }: { shopId: string; customerId: string }) {
  const all = await specialOrdersFor(shopId, { customerId, take: 30 });
  if (!all.length) return null;
  const open = all.filter((o) => ["WAITING", "ORDERED", "HERE"].includes(o.status));
  const done = all.filter((o) => !open.includes(o)).slice(-3);
  return (
    <Section title="Special orders">
      <ul className="divide-y divide-line text-base">
        {[...open, ...done].map((o) => (
          <li key={o.id} className="flex flex-wrap justify-between gap-2 py-2">
            <Link href={`/special-orders/${o.id}`} className="link">
              {o.kind === "PREORDER" ? "Pre-order" : "Special order"} {o.number}: {o.description}
            </Link>
            <span>
              <span className={`pill ${o.status === "HERE" ? "tone-ready" : "tone-neutral"}`}>{o.statusWords}</span>
              {open.includes(o) && o.leftCents > 0 ? ` ${money(o.leftCents)} left` : ""}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
