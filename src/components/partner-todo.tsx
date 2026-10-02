// What partner shops are waiting on from this shop: orders to fill, estimates to answer, terms to accept.
import Link from "next/link";
import { db } from "@/lib/db";
import { acceptedBoth, type Accepted } from "@/lib/partner-terms";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtDay, ymdOf } from "@/lib/zoned";

export async function PartnerTodo({ shopId }: { shopId: string }) {
  const now = new Date().getTime();
  const [links, orders, estimates, runs, tz] = await Promise.all([
    db.partnerLink.findMany({ where: { shopId, status: "ACTIVE" } }),
    db.partnerOrder.findMany({
      where: { shopId, OR: [{ side: "seller", status: { in: ["PLACED", "ACCEPTED"] } }, { side: "buyer", status: "DELIVERED" }] },
      orderBy: { createdAt: "asc" },
      take: 30,
    }),
    db.repairJob.findMany({ where: { shopId, side: "retail", status: "WAITING_CUSTOMER_OK", approval: null }, take: 30 }),
    // Runs that need this shop: OK a plan, record today's hand-off, or hear that the partner cancelled one.
    db.partnerRun.findMany({ where: { shopId, OR: [{ status: "SCHEDULED", startsAt: { gte: new Date(now - 86_400_000) } }, { status: "CANCELLED", cancelledAt: { gte: new Date(now - 3 * 86_400_000) } }] }, orderBy: { startsAt: "asc" }, take: 20 }),
    shopTimeZone(shopId),
  ]);
  const name = new Map(links.map((l) => [l.id, l.partnerName]));
  const items: { key: string; href: string; text: string }[] = [];
  for (const l of links) {
    const acc = (l.accepted as Accepted) ?? {};
    if (acc[l.side as "repair" | "retail"]?.version !== l.termsVersion) items.push({ key: `t${l.id}`, href: `/partners/${l.id}/agreement`, text: `${l.partnerName}: accept the agreement` });
    else if (l.proposedTerms && l.proposedBy !== l.side) items.push({ key: `p${l.id}`, href: `/partners/${l.id}/agreement`, text: `${l.partnerName}: proposed new terms` });
    else if (!acceptedBoth(acc, l.termsVersion)) continue;
  }
  for (const o of orders) {
    const what = o.side === "seller" ? (o.status === "PLACED" ? "new order" : "deliver it") : "delivered: receive it";
    items.push({ key: o.id, href: `/partners/${o.linkId}/orders/${o.id}`, text: `${o.number} (${name.get(o.linkId) ?? "partner"}): ${what}` });
  }
  for (const j of estimates) items.push({ key: j.id, href: `/repairs/${j.id}`, text: `Tag ${j.tag}: call the customer about the estimate` });
  for (const r of runs) {
    const link = links.find((l) => l.id === r.linkId);
    if (!link) continue;
    const href = `/partners/${r.linkId}/runs/${r.id}`;
    const day = fmtDay(r.startsAt, tz);
    const mine = link.side === "repair" ? r.collectedAt : r.deliveredAt;
    const today = ymdOf(r.startsAt, tz) === ymdOf(new Date(), tz);
    const cancelledBy = (Array.isArray(r.events) ? (r.events as { what?: string; side?: string; note?: string }[]) : []).findLast((e) => e.what === "cancelled");
    if (r.status === "CANCELLED") {
      if (cancelledBy?.side && cancelledBy.side !== link.side) items.push({ key: `rc${r.id}`, href, text: `${link.partnerName} cancelled the run on ${day}${cancelledBy.note ? `: ${cancelledBy.note}` : ""}` });
    } else if (r.ownerSide !== link.side && r.okRev !== r.rev) items.push({ key: `ro${r.id}`, href, text: `Run on ${day}: OK it` });
    else if (today && !mine) items.push({ key: `rr${r.id}`, href, text: `Today's run: ${link.side === "repair" ? "record what the driver took" : "record what arrived"}` });
  }
  if (!items.length) return null;
  return (
    <div className="card card-pad tone-wait">
      <strong>Partner shops:</strong>{" "}
      {items.map((x, i) => (
        <span key={x.key}>
          {i > 0 && " · "}
          <Link href={x.href} className="link">
            {x.text}
          </Link>
        </span>
      ))}
    </div>
  );
}
