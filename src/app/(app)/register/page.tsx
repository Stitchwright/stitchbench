import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { getModules } from "@/lib/modules";
import { bookingsDueFor } from "@/lib/register-sale";
import { shopTimeZone } from "@/lib/shop-zone";
import { PageHeader } from "@/components/ui";
import { Register } from "@/components/register";
import { PartnerTodo } from "@/components/partner-todo";
import { TodaySlot } from "@/components/slots/today";
import { EstimatesTodoSlot } from "@/components/slots/estimates-todo";
import { TodoLinesSlot } from "@/components/slots/todo-lines";

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ booking?: string }> }) {
  const user = await requireUser();
  const { booking } = await searchParams;
  const [shop, partners] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true, taxRatePct: true } }),
    db.partnerLink.count({ where: { shopId: user.shopId, side: "retail" } }),
  ]);
  if (!shop.sellsRetail) {
    return (
      <div className="space-y-4">
        <PageHeader title="Register" />
        <p className="card card-pad text-sm">
          The register is for selling over the counter (notions, fabric, accessories). Turn it on in{" "}
          <Link href="/settings#company" className="link">
            Settings
          </Link>{" "}
          under &quot;What this company does&quot;.
        </p>
      </div>
    );
  }
  // Vac Shop tools: on while the module is active; read-only (returns, no sales from stock) while the shop still holds
  // vacuums it sold or stocked after the module ended; off otherwise.
  const vacState = (await getModules(user.shopId)).states.vac;
  const vac = vacState.active ? "on" : (await db.stockUnit.count({ where: { shopId: user.shopId } })) > 0 ? "readonly" : "off";
  // Opened from a roster's or an appointment's "Ring up": that one unpaid booking goes on the sale (design 12.3).
  let preload = null;
  const m = booking && /^(enrollment|appointment):[a-z0-9]{20,40}$/.exec(booking);
  if (m) {
    const due = await bookingsDueFor(user.shopId, await shopTimeZone(user.shopId), null, false);
    preload = due.find((d) => d.kind === m[1] && d.id === m[2]) ?? null;
  }
  return (
    <div className="space-y-4">
      <PageHeader
        title="Register"
        actions={
          <>
            <Link href="/register/sales" className="btn">
              Sales
            </Link>
            <Link href="/parts" className="btn">
              Inventory
            </Link>
          </>
        }
      />
      <PartnerTodo shopId={user.shopId} />
      <TodaySlot user={user} place="register" />
      <EstimatesTodoSlot user={user} />
      <TodoLinesSlot user={user} />
      <Register taxRatePct={shop.taxRatePct} hasPartners={partners > 0} canSell={user.role !== "TECH"} vac={vac} preload={preload} />
    </div>
  );
}
