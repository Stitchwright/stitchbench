import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtDay, monthRange, todayIn } from "@/lib/time-zone";
import { lineNet, TENDER_LABEL, type Tender } from "@/lib/register-math";
import { KIND_LABEL } from "@/lib/parts";
import { PageHeader, Section, Empty } from "@/components/ui";
import type { Prisma } from "@/generated/prisma/client";

/** Register sales for a date range: totals by how customers paid, tax collected, and what sold by type. */
export default async function RegisterSales({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  // Default: today, in the shop's time zone.
  const tz = await shopTimeZone(user.shopId);
  const iso = todayIn(tz);
  const { start, end, fromStr, toStr } = monthRange(sp.from ?? iso, sp.to ?? sp.from ?? iso, tz);
  const include = { lines: { include: { part: { select: { kind: true } } } }, customer: { select: { name: true } }, user: { select: { name: true } } } satisfies Prisma.SaleInclude;
  const sales = await db.sale.findMany({ where: { shopId: user.shopId, createdAt: { gte: start, lt: end } }, include, orderBy: { createdAt: "desc" } });
  // A day that was counted and closed keeps its sales, even one voided afterwards: the void comes off the day it
  // happened, when the money went back. A sale rung up and voided within this period nets to nothing.
  const voidedHere = await db.sale.findMany({ where: { shopId: user.shopId, status: "VOIDED", voidedAt: { gte: start, lt: end } }, include, orderBy: { voidedAt: "desc" } });
  const voidedInside = (s: { voidedAt: Date | null }) => s.voidedAt != null && s.voidedAt >= start && s.voidedAt < end;
  const done = sales.filter((s) => !voidedInside(s));
  const earlierVoids = voidedHere.filter((s) => s.createdAt < start);
  // +1: counts for this period; -1: an earlier day's sale that was voided in this one.
  const counted = [...done.map((s) => ({ s, sign: 1 })), ...earlierVoids.map((s) => ({ s, sign: -1 }))];
  const byTender = new Map<string, number>();
  for (const { s, sign } of counted) {
    for (const t of s.tenders as Tender[]) byTender.set(t.method, (byTender.get(t.method) ?? 0) + sign * t.amountCents);
    if (s.changeCents) byTender.set("CASH", (byTender.get("CASH") ?? 0) - sign * s.changeCents);
  }
  // Consigned stock at what the partner's statement counts: after any whole-sale discount, as recorded with each sale.
  const consignedLines = counted.flatMap(({ s }) => s.lines.filter((l) => l.consignLinkId && !l.repairJobId).map((l) => l.id));
  const consignSales = new Map(
    (await db.consignSale.findMany({ where: { shopId: user.shopId, id: { in: consignedLines } }, select: { id: true, qty: true, priceCents: true } })).map((c) => [
      c.id,
      Math.round(c.qty * c.priceCents),
    ]),
  );
  const byKind = new Map<string, number>();
  let consigned = 0;
  let repairs = 0;
  for (const { s, sign } of counted) {
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
      if (l.repairJobId) repairs += sign * amt;
      else if (l.consignLinkId) consigned += sign * (consignSales.get(l.id) ?? amt);
      const k = l.repairJobId ? "Repairs" : l.part ? (KIND_LABEL[l.part.kind] ?? l.part.kind) : "Misc";
      byKind.set(k, (byKind.get(k) ?? 0) + sign * amt);
    }
  }
  const total = counted.reduce((a, { s, sign }) => a + sign * s.totalCents, 0);
  const tax = counted.reduce((a, { s, sign }) => a + sign * s.taxCents, 0);
  // Every row of the list: the sales rung up in this period, and the earlier ones voided in it, newest first.
  const rows = [...sales.map((s) => ({ s, at: s.createdAt, undo: false })), ...earlierVoids.map((s) => ({ s, at: s.voidedAt!, undo: true }))].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/register", label: "Register" }}
        title="Register sales"
        sub={`${fmtDay(fromStr)}${fromStr !== toStr ? ` to ${fmtDay(toStr)}` : ""} · ${done.length} sales · ${money(total)}${earlierVoids.length ? ` · includes ${earlierVoids.length} earlier sale${earlierVoids.length === 1 ? "" : "s"} voided` : ""}`}
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
        {rows.length === 0 ? (
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
                {rows.map(({ s, at, undo }) => (
                  <tr key={s.id + (undo ? "-void" : "")}>
                    <td className="mono">
                      <Link href={`/register/sales/${s.id}`} className="link">
                        {s.number}
                      </Link>
                    </td>
                    <td>{fmtDateTime(at, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                    <td>{s.customer?.name}</td>
                    <td className="text-xs">
                      {undo && <span className="muted">Void of the sale rung up {fmtDate(s.createdAt, tz)}: </span>}
                      {s.lines.map((l) => l.description).join(", ").slice(0, 80)}
                    </td>
                    <td className="text-xs">{(s.tenders as Tender[]).map((t) => TENDER_LABEL[t.method] ?? t.method).join(" + ")}</td>
                    <td className="num text-right">
                      {undo ? (
                        <>
                          <span className="pill tone-bad">void</span> {money(-s.totalCents)}
                        </>
                      ) : voidedInside(s) ? (
                        <span className="pill tone-bad">void</span>
                      ) : (
                        <>
                          {money(s.totalCents)}
                          {s.status === "VOIDED" && s.voidedAt && <div className="muted text-xs">voided {fmtDate(s.voidedAt, tz)}</div>}
                        </>
                      )}
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
