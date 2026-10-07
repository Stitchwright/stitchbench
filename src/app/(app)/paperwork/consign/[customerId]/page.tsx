// A consignor's statement (shop-features-round-2-design.md 9.6): her machines and where each stands, what each sale
// came to, what was paid and how, and what is still owed. Printable.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { db } from "@/lib/db";
import { UNIT_STATUS_LABEL } from "@/lib/constants";
import { PAYOUT_LABEL, consignorStatement } from "@/lib/consign-machines";
import { PrintButton } from "@/components/print-button";
import { PageHeader, Section } from "@/components/ui";

export default async function ConsignorStatementPage({ params }: { params: Promise<{ customerId: string }> }) {
  const user = await requireUser();
  const { customerId } = await params;
  const [st, tz, shop] = await Promise.all([consignorStatement(user.shopId, customerId), shopTimeZone(user.shopId), db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true } })]);
  if (!st) notFound();
  const c = st.customer;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={`Consignment statement: ${c.name}`} sub={`${shop.name}${shop.phone ? ` · ${shop.phone}` : ""} · ${fmtDate(new Date(), tz)}`} back={{ href: "/paperwork/consign", label: "Consigned machines" }} actions={<PrintButton />} />
      <Section title="Her machines">
        <table className="table">
          <thead>
            <tr>
              <th>Machine</th>
              <th>Where it stands</th>
              <th className="text-right">Price</th>
            </tr>
          </thead>
          <tbody>
            {st.units.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link href={`/units/${u.id}`} className="link">
                    {u.machine.brand} {u.machine.model}
                  </Link>
                  {u.machine.serial ? <span className="muted text-sm"> S/N {u.machine.serial}</span> : null}
                </td>
                <td>{u.status === "REMOVED" && u.machine.customerId === c.id ? "Given back" : u.status === "SOLD" ? `Sold ${u.soldAt ? fmtDate(u.soldAt, tz) : ""}` : (UNIT_STATUS_LABEL[u.status] ?? u.status)}</td>
                <td className="num text-right">{money(u.priceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Money">
        <table className="table">
          <thead>
            <tr>
              <th>Machine</th>
              <th className="text-right">Sold for</th>
              <th className="text-right">Shop kept</th>
              <th className="text-right">Hers</th>
              <th>Paid</th>
            </tr>
          </thead>
          <tbody>
            {st.payouts.map((p) => (
              <tr key={p.id}>
                <td>{p.machine}</td>
                <td className="num text-right">{money(p.soldCents)}</td>
                <td className="num text-right">{p.pct}%</td>
                <td className="num text-right">{money(p.amountCents)}</td>
                <td>{p.paidAt ? `${fmtDate(p.paidAt, tz)}, ${PAYOUT_LABEL[p.method ?? ""] ?? ""}${p.note ? ` ${p.note}` : ""}` : "Not yet"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="num mt-3 ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-base">
          <dt>Paid to her</dt>
          <dd className="text-right">{money(st.paidCents)}</dd>
          <dt className="font-semibold">Still owed</dt>
          <dd className="text-right font-semibold">{money(st.owedCents)}</dd>
        </dl>
      </Section>
    </div>
  );
}
