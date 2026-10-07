// Paperwork → Consigned machines (shop-features-round-2-design.md 9.6): what the shop owes consignors (Pay her), the
// machines on consignment (the give-back day first), payments made lately, and the shop's usual commission.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { consignedUnits, payoutsFor } from "@/lib/consign-machines";
import { saveConsignDefault } from "@/actions/consign-machines";
import { ActionForm, Submit } from "@/components/action-form";
import { Empty, Section } from "@/components/ui";
import { PaperFrame } from "@/components/paperwork/frame";
import { PayoutLine } from "@/components/paperwork/consign-parts";

export default async function ConsignPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [owed, paid, units, shop, tz] = await Promise.all([
    payoutsFor(user.shopId, { paid: false }),
    payoutsFor(user.shopId, { paid: true, take: 20 }),
    consignedUnits(user.shopId),
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { consignDefaultPct: true } }),
    shopTimeZone(user.shopId),
  ]);
  const today = ymdOf(new Date(), tz);
  return (
    <PaperFrame title="Consigned machines" tab="consign" admin={admin} sub="Customers' used machines you sell for them: her price, your commission, and her money when it sells.">
      <Section title={`Owed to consignors (${money(owed.reduce((a, p) => a + p.amountCents, 0))})`}>
        {owed.length ? (
          <ul className="divide-y divide-line">
            {owed.map((p) => (
              <PayoutLine key={p.id} p={p} admin={admin} />
            ))}
          </ul>
        ) : (
          <Empty>Nothing owed. When a consigned machine sells, what she gets shows here to pay her.</Empty>
        )}
      </Section>
      <Section title={`On consignment (${units.length})`}>
        {units.length ? (
          <ul className="divide-y divide-line">
            {units.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-base">
                <span>
                  <Link href={`/units/${u.id}`} className="link">
                    {u.machine.brand} {u.machine.model}
                  </Link>{" "}
                  <span className="muted text-sm">
                    for{" "}
                    <Link href={`/paperwork/consign/${u.consignorId}`} className="link">
                      {u.consignor}
                    </Link>
                    , the shop keeps {u.consignPct ?? shop.consignDefaultPct}%
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="num">{money(u.priceCents)}</span>
                  {u.consignUntil && <span className={`pill ${u.consignUntil <= today ? "tone-bad" : ""}`}>{u.consignUntil <= today ? "Give back or mark down" : `until ${u.consignUntil}`}</span>}
                  {u.status === "REMOVED" && <span className="pill">Off sale</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No machines on consignment. On a machine for sale, choose &quot;A customer&apos;s machine? Sell it for her&quot;.</Empty>
        )}
      </Section>
      {paid.length > 0 && (
        <Section title="Paid lately">
          <ul className="divide-y divide-line">
            {paid.map((p) => (
              <PayoutLine key={p.id} p={p} admin={admin} />
            ))}
          </ul>
        </Section>
      )}
      {admin && (
        <Section title="Your usual commission">
          <ActionForm action={saveConsignDefault} className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label className="label" htmlFor="cs-default">
                The shop keeps (%)
              </label>
              <input id="cs-default" name="pct" inputMode="decimal" className="input num w-24" defaultValue={String(shop.consignDefaultPct)} />
            </div>
            <Submit className="btn">Save</Submit>
          </ActionForm>
        </Section>
      )}
    </PaperFrame>
  );
}
