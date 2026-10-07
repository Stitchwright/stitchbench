import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { getModules } from "@/lib/modules";
import { shopKinds } from "@/lib/equipment/shop";
import { layawaySettings } from "@/lib/layaway";
import { holidaysOn } from "@/lib/tax-holidays";
import { listLenders } from "@/lib/financing";
import { promotionsOn } from "@/lib/promotions";
import { specialOrderSettings } from "@/lib/special-orders";
import { yardBreaksFor } from "@/lib/birthdays";
import { tradeUpSettings } from "@/lib/trade-up";
import { ymdOf } from "@/lib/zoned";
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
  const units = await db.stockUnit.count({ where: { shopId: user.shopId } });
  const vac = vacState.active ? "on" : units > 0 ? "readonly" : "off";
  // Machines for sale (every shop): the tools show once the shop has a machine for sale or a service plan; sales and
  // trade-ins of the kinds it may work on now (a vacuum while Vac Shop is on), returns always.
  const plans = await db.servicePlan.count({ where: { shopId: user.shopId } });
  const unitKinds =
    units + plans > 0 ? (await shopKinds(user.shopId)).usable.map((k) => ({ key: k.key, label: k.label, types: k.types, brands: k.brands, modelHint: k.modelHint })) : null;
  // Layaway: the shop's defaults, and today in its zone (the payment plan's first day).
  const lw = await layawaySettings(user.shopId);
  const layaway = { depositPct: lw.depositPct, days: lw.days, every: lw.every, today: ymdOf(new Date(), await shopTimeZone(user.shopId)) };
  // A sales tax holiday in force today: the register shows it and leaves the tax off what it covers.
  const holiday = (await holidaysOn(user.shopId, [layaway.today]))[0] ?? null;
  // Lenders offered for financing (Settings → Selling): the Financing payment button.
  const lenders = (await listLenders(user.shopId, true)).map((l) => ({ id: l.id, name: l.name }));
  // Promotions in force today (Settings → Selling): the register shows them on the lines they cover.
  const promotions = await promotionsOn(user.shopId, layaway.today);
  // Special orders (shop-features-round-2-design.md 1.2): the shop's default deposit.
  const so = await specialOrderSettings(user.shopId);
  const specialOrders = { depositPct: so.depositPct, depositCents: so.depositCents, taxRatePct: shop.taxRatePct };
  // Per-yard breaks (1.6): the register prices them as the server will.
  const yardBreaks = (await yardBreaksFor(user.shopId)).map(({ minYards, pctOff, kinds }) => ({ minYards, pctOff, kinds }));
  // Opened from a roster's or an appointment's "Ring up": that one unpaid booking goes on the sale (design 12.3).
  let preload = null;
  const m = booking && /^(enrollment|appointment):([a-z0-9]{20,40})$/.exec(booking);
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
            <Link href="/register/gift-cards" className="btn">
              Gift cards
            </Link>
            <Link href="/layaways" className="btn">
              Layaways
            </Link>
            <Link href="/special-orders" className="btn">
              Special orders
            </Link>
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
      <Register taxRatePct={shop.taxRatePct} hasPartners={partners > 0} canSell={user.role !== "TECH"} vac={vac} unitKinds={unitKinds} layaway={layaway} holiday={holiday} lenders={lenders} promotions={promotions} specialOrders={specialOrders} yardBreaks={yardBreaks} tradeInLessPct={(await tradeUpSettings(user.shopId)).lessPct} preload={preload} />
    </div>
  );
}
