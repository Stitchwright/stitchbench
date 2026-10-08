// Shop hop (shop-features-round-2-design.md 4.6): the hops this shop takes part in (from the community hub), taking part
// with an organizer's code, and starting one (the organizer). Off until the shop turns shop hops on (Settings, Selling).
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { hubJoined } from "@/lib/hub";
import { ruleWords } from "@/lib/hops/hop-math";
import { refreshHops, joinHop, startHop } from "@/actions/hops";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function HopsPage() {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { hopOn: true } });
  const admin = user.role !== "TECH";
  if (!shop.hopOn) {
    return (
      <div className="max-w-3xl space-y-6">
        <PageHeader title="Shop hop" />
        <p className="card card-pad text-base">
          Shop hops are off. {admin ? "Turn them on in " : "An owner or admin turns them on in "}
          <Link href="/settings/sales#hops" className="link">
            Settings, Selling
          </Link>
          .
        </p>
      </div>
    );
  }
  const [joined, hops] = await Promise.all([hubJoined(), db.shopHop.findMany({ where: { shopId: user.shopId }, orderBy: [{ status: "asc" }, { startsOn: "desc" }] })]);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Shop hop"
        sub="Stamp shoppers' passports when they visit. The hops run on the community hub: shoppers sign up there and get their passport."
        actions={
          joined ? (
            <ActionButton action={refreshHops} className="btn min-h-11" success="Up to date">
              Look for news from the hub
            </ActionButton>
          ) : null
        }
      />
      {!joined && (
        <p className="card card-pad text-base">
          Shop hops run on the community hub.{" "}
          <Link href="/settings" className="link">
            Join it in Settings, Community hub
          </Link>{" "}
          first.
        </p>
      )}
      <Section title="Your hops">
        {hops.length === 0 ? (
          <Empty>No hops yet. When an organizer sends you a code, type it below to take part.</Empty>
        ) : (
          <ul className="divide-y divide-line text-base">
            {hops.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
                <span>
                  <Link href={`/hops/${h.id}`} className="link font-semibold">
                    {h.name}
                  </Link>{" "}
                  <span className="muted">
                    {h.startsOn} to {h.endsOn} · {ruleWords(h.rule, h.shopsCount)}
                    {h.role === "ORGANIZER" ? " · you organize it" : ""}
                    {h.status === "LEFT" ? " · you left" : ""}
                  </span>
                </span>
                {h.status === "JOINED" && (
                  <Link href={`/hops/${h.id}`} className="btn btn-primary min-h-11">
                    Stamp passports
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {admin && joined && (
        <Section title="Taking part in a hop?">
          <ActionForm action={joinHop} className="flex flex-wrap items-end gap-3">
            <div className="field">
              <label htmlFor="hop-join" className="label">
                The code the organizer sent you
              </label>
              <input id="hop-join" name="code" className="input mono text-base" autoComplete="off" placeholder="HJ-4F7K-2M9Q" />
            </div>
            <Submit className="btn btn-primary min-h-11 text-base">Take part</Submit>
          </ActionForm>
          <p className="muted mt-2 text-sm">Taking part is your choice. Shoppers&apos; details reach you only if they tick &ldquo;share with this shop&rdquo;.</p>
        </Section>
      )}
      {admin && joined && (
        <details className="card card-pad">
          <summary className="link cursor-pointer text-base">Organizing a hop? Start one</summary>
          <ActionForm action={startHop} className="mt-3 space-y-3">
            <div className="field">
              <label htmlFor="hop-name" className="label">
                Name
              </label>
              <input id="hop-name" name="name" className="input text-base" maxLength={120} placeholder="Fall Shop Hop 2026" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="field">
                <label htmlFor="hop-start" className="label">
                  First day
                </label>
                <input id="hop-start" name="startsOn" type="date" className="input text-base" />
              </div>
              <div className="field">
                <label htmlFor="hop-end" className="label">
                  Last day
                </label>
                <input id="hop-end" name="endsOn" type="date" className="input text-base" />
              </div>
            </div>
            <fieldset className="space-y-1">
              <legend className="label">A passport wins with</legend>
              <label className="flex min-h-11 items-center gap-2 text-base">
                <input type="radio" name="ruleKind" value="all" defaultChecked className="h-5 w-5" /> Stamps from every shop
              </label>
              <label className="flex min-h-11 items-center gap-2 text-base">
                <input type="radio" name="ruleKind" value="any" className="h-5 w-5" /> Stamps from any
                <input name="ruleN" inputMode="numeric" className="input num w-20 text-base" placeholder="6" aria-label="How many shops" /> shops
              </label>
            </fieldset>
            <div className="flex justify-end">
              <Submit className="btn btn-primary min-h-11 text-base">Start the hop</Submit>
            </div>
          </ActionForm>
        </details>
      )}
    </div>
  );
}
