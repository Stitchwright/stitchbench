// What partner shops are waiting on from this shop: orders to fill, estimates to answer, terms to accept.
import Link from "next/link";
import { db } from "@/lib/db";
import { acceptedBoth, type Accepted } from "@/lib/partner-terms";

export async function PartnerTodo({ shopId }: { shopId: string }) {
  const [links, orders, estimates] = await Promise.all([
    db.partnerLink.findMany({ where: { shopId, status: "ACTIVE" } }),
    db.partnerOrder.findMany({
      where: { shopId, OR: [{ side: "seller", status: { in: ["PLACED", "ACCEPTED"] } }, { side: "buyer", status: "DELIVERED" }] },
      orderBy: { createdAt: "asc" },
      take: 30,
    }),
    db.repairJob.findMany({ where: { shopId, side: "retail", status: "WAITING_CUSTOMER_OK", approval: null }, take: 30 }),
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
