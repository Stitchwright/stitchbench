// The special order slip (shop-features-round-2-design.md 1.2): "Special order 1042, deposit $10.00, balance $34.95
// when it arrives", with the deposit rule printed, for the customer to keep.
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtYmdLong } from "@/lib/units/units";
import { RULE_WORDS, specialOrderView } from "@/lib/special-orders";
import { PrintButton } from "@/components/print-button";
import { PageHeader } from "@/components/ui";

export default async function SpecialOrderSlip({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const o = await specialOrderView(user.shopId, id);
  if (!o) notFound();
  const [shop, tz] = await Promise.all([db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, address: true, phone: true } }), shopTimeZone(user.shopId)]);
  const word = o.kind === "PREORDER" ? "Pre-order" : "Special order";
  return (
    <div className="space-y-4">
      <PageHeader title={`${word} ${o.number}: slip`} back={{ href: `/special-orders/${o.id}`, label: `${word} ${o.number}` }} actions={<PrintButton />} />
      <div className="card card-pad mx-auto max-w-md space-y-3 text-base">
        <div>
          <div className="text-lg font-bold">{shop.name}</div>
          {shop.address && <div>{shop.address}</div>}
          {shop.phone && <div>{shop.phone}</div>}
        </div>
        <p className="text-lg font-semibold">
          {word} {o.number}
        </p>
        <p>
          For {o.customer?.name ?? ""}, {fmtDate(o.createdAt, tz)}
        </p>
        <p>
          {o.description}
          {o.qty !== 1 ? ` x ${qtyText(o.qty, o.unit)}` : ""}: {money(o.owedCents)} with tax
        </p>
        <p className="text-lg">
          Deposit {money(o.paidCents)}, balance {money(o.leftCents)} when it arrives.
        </p>
        {o.expectedOn && <p>Expected about {fmtYmdLong(o.expectedOn)}. We&apos;ll let you know when it&apos;s here.</p>}
        <p>{RULE_WORDS[o.depositRule]}</p>
      </div>
    </div>
  );
}
