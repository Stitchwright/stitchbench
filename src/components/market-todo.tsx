// Marketplace orders waiting on this shop, for the Bench page.
import Link from "next/link";
import { db } from "@/lib/db";
import type { HubOrder } from "@/lib/hub";

function todo(o: HubOrder): string | null {
  if (o.role === "seller") {
    if (o.status === "REQUESTED") return "accept or decline";
    if (o.status === "ACCEPTED" && o.buyerPaidNote) return "buyer says they paid: check and ship";
    if (o.status === "PAID") return "ship it";
  } else {
    if (o.status === "ACCEPTED" && !o.buyerPaidNote) return "pay the seller";
    if (o.status === "SHIPPED") return "mark it received when it arrives";
  }
  return null;
}

export async function MarketTodo({ shopId }: { shopId: string }) {
  const rows = await db.marketOrder.findMany({ where: { shopId, status: { in: ["REQUESTED", "ACCEPTED", "PAID", "SHIPPED"] } }, orderBy: { updatedAt: "desc" }, take: 50 });
  const items = rows.map((r) => r.data as unknown as HubOrder).map((o) => ({ o, what: todo(o) })).filter((x) => x.what);
  if (!items.length) return null;
  return (
    <div className="card card-pad tone-wait">
      <strong>Marketplace:</strong>{" "}
      {items.map(({ o, what }, i) => (
        <span key={o.id}>
          {i > 0 && " · "}
          <Link href={`/market/orders/${o.id}`} className="link mono">
            {o.number}
          </Link>{" "}
          ({o.role === "seller" ? o.buyerShop : o.sellerShop}): {what}
        </span>
      ))}
    </div>
  );
}
