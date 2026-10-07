import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDateTime, money } from "@/lib/format";
import { REASON_LABEL, type EntryReason } from "@/lib/gift-cards";
import { lastFour } from "@/lib/gift-card-number";
import { Section } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { giveStoreCredit } from "@/actions/gift-cards";

/** "Store credit" on the customer page: what they hold, its recent history, and (owner, admin) giving some with a reason. */
export async function StoreCreditSection({ shopId, role, customerId, timeZone }: { shopId: string; role: "OWNER" | "ADMIN" | "TECH"; customerId: string; timeZone: string }) {
  const cards = await db.giftCard.findMany({
    where: { shopId, customerId },
    orderBy: { issuedAt: "asc" },
    include: { entries: { orderBy: [{ at: "desc" }, { id: "desc" }], take: 5 } },
  });
  const credit = cards.filter((c) => c.kind === "credit" && c.status === "active");
  const balance = credit.reduce((s, c) => s + c.balanceCents, 0);
  if (!cards.length && role === "TECH") return null;
  return (
    <Section title="Store credit">
      <div className="mb-2 text-sm">
        Holds <span className="num text-lg font-bold" data-testid="credit-balance">{money(balance)}</span>
        {balance > 0 && <span className="muted"> · pick this customer at the register and press Store credit to spend it</span>}
      </div>
      {cards.length > 0 && (
        <ul className="mb-3 divide-y divide-line text-sm">
          {cards.map((c) => (
            <li key={c.id} className="py-2">
              <Link href={`/register/gift-cards/${c.id}`} className="link">
                {c.kind === "credit" ? "Store credit" : "Gift card"} ending {lastFour(c.number)}
              </Link>{" "}
              <span className="num">{money(c.balanceCents)}</span>
              {c.status !== "active" && <span className="pill tone-neutral ml-2">void</span>}
              <ul className="muted mt-1 text-xs">
                {c.entries.map((e) => (
                  <li key={e.id}>
                    {fmtDateTime(e.at, timeZone)} · {REASON_LABEL[e.reason as EntryReason] ?? e.reason} · {e.amountCents > 0 ? `+${money(e.amountCents)}` : `-${money(-e.amountCents)}`}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {role !== "TECH" && (
        <ActionForm action={giveStoreCredit.bind(null, customerId)} reset success="Store credit given" className="flex flex-wrap items-end gap-2">
          <div className="field">
            <label htmlFor="sc-amount" className="label">
              Give store credit ($)
            </label>
            <input id="sc-amount" name="amount" inputMode="decimal" className="input num w-28" required />
          </div>
          <div className="field min-w-40 flex-1">
            <label htmlFor="sc-reason" className="label">
              Why
            </label>
            <input id="sc-reason" name="reason" className="input" required />
          </div>
          <Submit>Give credit</Submit>
        </ActionForm>
      )}
    </Section>
  );
}
