import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import type { HubOrder } from "@/lib/hub";
import { PageHeader, Empty } from "@/components/ui";
import { ActionButton } from "@/components/action-form";
import { MarketNav, OrderStatus } from "@/components/market-ui";
import { refreshOrders } from "@/actions/market";

const OPEN = ["REQUESTED", "ACCEPTED", "PAID", "SHIPPED"];

export default async function Orders({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const role = (await searchParams).role === "seller" ? "seller" : "buyer";
  const rows = await db.marketOrder.findMany({ where: { role, shopId: user.shopId }, orderBy: { updatedAt: "desc" }, take: 300 });
  const orders = rows.map((r) => r.data as unknown as HubOrder);
  const open = orders.filter((o) => OPEN.includes(o.status)).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketplace orders"
        sub={`${open} open ${role === "buyer" ? "purchases" : "sales"}`}
        actions={
          <ActionButton action={refreshOrders} className="btn" success="Up to date">
            Check for updates
          </ActionButton>
        }
      />
      <MarketNav current="orders" />
      <nav className="flex gap-2" aria-label="Buying or selling">
        {(["buyer", "seller"] as const).map((r) => (
          <Link key={r} href={`/market/orders?role=${r}`} className={`btn btn-sm ${role === r ? "btn-primary" : ""}`} aria-current={role === r ? "page" : undefined}>
            {r === "buyer" ? "Buying" : "Selling"}
          </Link>
        ))}
      </nav>
      <div className="card">
        {orders.length === 0 ? (
          <div className="card-pad">
            <Empty>{role === "buyer" ? "You haven't ordered anything yet." : "No orders for your listings yet."}</Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Item</th>
                  <th>{role === "buyer" ? "Seller" : "Buyer"}</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/market/orders/${o.id}`} className="link mono font-semibold">
                        {o.number}
                      </Link>
                    </td>
                    <td>
                      {o.qty} × {o.item.title}
                    </td>
                    <td>{role === "buyer" ? o.sellerShop : o.buyerShop}</td>
                    <td>
                      <OrderStatus status={o.status} />
                    </td>
                    <td className="num whitespace-nowrap">{fmtDate(o.updatedAt, tz)}</td>
                    <td className="num text-right">{money(o.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
