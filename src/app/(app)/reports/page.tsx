import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { money, ticketNo } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtDay, monthRange, todayIn } from "@/lib/time-zone";
import { PageHeader, Section, Empty } from "@/components/ui";
import { PERIODS, salesReport, type Period } from "@/lib/reports/sales";
import { ticketsReport, topCustomers } from "@/lib/reports/tickets";
import { liabilityReport } from "@/lib/reports/giftcards";
import { depositsHeld, listLayaways } from "@/lib/layaway";
import { coveredWork } from "@/lib/units/plans";
import { taxReport } from "@/lib/reports/tax";
import { EQUIPMENT_LABEL, isEquipment } from "@/lib/equipment";
import { balanced, buildBooks, loadBooks } from "@/lib/books";
import { markBooksExported } from "@/actions/books";
import { ActionButton } from "@/components/action-form";

const TABS = [
  { key: "sales", label: "Sales" },
  { key: "tickets", label: "Tickets" },
  { key: "customers", label: "Top customers" },
  { key: "gift-cards", label: "Gift cards" },
  { key: "layaways", label: "Layaways and plans" },
  { key: "tax", label: "Sales tax" },
  { key: "books", label: "Bookkeeping" },
] as const;
type Tab = (typeof TABS)[number]["key"];

type Sp = { tab?: string; from?: string; to?: string; period?: string };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
/** The ranges a bookkeeper files by, from today's date in the shop's zone: this and last month, this quarter, this year. */
function presets(today: string) {
  const [y, m] = today.split("-").map(Number);
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  const lm = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return [
    { label: "This month", from: ymd(y, m, 1), to: today },
    { label: "Last month", from: ymd(lm.y, lm.m, 1), to: ymd(lm.y, lm.m, last(lm.y, lm.m)) },
    { label: "This quarter", from: ymd(y, q0, 1), to: today },
    { label: "This year", from: ymd(y, 1, 1), to: today },
  ];
}

const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => <th className={right ? "text-right" : undefined}>{children}</th>;
const Num = ({ children, bold }: { children: React.ReactNode; bold?: boolean }) => <td className={`num text-right ${bold ? "font-semibold" : ""}`}>{children}</td>;
const days = (n: number | null) => (n == null ? "none" : `${n.toFixed(1)} days`);

/** Reports (later-round-1-design.md section 3): sales, tickets, top customers, the gift card liability and sales tax, for a range, each with Download CSV. Owners and admins only. */
export default async function Reports({ searchParams }: { searchParams: Promise<Sp> }) {
  const user = await requireUser();
  if (user.role === "TECH") notFound();
  const sp = await searchParams;
  const tab: Tab = TABS.find((t) => t.key === sp.tab)?.key ?? "sales";
  const period: Period = (PERIODS as string[]).includes(sp.period ?? "") ? (sp.period as Period) : "day";
  const tz = await shopTimeZone(user.shopId);
  // Bookkeeping starts the day after the last export unless a range was asked for.
  const books = tab === "books" ? await loadBooks(user.shopId) : null;
  const nextDay = books?.exportedThrough ? new Date(new Date(`${books.exportedThrough}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10) : null;
  const { start, end, fromStr, toStr } = monthRange(sp.from ?? (nextDay && nextDay <= todayIn(tz) ? nextDay : undefined), sp.to, tz);
  const q = (over: Partial<Sp>) => {
    const p = new URLSearchParams({ tab, from: fromStr, to: toStr, period, ...over } as Record<string, string>);
    return `?${p}`;
  };
  const csv = (what: string) => `/api/reports/${what}?from=${fromStr}&to=${toStr}&period=${period}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" sub={`${fmtDay(fromStr)} to ${fmtDay(toStr)}`} />
      <nav className="no-print flex flex-wrap gap-2" aria-label="Reports">
        {TABS.map((t) => (
          <Link key={t.key} href={q({ tab: t.key })} className={`btn btn-sm ${t.key === tab ? "btn-primary" : ""}`} aria-current={t.key === tab ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      <form className="no-print flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value={tab} />
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
        {tab === "sales" && (
          <div className="field">
            <label htmlFor="period" className="label">
              Group by
            </label>
            <select id="period" name="period" defaultValue={period} className="select">
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
        )}
        <button className="btn">Show</button>
      </form>
      <p className="no-print flex flex-wrap gap-2 text-sm">
        {presets(todayIn(tz)).map((p) => (
          <Link key={p.label} href={q({ from: p.from, to: p.to })} className="link">
            {p.label}
          </Link>
        ))}
      </p>

      {tab === "sales" && <SalesTab shopId={user.shopId} tz={tz} start={start} end={end} period={period} csv={csv} />}
      {tab === "tickets" && <TicketsTab shopId={user.shopId} start={start} end={end} csv={csv} />}
      {tab === "customers" && <CustomersTab shopId={user.shopId} start={start} end={end} csv={csv} />}
      {tab === "gift-cards" && <GiftTab shopId={user.shopId} start={start} end={end} csv={csv} />}
      {tab === "layaways" && <LayawayTab shopId={user.shopId} start={start} end={end} csv={csv} />}
      {tab === "tax" && <TaxTab shopId={user.shopId} tz={tz} start={start} end={end} csv={csv} />}
      {tab === "books" && books && <BooksTab shopId={user.shopId} tz={tz} start={start} end={end} csv={csv} fromStr={fromStr} toStr={toStr} exportedThrough={books.exportedThrough} />}
    </div>
  );
}

type TabProps = { shopId: string; start: Date; end: Date; csv: (what: string) => string };

const Download = ({ href }: { href: string }) => (
  <a className="btn btn-sm no-print" href={href}>
    Download CSV
  </a>
);

async function SalesTab({ shopId, tz, start, end, period, csv }: TabProps & { tz: string; period: Period }) {
  const r = await salesReport(shopId, tz, start, end, period);
  const t = r.totals;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-4">
        {(
          [
            ["Net sales", t.net],
            ["Sales tax", t.tax],
            ["Money taken", t.taken],
            ["Discounts given", t.discounts],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="card card-pad">
            <div className="num text-xl font-semibold">{money(v)}</div>
            <div className="muted text-xs">{k}</div>
          </div>
        ))}
      </div>
      <Section title={`By ${period}`} actions={<Download href={csv("sales")} />}>
        {r.rows.length === 0 ? (
          <Empty>No sales in this range.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <Th>{period === "day" ? "Day" : period === "week" ? "Week of" : "Month"}</Th>
                  <Th right>Counter</Th>
                  <Th right>Repairs</Th>
                  <Th right>Online</Th>
                  <Th right>Returns</Th>
                  <Th right>Voids</Th>
                  <Th right>Discounts</Th>
                  <Th right>Net sales</Th>
                  <Th right>Tax</Th>
                  <Th right>Money taken</Th>
                </tr>
              </thead>
              <tbody>
                {[...r.rows, r.totals].map((x, i, all) => (
                  <tr key={x.period} className={i === all.length - 1 ? "font-semibold" : undefined}>
                    <td className="num whitespace-nowrap">{x.period}</td>
                    <Num>{money(x.counter)}</Num>
                    <Num>{money(x.repairs)}</Num>
                    <Num>{money(x.online)}</Num>
                    <Num>{money(x.returns)}</Num>
                    <Num>{money(x.voids)}</Num>
                    <Num>{money(x.discounts)}</Num>
                    <Num bold>{money(x.net)}</Num>
                    <Num>{money(x.tax)}</Num>
                    <Num>{money(x.taken)}</Num>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted mt-2 text-xs">
          A counter sale counts on its day, a void on the day it happened, a repair when the machine is handed back, an online order on the day it was paid. Gift cards sold,
          trade-in credit and partner repair bills taken at the counter are not sales.
        </p>
      </Section>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="By category" actions={<Download href={csv("categories")} />}>
          {r.counterCategories.length + r.repairCategories.length === 0 ? (
            <Empty>Nothing sold.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <Th>Category</Th>
                    <Th right>Qty</Th>
                    <Th right>Net</Th>
                    <Th right>Cost</Th>
                    <Th right>Margin</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.counterCategories.map((c) => (
                    <tr key={`c${c.key}`}>
                      <td>
                        {c.label}
                        {!c.sale && <span className="muted text-xs"> (not a sale)</span>}
                      </td>
                      <Num>{c.qty}</Num>
                      <Num>{money(c.net)}</Num>
                      <Num>{c.cost == null ? "" : money(c.cost)}</Num>
                      <Num>{c.margin == null ? "" : money(c.margin)}</Num>
                    </tr>
                  ))}
                  {r.repairCategories.map((c) => (
                    <tr key={`r${c.key}`}>
                      <td>Repairs: {c.label}</td>
                      <Num>{c.qty}</Num>
                      <Num>{money(c.net)}</Num>
                      <td />
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section title="By how it was paid" actions={<Download href={csv("tenders")} />}>
          {r.tenders.length === 0 ? (
            <Empty>No payments.</Empty>
          ) : (
            <ul className="space-y-1 text-sm">
              {r.tenders.map((x) => (
                <li key={x.key} className="flex justify-between">
                  <span>{x.label}</span>
                  <span className="num">{money(x.cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

async function TicketsTab({ shopId, start, end, csv }: TabProps) {
  const r = await ticketsReport(shopId, start, end);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-5">
        {(
          [
            ["Tickets in", String(r.ticketsIn)],
            ["Handed back", String(r.ticketsOut)],
            ["Open now", String(r.openNow)],
            ["Abandoned", String(r.abandoned)],
            ["Average repair", r.averageRepair == null ? "none" : money(r.averageRepair)],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="card card-pad">
            <div className="num text-xl font-semibold">{v}</div>
            <div className="muted text-xs">{k}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="How long a repair takes" actions={<Download href={csv("tickets")} />}>
          <ul className="space-y-1 text-sm">
            <li className="flex justify-between">
              <span>Intake to ready (median)</span>
              <span className="num">{days(r.daysToReady.median)}</span>
            </li>
            <li className="flex justify-between">
              <span>Intake to ready (longest)</span>
              <span className="num">{days(r.daysToReady.longest)}</span>
            </li>
            <li className="flex justify-between">
              <span>Intake to handed back (median)</span>
              <span className="num">{days(r.daysToCollected.median)}</span>
            </li>
            <li className="flex justify-between">
              <span>Intake to handed back (longest)</span>
              <span className="num">{days(r.daysToCollected.longest)}</span>
            </li>
          </ul>
        </Section>
        <Section title="Open now, by age">
          <ul className="space-y-1 text-sm">
            {r.openAges.map((a) => (
              <li key={a.band} className="flex justify-between">
                <span>{a.band}</span>
                <span className="num">{a.count}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
      <Section title="By tech">
        {r.techs.length === 0 ? (
          <Empty>No tickets were handed back in this range.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <Th>Tech</Th>
                  <Th right>Tickets closed</Th>
                  <Th right>Labor hours billed</Th>
                  <Th right>Labor billed</Th>
                  <Th right>Parts billed</Th>
                </tr>
              </thead>
              <tbody>
                {r.techs.map((t) => (
                  <tr key={t.id ?? "none"}>
                    <td>{t.name}</td>
                    <Num>{t.closed}</Num>
                    <Num>{t.laborHours}</Num>
                    <Num>{money(t.laborCents)}</Num>
                    <Num>{money(t.partsCents)}</Num>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted mt-2 text-xs">Hours are the hours billed on the ticket, not time worked: a time clock per ticket comes later.</p>
      </Section>
      <Section title="By kind of machine">
        <ul className="space-y-1 text-sm">
          {r.byKind.map((k) => (
            <li key={k.kind} className="flex justify-between">
              <span>{isEquipment(k.kind) ? EQUIPMENT_LABEL[k.kind] : k.kind}</span>
              <span className="num">
                {k.in} in, {k.out} out, {k.open} open
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

async function CustomersTab({ shopId, start, end, csv }: TabProps) {
  const rows = await topCustomers(shopId, start, end);
  return (
    <Section title="Top customers" actions={<Download href={csv("customers")} />}>
      {rows.length === 0 ? (
        <Empty>No customers bought anything in this range.</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th right>Visits</Th>
                <Th right>Counter</Th>
                <Th right>Repairs</Th>
                <Th right>Total</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/customers/${c.id}`} className="link">
                      {c.name}
                    </Link>
                  </td>
                  <Num>{c.visits}</Num>
                  <Num>{money(c.counterCents)}</Num>
                  <Num>{money(c.repairCents)}</Num>
                  <Num bold>{money(c.totalCents)}</Num>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/**
 * Layaways (tax-machine-sales-layaway-design.md section 4): the money held for customers as the books count it (every
 * layaway line of a sale that stands) against what the open layaways have been paid, which must match; the open ones;
 * and the repair work given free under service plans in the range (section 3).
 */
async function LayawayTab({ shopId, start, end }: TabProps) {
  const [held, heldAtEnd, open, covered] = await Promise.all([depositsHeld(shopId), depositsHeld(shopId, end), listLayaways(shopId, "OPEN"), coveredWork(shopId, start, end)]);
  const paidOpen = open.reduce((a, l) => a + l.paidCents, 0);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card card-pad">
          <div className="num text-xl font-semibold">{money(held)}</div>
          <div className="muted text-xs">Money held for customers on layaway today (owed to them, not income yet)</div>
        </div>
        <div className="card card-pad">
          <div className="num text-xl font-semibold">{money(heldAtEnd)}</div>
          <div className="muted text-xs">Held at the end of this range (the books&apos; Customer Deposits)</div>
        </div>
        <div className="card card-pad">
          <div className="num text-xl font-semibold">{open.length}</div>
          <div className="muted text-xs">Layaways being paid for</div>
        </div>
      </div>
      {paidOpen !== held && (
        <p className="card card-pad text-sm" role="alert">
          The open layaways have been paid {money(paidOpen)}, but {money(held)} is held in the books. A pick-up or cancel may have been voided; check the layaways below.
        </p>
      )}
      <Section title="Being paid for">
        {open.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <Th>Layaway</Th>
                <Th>Customer</Th>
                <Th right>Paid</Th>
                <Th right>Left</Th>
                <Th right>Behind</Th>
              </tr>
            </thead>
            <tbody>
              {open.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={`/layaways/${l.id}`} className="link">
                      #{l.number}
                    </Link>
                  </td>
                  <td>{l.customer?.name ?? ""}</td>
                  <Num>{money(l.paidCents)}</Num>
                  <Num>{money(l.leftCents)}</Num>
                  <Num>{l.behindCents ? money(l.behindCents) : ""}</Num>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Repair work covered by service plans (tickets in this range)">
        {covered.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <Th>Plan</Th>
                <Th right>Lines</Th>
                <Th right>Would have cost</Th>
              </tr>
            </thead>
            <tbody>
              {covered.map((c) => (
                <tr key={c.plan}>
                  <td>{c.plan}</td>
                  <Num>{c.lines}</Num>
                  <Num>{money(c.cents)}</Num>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

async function GiftTab({ shopId, start, end, csv }: TabProps) {
  const r = await liabilityReport(shopId, start, end);
  return (
    <>
      <div className="card card-pad">
        <div className="num text-xl font-semibold">{money(r.today)}</div>
        <div className="muted text-xs">Owed on gift cards and store credit today (a liability, not income)</div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {r.kinds.map((k) => (
          <Section key={k.kind} title={k.label} actions={k.kind === "gift" ? <Download href={csv("gift-cards")} /> : undefined}>
            <ul className="space-y-1 text-sm">
              <li className="flex justify-between">
                <span>Owed at the start</span>
                <span className="num">{money(k.opening)}</span>
              </li>
              {k.movement.map((m) => (
                <li key={m.reason} className="flex justify-between">
                  <span>{m.label}</span>
                  <span className="num">{money(m.cents)}</span>
                </li>
              ))}
              <li className="flex justify-between border-t border-line pt-1 font-semibold">
                <span>Owed at the end</span>
                <span className="num">{money(k.closing)}</span>
              </li>
            </ul>
            <p className="muted mt-2 text-xs">{k.cardsWithBalance} with a balance today.</p>
          </Section>
        ))}
      </div>
    </>
  );
}

async function TaxTab({ shopId, tz, start, end, csv }: TabProps & { tz: string }) {
  const r = await taxReport(shopId, tz, start, end);
  return (
    <>
      <Section title="Sales tax" actions={<Download href={csv("tax")} />}>
        {r.rates.length === 0 ? (
          <Empty>No sales in this range.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <Th>Rate charged</Th>
                  <Th right>Gross sales</Th>
                  <Th right>Non-taxable</Th>
                  <Th right>Taxable sales</Th>
                  <Th right>Tax collected</Th>
                  <Th right>Returns and voids (in the figures)</Th>
                </tr>
              </thead>
              <tbody>
                {r.rates.map((x) => (
                  <tr key={x.ratePct}>
                    <td className="num">{x.ratePct}%</td>
                    <Num>{money(x.gross)}</Num>
                    <Num>{money(x.nonTaxable)}</Num>
                    <Num>{money(x.taxable)}</Num>
                    <Num bold>{money(x.tax)}</Num>
                    <Num>
                      {money(x.returnsGross)} / tax {money(x.returnsTax)}
                    </Num>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td>Total</td>
                  <Num>{money(r.totals.gross)}</Num>
                  <Num>{money(r.totals.nonTaxable)}</Num>
                  <Num>{money(r.totals.taxable)}</Num>
                  <Num>{money(r.totals.tax)}</Num>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="muted mt-2 text-xs">
          Non-taxable sales are items and services the shop doesn&apos;t tax, and tax-exempt customers. A sale counts on its day, its void or return in the period it happened; a repair
          when the machine is handed back.
        </p>
      </Section>
      {r.oddTax.length > 0 && (
        <Section title="Sales where taxable times the rate is not the tax charged">
          <ul className="space-y-1 text-sm">
            {r.oddTax.map((o) => (
              <li key={o.number}>
                Sale {o.number} on {o.day}: charged {money(o.taxCents)}, the rate gives {money(o.expectedCents)}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {r.holidays.length > 0 && (
        <Section title="Sold tax free on a sales tax holiday">
          <p className="muted mb-2 text-sm">Already in the non-taxable sales above. Your state may ask for this on the return.</p>
          <ul className="space-y-1 text-sm">
            {r.holidays.map((h) => (
              <li key={h.name} className="flex justify-between">
                <span>{h.name}</span>
                <span className="num">{money(h.amountCents)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={`Tax-exempt sales (${r.exempt.length})`} actions={<Download href={csv("tax-exempt")} />}>
        {r.exempt.length === 0 ? (
          <Empty>No tax-exempt sales in this range.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>What</Th>
                  <Th>Customer</Th>
                  <Th>Certificate</Th>
                  <Th right>Exempt amount</Th>
                </tr>
              </thead>
              <tbody>
                {r.exempt.map((e) => (
                  <tr key={`${e.kind}${e.number}`}>
                    <td className="num">{e.day}</td>
                    <td>{e.kind === "Sale" ? `Sale ${e.number}` : `Ticket ${ticketNo(e.number)}`}</td>
                    <td>{e.customer}</td>
                    <td className="mono">{e.certificate}</td>
                    <Num>{money(e.amountCents)}</Num>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td colSpan={4}>Total</td>
                  <Num>{money(r.exemptTotal)}</Num>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {r.stripe.length > 0 && (
        <Section title="Stripe Tax orders: file these from Stripe's tax report">
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Order</Th>
                  <Th>Ship-to state</Th>
                  <Th right>Tax recorded</Th>
                </tr>
              </thead>
              <tbody>
                {r.stripe.map((s) => (
                  <tr key={s.orderNumber}>
                    <td className="num">{s.day}</td>
                    <td>{s.orderNumber}</td>
                    <td>{s.state}</td>
                    <Num>{money(s.taxCents)}</Num>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td colSpan={3}>Total</td>
                  <Num>{money(r.stripeTotal)}</Num>
                </tr>
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </>
  );
}

async function BooksTab({ shopId, tz, start, end, fromStr, toStr, exportedThrough }: TabProps & { tz: string; fromStr: string; toStr: string; exportedThrough: string | null }) {
  const cfg = await loadBooks(shopId);
  const r = await buildBooks(shopId, tz, start, end, cfg);
  const range = `from=${fromStr}&to=${toStr}`;
  const already = exportedThrough != null && fromStr <= exportedThrough;
  return (
    <>
      <Section title="Bookkeeping export">
        <p className="mb-2 text-sm">
          One summary journal entry a day for {fmtDay(fromStr)} to {fmtDay(toStr)}: money taken, sales by category, discounts, sales tax, repairs and gift cards. Account names are
          set in{" "}
          <Link href="/settings/books" className="link">
            Settings, Bookkeeping
          </Link>
          .
        </p>
        <p className="mb-2 text-sm">{exportedThrough ? `Exported through ${fmtDay(exportedThrough)}.` : "Nothing has been marked as exported yet."}</p>
        {already && <p className="mb-2 text-sm font-semibold">Some of these days were already exported (through {fmtDay(exportedThrough!)}). Download them again only if your bookkeeper asked.</p>}
        {r.unbalancedSales > 0 && <p className="mb-2 text-sm font-semibold">{r.unbalancedSales} sale(s) did not add up to the cent; the difference went to the sales account.</p>}
        <div className="no-print flex flex-wrap gap-2">
          <a className="btn btn-sm" href={`/api/books/csv?${range}`}>
            Download for QuickBooks Online (CSV)
          </a>
          <a className="btn btn-sm" href={`/api/books/iif?${range}`}>
            Download for QuickBooks Desktop (IIF)
          </a>
          <ActionButton action={markBooksExported.bind(null, toStr)} className="btn btn-sm" confirm={`Mark every day through ${fmtDay(toStr)} as exported? The next export will start the day after.`}>
            Mark exported through {fmtDay(toStr)}
          </ActionButton>
        </div>
        <p className="muted mt-2 text-xs">
          Repair Tickets Clearing holds deposits on machines still in and unpaid bills of collected ones: {money(r.repairClearingCents)} at the end of this range. Cost of goods and inventory
          are left out; bookkeepers book inventory from counts.
        </p>
      </Section>
      {r.days.length === 0 ? (
        <Empty>Nothing to export in this range.</Empty>
      ) : (
        r.days.map((d) => (
          <Section key={d.day} title={`${d.number}  ${fmtDay(d.day)}${balanced(d) ? "" : "  (does not balance)"}`}>
            <table className="table">
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th right>Debit</Th>
                  <Th right>Credit</Th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.account}>
                    <td>{l.account}</td>
                    <Num>{l.debitCents ? money(l.debitCents) : ""}</Num>
                    <Num>{l.creditCents ? money(l.creditCents) : ""}</Num>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        ))
      )}
    </>
  );
}
