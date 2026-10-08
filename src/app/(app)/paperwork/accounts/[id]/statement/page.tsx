// A house account's monthly statement (shop-features-round-2-design.md 9.4): the shop, the customer, owed at the start,
// the month's charges and payments, now owed and by when. Printed from the browser.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { PAY_METHODS, lastMonth, statementFor } from "@/lib/house-accounts";
import { PrintButton } from "@/components/print-button";

export default async function StatementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ month?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { month } = await searchParams;
  const st = await statementFor(user.shopId, id, month ?? (await lastMonth(user.shopId)));
  if (!st) notFound();
  return (
    <div className="mx-auto max-w-2xl space-y-4 bg-white p-6 text-base text-black">
      <div className="no-print flex justify-end">
        <PrintButton />
      </div>
      <header className="flex flex-wrap justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{st.shop.name}</h1>
          <p className="text-sm whitespace-pre-line">{[st.shop.address, st.shop.phone].filter(Boolean).join("\n")}</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-semibold">Statement</p>
          <p>{st.monthLabel}</p>
        </div>
      </header>
      <p className="whitespace-pre-line">{[st.customer?.name ?? "Deleted customer", st.customer?.address].filter(Boolean).join("\n")}</p>
      <table className="table w-full">
        <thead>
          <tr>
            <th>Date</th>
            <th>What</th>
            <th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td />
            <td>Owed at the start of the month</td>
            <td className="num text-right">{money(st.opening)}</td>
          </tr>
          {st.lines.map((e) => (
            <tr key={e.id}>
              <td>{fmtDate(e.at, st.tz)}</td>
              <td>{e.kind === "PAYMENT" ? `Payment, ${PAY_METHODS[e.method as keyof typeof PAY_METHODS]?.toLowerCase() ?? ""}${e.note ? ` ${e.note}` : ""}` : (e.note ?? "Charge")}</td>
              <td className="num text-right">{e.kind === "PAYMENT" ? `-${money(e.amountCents)}` : money(e.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="num ml-auto grid max-w-xs grid-cols-2 gap-y-1">
        <dt>Charges</dt>
        <dd className="text-right">{money(st.charges)}</dd>
        <dt>Payments</dt>
        <dd className="text-right">-{money(st.payments)}</dd>
        <dt className="font-semibold">Now owed</dt>
        <dd className="text-right font-semibold">{money(st.closing)}</dd>
      </dl>
      {st.closing > 0 && (
        <p className="font-semibold">
          Please pay by {fmtDate(st.due, st.tz)} ({st.account.termsDays} days).
        </p>
      )}
    </div>
  );
}
