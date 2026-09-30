import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { normalizeTerms } from "@/lib/partner-terms";
import { qtyText } from "@/lib/register-math";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { countConsigned, placeConsignment, returnConsigned } from "@/actions/partner-orders";

export default async function Consignment({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const { id } = await params;
  const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId: user.shopId, id } } });
  if (!link) notFound();
  const owner = link.side === "repair";
  const terms = normalizeTerms(link.terms);
  const items = await db.consignItem.findMany({ where: { shopId: user.shopId, linkId: id }, orderBy: { partNumber: "asc" } });
  const parts = owner
    ? await db.part.findMany({ where: { shopId: user.shopId, consignLinkId: null, qtyOnHand: { gt: 0 } }, select: { partNumber: true, description: true }, orderBy: { partNumber: "asc" }, take: 3000 })
    : [];
  const units = new Map(
    (await db.part.findMany({ where: { shopId: user.shopId, id: { in: items.map((i) => i.partId).filter(Boolean) as string[] } }, select: { id: true, unit: true } })).map((p) => [p.id, p.unit]),
  );
  const shelf = (i: (typeof items)[number]) => i.placed - i.sold - i.returned;
  const value = items.reduce((a, i) => a + shelf(i) * i.priceCents, 0);
  const admin = user.role !== "TECH";

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: `/partners/${id}`, label: link.partnerName }}
        title={owner ? `Your stock at ${link.partnerName}` : `${link.partnerName}'s stock on your shelf`}
        sub={`${items.length} items · ${money(value)} at shelf price · the sewing shop keeps ${terms.consignSharePct}% of what sells`}
      />
      <Section title="On consignment">
        {items.length === 0 ? (
          <Empty>{owner ? "Nothing placed yet. Add items below." : `${link.partnerName} hasn't placed any stock here yet.`}</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right">Shelf price</th>
                  <th className="text-right">Placed</th>
                  <th className="text-right">Sold</th>
                  <th className="text-right">Returned</th>
                  <th className="text-right">On the shelf</th>
                  <th>Last count</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const unit = i.partId ? (units.get(i.partId) ?? null) : null;
                  const diff = i.countedQty != null ? i.countedQty - shelf(i) : 0;
                  return (
                    <tr key={i.id}>
                      <td>
                        <span className="mono">{i.partNumber}</span> {i.description}
                      </td>
                      <td className="num text-right">{money(i.priceCents)}</td>
                      <td className="num text-right">{qtyText(i.placed, unit)}</td>
                      <td className="num text-right">{qtyText(i.sold, unit)}</td>
                      <td className="num text-right">{qtyText(i.returned, unit)}</td>
                      <td className="num text-right font-semibold">{qtyText(shelf(i), unit)}</td>
                      <td className="text-xs">
                        {i.countedAt ? (
                          <>
                            {qtyText(i.countedQty ?? 0, unit)} on {fmtDate(i.countedAt, tz)}
                            {Math.abs(diff) > 1e-9 && <span className={`pill ml-1 ${diff < 0 ? "tone-bad" : "tone-wait"}`}>{diff > 0 ? `+${diff}` : diff}</span>}
                          </>
                        ) : (
                          <span className="muted">not counted</span>
                        )}
                      </td>
                      <td>
                        {shelf(i) > 0 && !owner && (
                          <ActionForm action={returnConsigned.bind(null, id, i.itemKey)} className="flex gap-1" success="Recorded">
                            <input name="qty" aria-label={`Quantity of ${i.partNumber} going back`} inputMode="decimal" className="input num w-16" placeholder="qty" required />
                            <Submit className="btn btn-sm">{owner ? "Took back" : "Returned"}</Submit>
                          </ActionForm>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {owner && admin && link.status === "ACTIVE" && (
        <Section title={`Place stock at ${link.partnerName}`}>
          <ActionForm action={placeConsignment.bind(null, id)} className="flex flex-wrap items-end gap-2" success="Placed on their shelf" reset>
            <div className="field min-w-64 flex-1">
              <label htmlFor="cpn" className="label">
                Item from your inventory
              </label>
              <input id="cpn" name="partNumber" list="consign-parts" required className="input mono" autoComplete="off" />
              <datalist id="consign-parts">
                {parts.map((p) => (
                  <option key={p.partNumber} value={`${p.partNumber} | ${p.description}`} />
                ))}
              </datalist>
            </div>
            <div className="field w-24">
              <label htmlFor="cqty" className="label">
                Quantity
              </label>
              <input id="cqty" name="qty" inputMode="decimal" required className="input num" />
            </div>
            <div className="field w-32">
              <label htmlFor="cprice" className="label">
                Shelf price ($)
              </label>
              <input id="cprice" name="price" inputMode="decimal" className="input num" placeholder="its price" />
            </div>
            <Submit>Place on their shelf</Submit>
          </ActionForm>
          <p className="muted mt-2 text-xs">It comes out of your stock now and shows up in their inventory, marked as yours. You&apos;re paid as it sells.</p>
        </Section>
      )}

      {!owner && items.length > 0 && (
        <Section title="Count the shelf">
          <ActionForm action={countConsigned.bind(null, id)} className="space-y-2" success="Count sent">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {items
                .filter((i) => shelf(i) > 0 || i.countedQty)
                .map((i) => (
                  <div key={i.id} className="field">
                    <label htmlFor={`count_${i.itemKey}`} className="label">
                      {i.partNumber} {i.description.slice(0, 40)} (should be {shelf(i)})
                    </label>
                    <input id={`count_${i.itemKey}`} name={`count_${i.itemKey}`} inputMode="decimal" className="input num" />
                  </div>
                ))}
            </div>
            <Submit>Send the count to {link.partnerName}</Submit>
          </ActionForm>
          <p className="muted mt-2 text-xs">Counting also corrects your own inventory for these items.</p>
        </Section>
      )}
      <p className="text-sm">
        <Link href={`/partners/${id}/statement`} className="link">
          This month&apos;s statement
        </Link>
      </p>
    </div>
  );
}
