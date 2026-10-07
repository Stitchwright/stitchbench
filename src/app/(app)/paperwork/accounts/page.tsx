// Paperwork → House accounts (shop-features-round-2-design.md 9.4): the owner's switch (off by default), then "Owed to
// us" by age, and last month's statements to print or email.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { accountsOwed, lastMonth } from "@/lib/house-accounts";
import { setHouseAccountsOn } from "@/actions/house-accounts";
import { ActionButton } from "@/components/action-form";
import { Empty, Section } from "@/components/ui";
import { PaperFrame } from "@/components/paperwork/frame";

export default async function HouseAccountsPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { houseAccountsOn: true } });
  const [rows, month] = await Promise.all([accountsOwed(user.shopId), lastMonth(user.shopId)]);
  const owed = rows.reduce((a, r) => a + r.aging.total, 0);
  const monthLabel = new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
  return (
    <PaperFrame title="House accounts" tab="accounts" admin={admin} sub="Customers who buy now and pay from a monthly statement: a school, a business, a long-time customer.">
      {!shop.houseAccountsOn && (
        <div className="card card-pad space-y-2 text-base">
          <p>House accounts are off. When they are on, you can let a customer buy &quot;On account&quot; at the register or on a repair, up to a limit, and send a statement each month.</p>
          {user.role === "OWNER" ? (
            <ActionButton action={setHouseAccountsOn.bind(null, true)} className="btn btn-primary">
              Turn on house accounts
            </ActionButton>
          ) : (
            <p className="muted text-sm">Only the owner turns them on.</p>
          )}
        </div>
      )}
      {(shop.houseAccountsOn || rows.length > 0) && (
        <Section title={`Owed to us (${money(owed)})`}>
          {rows.length ? (
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="text-right">Current</th>
                    <th className="text-right">31-60 days</th>
                    <th className="text-right">61-90</th>
                    <th className="text-right">Over 90</th>
                    <th className="text-right">Owed</th>
                    <th className="no-print">Statement for {monthLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/paperwork/accounts/${r.id}`} className="link">
                          {r.name}
                        </Link>
                        {r.status === "CLOSED" && <span className="pill ml-2">closed</span>}
                      </td>
                      <td className="num text-right">{r.aging.current ? money(r.aging.current) : ""}</td>
                      <td className={`num text-right ${r.aging.d30 ? "text-thread" : ""}`}>{r.aging.d30 ? money(r.aging.d30) : ""}</td>
                      <td className={`num text-right ${r.aging.d60 ? "text-thread" : ""}`}>{r.aging.d60 ? money(r.aging.d60) : ""}</td>
                      <td className={`num text-right ${r.aging.d90 ? "font-semibold text-thread" : ""}`}>{r.aging.d90 ? money(r.aging.d90) : ""}</td>
                      <td className="num text-right font-semibold">{money(r.aging.total)}</td>
                      <td className="no-print">
                        <Link href={`/paperwork/accounts/${r.id}/statement?month=${month}`} className="link" target="_blank">
                          Print
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No house accounts yet. Open one on a customer&apos;s page (House account).</Empty>
          )}
        </Section>
      )}
      {shop.houseAccountsOn && user.role === "OWNER" && (
        <p className="text-sm">
          <ActionButton action={setHouseAccountsOn.bind(null, false)} className="link" confirm="Tap again: nothing new goes on account">
            Turn house accounts off
          </ActionButton>
        </p>
      )}
    </PaperFrame>
  );
}
