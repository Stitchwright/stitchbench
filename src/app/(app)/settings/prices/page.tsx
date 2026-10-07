// Settings → Prices and members (shop-features-round-2-design.md 1.5 and 1.6): customer price groups and memberships
// (with discounts given, members and renewals due), the lifetime discount on a machine's supplies, the birthday offer
// and per-yard price breaks.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { fmtYmdLong } from "@/lib/units/units";
import { groupReport } from "@/lib/price-groups";
import { RULE_KINDS } from "@/lib/price-rules";
import { saveLifetimeDefault } from "@/actions/price-groups";
import { ActionForm, Submit } from "@/components/action-form";
import { PriceGroupForm } from "@/components/settings/price-group-form";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function PricesSettings() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const tz = await shopTimeZone(user.shopId);
  const today = ymdOf(new Date(), tz);
  const [report, shop] = await Promise.all([groupReport(user.shopId, today), db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { lifetimePctDefault: true } })]);
  const kindLabel = (k: string) => RULE_KINDS.find((x) => x.key === k)?.label ?? k;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Prices and members" sub="Discounts for groups of customers (the guild, teachers, a paid club card, wholesale), and the lifetime discount on a machine's supplies." back={{ href: "/settings", label: "Settings" }} />

      <Section title="Price groups">
        {report.groups.length === 0 ? (
          <Empty>No price groups yet. Add one below (&quot;Guild&quot;, 10% off), then put customers in it on their page.</Empty>
        ) : (
          <ul className="divide-y divide-line text-base">
            {report.groups.map((g) => (
              <li key={g.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="font-semibold">{g.name}</span>: {g.useWholesale ? "the wholesale price" : `${g.pctOff}% off`}
                    {g.kinds.length ? ` on ${g.kinds.map(kindLabel).join(", ").toLowerCase()}` : ""}
                    {g.onSaleItems ? ", sale items too" : ""}
                    {!g.active && <span className="pill tone-neutral ml-2">Not in use</span>}
                  </span>
                  <span className="muted text-sm">
                    {g.members} {g.members === 1 ? "member" : "members"} · {money(g.givenCents)} given on {g.lines} {g.lines === 1 ? "line" : "lines"}
                  </span>
                </div>
                {g.membershipItems.length > 0 && (
                  <p className="muted text-sm">
                    Sold as{" "}
                    {g.membershipItems.map((i, n) => (
                      <span key={i.id}>
                        {n ? ", " : ""}
                        <Link href={`/parts/${i.id}`} className="link">
                          {i.description}
                        </Link>{" "}
                        ({money(i.priceCents)}, {i.months ?? 12} months)
                      </span>
                    ))}
                  </p>
                )}
                {admin && (
                  <details>
                    <summary className="link cursor-pointer text-sm">Change</summary>
                    <div className="mt-2">
                      <PriceGroupForm g={g} />
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <details className="mt-3">
            <summary className="link cursor-pointer text-base">Add a price group</summary>
            <div className="mt-2">
              <PriceGroupForm g={null} />
            </div>
          </details>
        )}
        <p className="muted mt-3 text-sm">
          To sell a membership (&quot;Club card, $25, 12 months&quot;), make an item for it and set its group under &quot;Sells a membership&quot; on the item&apos;s page.
        </p>
      </Section>

      <Section title="Memberships ending">
        {report.renewals.length === 0 ? (
          <p className="muted text-base">None ending in the next 30 days.</p>
        ) : (
          <ul className="divide-y divide-line text-base">
            {report.renewals.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
                <Link href={`/customers/${r.id}`} className="link">
                  {r.name}
                </Link>
                <span>
                  {r.group}, {r.until < today ? "ended" : "ends"} {fmtYmdLong(r.until)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Lifetime discount on a machine's supplies">
        <ActionForm action={saveLifetimeDefault} success="Saved" className="space-y-3 text-base">
          <fieldset disabled={!admin} className="flex flex-wrap items-end gap-3">
            <div className="field">
              <label htmlFor="life-pct" className="label">
                Percent off bags, belts and filters for the life of a machine sold here
              </label>
              <input id="life-pct" name="lifetimePct" className="input num w-24" inputMode="numeric" defaultValue={shop.lifetimePctDefault} />
            </div>
            {admin && <Submit>Save</Submit>}
          </fieldset>
          <p className="muted text-sm">Tick it on each machine for sale (its page) that comes with it. At the register, a supply picked for her machine gets it.</p>
        </ActionForm>
      </Section>
    </div>
  );
}
