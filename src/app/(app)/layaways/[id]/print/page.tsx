// The layaway's terms for the customer to sign (tax-machine-sales-layaway-design.md section 4): the shop, the items,
// the deposit and payment plan, the shop's own wording (or the program's default), the cancel rule, and signature lines.
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { layawaySettings, layawayView } from "@/lib/layaway";
import { lineNet } from "@/lib/register-math";
import { fmtYmdLong } from "@/lib/units/units";
import { PrintButton } from "@/components/print-button";
import { PageHeader } from "@/components/ui";

export default async function LayawayTerms({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const l = await layawayView(user.shopId, id);
  if (!l) notFound();
  const [shop, tz, s] = await Promise.all([db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, address: true, phone: true } }), shopTimeZone(user.shopId), layawaySettings(user.shopId)]);
  const fee = [s.feeCents ? money(s.feeCents) : null, s.feePct ? `${s.feePct}% of what you paid` : null].filter(Boolean).join(" plus ");
  return (
    <div className="space-y-4">
      <PageHeader title={`Layaway #${l.number}: terms`} back={{ href: `/layaways/${l.id}`, label: `Layaway #${l.number}` }} actions={<PrintButton />} />
      <div className="card card-pad mx-auto max-w-2xl space-y-4 text-base">
        <div>
          <div className="text-lg font-bold">{shop.name}</div>
          {shop.address && <div>{shop.address}</div>}
          {shop.phone && <div>{shop.phone}</div>}
        </div>
        <p>
          Layaway #{l.number} for <strong>{l.customer?.name ?? ""}</strong>, started {fmtDate(l.startedAt, tz)}.
        </p>
        <table className="table">
          <tbody>
            {l.lines.map((x) => (
              <tr key={x.id}>
                <td>{x.description}</td>
                <td className="num text-right">{money(lineNet(x))}</td>
              </tr>
            ))}
            <tr>
              <td>Sales tax (worked out on the day you pick up; today it would be)</td>
              <td className="num text-right">{money(l.taxCents)}</td>
            </tr>
            <tr>
              <td className="font-semibold">Total</td>
              <td className="num text-right font-semibold">{money(l.owedCents)}</td>
            </tr>
          </tbody>
        </table>
        <div>
          <p className="font-semibold">Payments</p>
          <ul>
            <li>Deposit: {money(l.depositMinCents)}</li>
            {l.plan.map((p) => (
              <li key={p.due}>
                {fmtYmdLong(p.due)}: {money(p.cents)}
              </li>
            ))}
          </ul>
          <p>Paid in full by {fmtYmdLong(l.dueBy)}.</p>
        </div>
        <div className="whitespace-pre-line">{l.terms}</div>
        <p>
          If the layaway is cancelled, {fee ? `we keep ${fee}, and ` : ""}what you paid {fee ? "beyond that " : ""}comes back to you {s.refund === "credit" ? "as store credit" : "as money"}.
        </p>
        <div className="grid grid-cols-2 gap-8 pt-8">
          <div className="border-t border-line pt-1 text-sm">Customer&apos;s signature and date</div>
          <div className="border-t border-line pt-1 text-sm">For {shop.name}</div>
        </div>
      </div>
    </div>
  );
}
