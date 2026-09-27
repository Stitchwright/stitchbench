import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { monthRange, todayIn } from "@/lib/sales";
import { lineNet, TENDER_LABEL, type Tender } from "@/lib/register-math";
import { KIND_LABEL } from "@/lib/parts";
import { PageHeader, Section, Empty } from "@/components/ui";

/** Register sales for a date range: totals by how customers paid, tax collected, and what sold by type. */
export default async function RegisterSales({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  // Default: today, in the shop's time zone.
  const tz = (await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true } })).timeZone;
  const iso = todayIn(tz);
  const { start, end, fromStr, toStr } = monthRange(sp.from ?? iso, sp.to ?? sp.from ?? iso, tz);
  const sales = await db.sale.findMany({
    where: { shopId: user.shopId, createdAt: { gte: start, lt: end } },
    include: { lines: { include: { part: { select: { kind: true } } } }, customer: { select: { name: true } }, user: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const done = sales.filter((s) => s.status === "COMPLETED");
  const byTender = new Map<string, number>();
  for (const s of done) {
    for (const t of s.tenders as Tender[]) byTender.set(t.method, (byTender.get(t.method) ?? 0) + t.amountCents);
    if (s.changeCents) byTender.set("CASH", (byTender.get("CASH") ?? 0) - s.changeCents);
  }
  const byKind = new Map<string, number>();
  let consigned = 0;
  let repairs = 0;
  for (const s of done) {
    // A "Discount on sale" came off the items being bought (not returns, not a partner's repair bill), in proportion,
    // the way the sale was totalled. Spread it back over those lines so the breakdowns below add up to the totals.
    const eligible = s.lines.filter((l) => !l.repairJobId && lineNet(l) > 0);
    const base = eligible.reduce((a, l) => a + lineNet(l), 0);
    const orderDiscount = Math.min(s.discountCents, base);
    let left = orderDiscount;
    for (const l of s.lines) {
      let amt = lineNet(l);
      if (orderDiscount > 0 && eligible.includes(l)) {
        // The last eligible line takes whatever rounding left over, so the shares add up to the discount exactly.
        const share = l === eligible[eligible.length - 1] ? left : Math.min(left, Math.round((orderDiscount * amt) / base));
        left -= share;
        amt -= share;
      }
      if (l.repairJobId) repairs += amt;
      else if (l.consignLinkId) consigned += amt;
      const k = l.repairJobId ? "Repairs" : l.part ? (KIND_LABEL[l.part.kind] ?? l.part.kind) : "Misc";
      byKind.set(k, (byKind.get(k) ?? 0) + amt);
    }
  }
  const total = done.reduce((a, s) => a + s.totalCents, 0);
  const tax = done.reduce((a, s) => a + s.taxCents, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/register", label: "Register" }}
        title="Register sales"
        sub={`${fmtDate(start, tz)}${fromStr !== toStr ? ` to ${fmtDate(new Date(end.getTime() - 1), tz)}` : ""} · ${done.length} sales · ${money(total)}`}
      />
      <form className="flex flex-wrap items-end gap-2 no-print">
        <div className="field">
          <label htmlFor="from" className="label">
            From
          </label>
          <input id="from" name="from" type="date" defaultValue={fromStr} className="input" />
        </div>
        <div className="field">
          <label htmlFor="to" className="label">
            To
          </label>
          <input id="to" name="to" type="date" defaultValue={toStr} className="input" />
        </div>
        <button className="btn">Show</button>
      </form>
      <div className="grid gap-4 md:grid-cols-3">
        <Section title="Taken in (drawer and card reader)">
          <ul className="space-y-1 text-sm">
            {[...byTender].map(([m, c]) => (
              <li key={m} className="flex justify-between">
                <span>{TENDER_LABEL[m as keyof typeof TENDER_LABEL] ?? m}</span>
                <span className="num">{money(c)}</span>
              </li>
            ))}
            <li className="flex justify-between border-t border-line pt-1 font-semibold">
              <span>Total</span>
              <span className="num">{money(total)}</span>
            </li>
          </ul>
        </Section>
        <Section title="By type">
          <ul className="space-y-1 text-sm">
            {[...byKind].map(([k, c]) => (
              <li key={k} className="flex justify-between">
                <span>{k}</span>
                <span className="num">{money(c)}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="To account for">
          <ul className="space-y-1 text-sm">
            <li className="flex justify-between">
              <span>Sales tax collected</span>
              <span className="num">{money(tax)}</span>
            </li>
            <li className="flex justify-between">
              <span>Consigned stock sold (partner&apos;s share on the statement)</span>
              <span className="num">{money(consigned)}</span>
            </li>
            <li className="flex justify-between">
              <span>Repairs collected for the repair shop</span>
              <span className="num">{money(repairs)}</span>
            </li>
          </ul>
        </Section>
      </div>
      <Section title="Sales">
        {sales.length === 0 ? (
          <Empty>No sales in this period.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Time</th>
                  <th>Customer</th>
                  <th>Items</th>
                  <th>Paid by</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">
                      <Link href={`/register/sales/${s.id}`} className="link">
                        {s.number}
                      </Link>
                    </td>
                    <td>{s.createdAt.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                    <td>{s.customer?.name}</td>
                    <td className="text-xs">{s.lines.map((l) => l.description).join(", ").slice(0, 80)}</td>
                    <td className="text-xs">{(s.tenders as Tender[]).map((t) => TENDER_LABEL[t.method] ?? t.method).join(" + ")}</td>
                    <td className="num text-right">
                      {s.status === "VOIDED" ? <span className="pill tone-bad">void</span> : money(s.totalCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
