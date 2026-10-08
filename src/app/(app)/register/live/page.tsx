// Live sales (shop-features-round-2-design.md 4.3): start one (a Facebook Live or any show), and the ones before with
// their claims, what's paid and what's still waiting. Each opens the claim list.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";
import { liveSalesFor } from "@/lib/live-sales";
import { startLiveSale } from "@/actions/live-sales";
import { ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function LiveSales() {
  const user = await requireUser();
  const [sales, tz] = await Promise.all([liveSalesFor(user.shopId), shopTimeZone(user.shopId)]);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Live sales" sub="Selling on a Facebook Live? Claim each buyer's items as she calls them out; when the show ends, each buyer gets one pay link." back={{ href: "/register", label: "Register" }} />
      <ActionForm action={startLiveSale} className="card card-pad space-y-4">
        <h2 className="h2">Start a live sale</h2>
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <div className="field">
            <label htmlFor="ls-name" className="label">
              Name (optional)
            </label>
            <input id="ls-name" name="name" className="input text-base" maxLength={120} placeholder="Facebook Live, Thursday night" />
          </div>
          <div className="field">
            <label htmlFor="ls-hold" className="label">
              Hold unpaid claims (hours)
            </label>
            <input id="ls-hold" name="holdHours" inputMode="numeric" defaultValue="48" className="input num text-base" />
          </div>
        </div>
        <div className="flex justify-end">
          <Submit className="btn btn-primary min-h-11 text-base">Start the live sale</Submit>
        </div>
      </ActionForm>
      <Section title="Live sales before">
        {sales.length === 0 ? (
          <Empty>No live sales yet. Start one above when you go live.</Empty>
        ) : (
          <ul className="divide-y divide-line text-base">
            {sales.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
                <span>
                  <Link href={`/register/live/${s.id}`} className="link font-semibold">
                    {s.name}
                  </Link>{" "}
                  <span className="muted">{fmtWhen(s.startsAt, tz)}</span>
                </span>
                <span className="muted">
                  {s.claims} claim{s.claims === 1 ? "" : "s"}, {money(s.paidCents)} paid{s.waiting ? `, ${s.waiting} waiting` : ""}
                  {s.status === "OPEN" ? " · on now" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
