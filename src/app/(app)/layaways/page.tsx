// Layaways (tax-machine-sales-layaway-design.md section 4): the ones being paid for (behind on payments first), picked
// up and cancelled, with the money held for customers. Started, paid and picked up at the register.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { depositsHeld, listLayaways } from "@/lib/layaway";
import { LAYAWAY_STATUS_LABEL } from "@/lib/layaway-math";
import { fmtYmdLong } from "@/lib/units/units";
import { Empty, PageHeader } from "@/components/ui";

const TABS = [
  { key: "OPEN", label: "Being paid for" },
  { key: "COMPLETED", label: "Picked up" },
  { key: "CANCELLED", label: "Cancelled" },
] as const;

export default async function Layaways({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "OPEN";
  const [rows, tz, held] = await Promise.all([listLayaways(user.shopId, tab), shopTimeZone(user.shopId), depositsHeld(user.shopId)]);
  const sorted = tab === "OPEN" ? [...rows].sort((a, b) => b.behindCents - a.behindCents || a.number - b.number) : rows;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Layaways"
        sub="Items held for customers while they pay. Start one at the register: ring up the items, pick the customer, then Layaway."
        back={{ href: "/register", label: "Register" }}
      />
      <p className="text-sm">
        Money held for customers: <span className="num font-semibold">{money(held)}</span>
      </p>
      <div className="flex flex-wrap gap-2" role="navigation" aria-label="Layaways">
        {TABS.map((t) => (
          <Link key={t.key} href={`/layaways?tab=${t.key}`} className={`btn btn-sm ${tab === t.key ? "btn-primary" : ""}`}>
            {t.label}
          </Link>
        ))}
      </div>
      {sorted.length === 0 ? (
        <Empty>{tab === "OPEN" ? "No layaways right now. When a customer wants to pay over time, ring the items up and press Layaway." : "None yet."}</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Layaway</th>
                <th>Customer</th>
                <th>Items</th>
                <th className="text-right">Paid</th>
                <th className="text-right">{tab === "OPEN" ? "Left" : "Total"}</th>
                <th>{tab === "OPEN" ? "Pay by" : LAYAWAY_STATUS_LABEL[tab]}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={`/layaways/${l.id}`} className="link font-semibold">
                      #{l.number}
                    </Link>
                  </td>
                  <td>{l.customer ? <Link href={`/customers/${l.customer.id}`} className="link">{l.customer.name}</Link> : ""}</td>
                  <td>{l.lines.map((x) => x.description).join(", ")}</td>
                  <td className="num text-right">{money(l.paidCents)}</td>
                  <td className="num text-right">{money(tab === "OPEN" ? l.leftCents : l.owedCents)}</td>
                  <td className="whitespace-nowrap">
                    {tab === "OPEN" ? (
                      <>
                        {fmtYmdLong(l.dueBy)}
                        {l.behindCents > 0 && <span className="pill tone-wait ml-2">{money(l.behindCents)} behind</span>}
                      </>
                    ) : (
                      fmtDate((l.completedAt ?? l.cancelledAt ?? l.startedAt), tz)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
