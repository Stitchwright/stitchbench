import "server-only";
// The report registry Ask your shop chooses from (shop-features-round-2-design.md 5.1). Each report is the program's own:
// its settings (dates, kind, collection, top N) come from the model's pick, checked here, and the numbers come only from
// these queries. What a report hands back is a small table (item names, counts and money; never a customer: a ticket is
// its number, a class its title) plus the same rows as plain lines for the model to word. Every query filters by shopId.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { lineNet, qtyText } from "@/lib/register-math";
import { salesReport } from "@/lib/reports/sales";
import { liabilityReport } from "@/lib/reports/giftcards";
import { seatCounts } from "@/lib/classes";
import { STATUS_LABEL, OPEN_STATUSES } from "@/lib/constants";
import { dateIn, fmtDay, monthRange, todayIn } from "@/lib/time-zone";
import { REPORT_DEFS, type AskParams, type ReportId } from "./registry-defs";

export { REPORT_DEFS, type AskParams, type ReportId } from "./registry-defs";

export type ReportResult = {
  id: ReportId;
  label: string;
  /** "Best sellers, Mar 20 to Oct 7, 2026 (fabric)": what was run, in words. */
  title: string;
  columns: { label: string; num?: boolean }[];
  rows: string[][];
  /** The rows as plain lines for the model (the same numbers the table shows). */
  facts: string[];
  /** Open this report: the page with the whole of it. */
  href: string;
};

const DAY = 86_400_000;
const days = (ms: number) => Math.max(0, Math.round(ms / DAY));
const pct = (n: number) => `${Math.round(n)}%`;
const KIND_WORD: Record<string, string> = { FABRIC: "fabric", THREAD: "thread", NOTION: "notions", PATTERN: "patterns", ACCESSORY: "accessories", SUPPLY: "supplies", PART: "parts" };

/** The ymd range in words: "Mar 20 to Oct 7, 2026". */
function rangeWords(from: string, to: string): string {
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(`${to}T00:00:00Z`);
  const md = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  return f.getUTCFullYear() === t.getUTCFullYear() ? `${md(f)} to ${md(t)}, ${t.getUTCFullYear()}` : `${md(f)}, ${f.getUTCFullYear()} to ${md(t)}, ${t.getUTCFullYear()}`;
}

const reportsHref = (tab: string, p: AskParams) => `/reports?tab=${tab}&from=${p.from}&to=${p.to}`;

type Ctx = { shopId: string; tz: string; start: Date; end: Date; p: AskParams };

async function bestSellers({ shopId, start, end, p }: Ctx): Promise<Omit<ReportResult, "id" | "label" | "title" | "href">> {
  const lines = await db.saleLine.findMany({
    where: {
      sale: { shopId, status: "COMPLETED", createdAt: { gte: start, lt: end } },
      partId: { not: null },
      part: { shopId, ...(p.kind ? { kind: p.kind as never } : {}), ...(p.collection ? { collection: { contains: p.collection, mode: "insensitive" as const } } : {}) },
    },
    select: { partId: true, qty: true, unitPriceCents: true, discountCents: true, taxable: true, unit: true, part: { select: { partNumber: true, description: true, unit: true } } },
  });
  const by = new Map<string, { name: string; unit: string | null; qty: number; net: number }>();
  for (const l of lines) {
    const k = l.partId!;
    const r = by.get(k) ?? { name: `${l.part!.description} (${l.part!.partNumber})`, unit: l.part!.unit, qty: 0, net: 0 };
    r.qty += l.qty;
    r.net += lineNet(l);
    by.set(k, r);
  }
  const top = [...by.values()].filter((r) => r.qty > 0).sort((a, b) => b.net - a.net || b.qty - a.qty).slice(0, p.top);
  return {
    columns: [{ label: "Item" }, { label: "Sold", num: true }, { label: "Sales", num: true }],
    rows: top.map((r) => [r.name, qtyText(r.qty, r.unit), money(r.net)]),
    facts: top.map((r, i) => `${i + 1}. ${r.name}: ${qtyText(r.qty, r.unit)} sold, ${money(r.net)}`),
  };
}

async function slowItems({ shopId, start, p, tz }: Ctx): Promise<Omit<ReportResult, "id" | "label" | "title" | "href">> {
  const parts = await db.part.findMany({
    where: {
      shopId,
      qtyOnHand: { gt: 0 },
      consignLinkId: null,
      kind: p.kind ? (p.kind as never) : { not: "MACHINE" },
      ...(p.collection ? { collection: { contains: p.collection, mode: "insensitive" as const } } : {}),
    },
    select: { id: true, partNumber: true, description: true, qtyOnHand: true, unit: true, costCents: true, priceCents: true, createdAt: true },
    take: 5000,
  });
  if (!parts.length) return { columns: [], rows: [], facts: [] };
  const last = await db.$queryRaw<{ partId: string; at: Date }[]>(Prisma.sql`
    SELECT sl."partId", max(s."createdAt") AS at FROM "SaleLine" sl JOIN "Sale" s ON s."id" = sl."saleId"
    WHERE s."shopId" = ${shopId} AND s."status" = 'COMPLETED' AND sl."qty" > 0 AND sl."partId" = ANY(${parts.map((x) => x.id)}::text[])
    GROUP BY sl."partId"`);
  const lastAt = new Map(last.map((r) => [r.partId, r.at]));
  const slow = parts
    .filter((x) => {
      const at = lastAt.get(x.id);
      return at ? at < start : x.createdAt < start;
    })
    .map((x) => ({ ...x, value: Math.round(x.qtyOnHand * (x.costCents ?? x.priceCents ?? 0)), at: lastAt.get(x.id) ?? null }))
    .sort((a, b) => b.value - a.value)
    .slice(0, p.top);
  return {
    columns: [{ label: "Item" }, { label: "On hand", num: true }, { label: "Last sold" }],
    rows: slow.map((x) => [`${x.description} (${x.partNumber})`, qtyText(x.qtyOnHand, x.unit), x.at ? dateIn(x.at, tz) : "never"]),
    facts: slow.map((x, i) => `${i + 1}. ${x.description} (${x.partNumber}): ${qtyText(x.qtyOnHand, x.unit)} on hand, last sold ${x.at ? dateIn(x.at, tz) : "never"}`),
  };
}

async function salesByKind({ shopId, tz, start, end }: Ctx, margins: boolean): Promise<Omit<ReportResult, "id" | "label" | "title" | "href">> {
  const r = await salesReport(shopId, tz, start, end, "month");
  const cats = r.counterCategories.filter((c) => c.sale && (!margins || c.cost != null));
  if (margins) {
    return {
      columns: [{ label: "Kind" }, { label: "Sales", num: true }, { label: "Margin", num: true }, { label: "Margin %", num: true }],
      rows: cats.map((c) => [c.label, money(c.net), money(c.margin ?? 0), c.net > 0 ? pct(((c.margin ?? 0) / c.net) * 100) : "-"]),
      facts: cats.map((c) => `${c.label}: sales ${money(c.net)}, margin ${money(c.margin ?? 0)}${c.net > 0 ? ` (${pct(((c.margin ?? 0) / c.net) * 100)})` : ""}`),
    };
  }
  const rows = cats.map((c) => [c.label, String(Math.round(c.qty * 100) / 100), money(c.net)]);
  const facts = cats.map((c) => `${c.label}: ${Math.round(c.qty * 100) / 100} sold, ${money(c.net)}`);
  if (r.totals.repairs) {
    rows.push(["Repairs (handed back)", "", money(r.totals.repairs)]);
    facts.push(`Repairs handed back: ${money(r.totals.repairs)}`);
  }
  return { columns: [{ label: "Kind" }, { label: "Sold", num: true }, { label: "Sales", num: true }], rows, facts };
}

async function waitedForParts({ shopId, start, end, p }: Ctx): Promise<Omit<ReportResult, "id" | "label" | "title" | "href">> {
  const now = new Date();
  const waits = await db.partWait.findMany({
    where: { shopId, cancelledAt: null, OR: [{ receivedAt: { gte: start, lt: end } }, { receivedAt: null, orderedAt: { lt: end } }] },
    select: { description: true, orderedAt: true, receivedAt: true, ticket: { select: { number: true, machine: { select: { brand: true, model: true } } } } },
    take: 2000,
  });
  const rows = waits
    .map((w) => ({ machine: `${w.ticket.machine.brand} ${w.ticket.machine.model}`.trim(), ticket: w.ticket.number, part: w.description, days: days((w.receivedAt ?? now).getTime() - w.orderedAt.getTime()), waiting: !w.receivedAt }))
    .sort((a, b) => b.days - a.days)
    .slice(0, p.top);
  return {
    columns: [{ label: "Machine" }, { label: "Ticket" }, { label: "Part" }, { label: "Days", num: true }],
    rows: rows.map((r) => [r.machine, `#${r.ticket}`, r.part, `${r.days}${r.waiting ? " (still waiting)" : ""}`]),
    facts: rows.map((r, i) => `${i + 1}. ${r.machine}, ticket #${r.ticket}: ${r.part}, ${r.days} days${r.waiting ? " so far, still waiting" : ""}`),
  };
}

async function ticketsByStatus({ shopId }: Ctx): Promise<Omit<ReportResult, "id" | "label" | "title" | "href">> {
  const groups = await db.ticket.groupBy({ by: ["status"], where: { shopId, status: { in: OPEN_STATUSES } }, _count: { _all: true }, _min: { intakeAt: true } });
  const now = Date.now();
  const sorted = OPEN_STATUSES.map((s) => groups.find((g) => g.status === s)).filter((g): g is NonNullable<typeof g> => !!g);
  return {
    columns: [{ label: "Status" }, { label: "Tickets", num: true }, { label: "Oldest (days)", num: true }],
    rows: sorted.map((g) => [STATUS_LABEL[g.status], String(g._count._all), g._min.intakeAt ? String(days(now - g._min.intakeAt.getTime())) : "-"]),
    facts: sorted.map((g) => `${STATUS_LABEL[g.status]}: ${g._count._all} tickets, the oldest in for ${g._min.intakeAt ? days(now - g._min.intakeAt.getTime()) : 0} days`),
  };
}

async function classFill({ shopId, start, end, p }: Ctx): Promise<Omit<ReportResult, "id" | "label" | "title" | "href">> {
  const classes = await db.shopClass.findMany({ where: { shopId, status: { not: "CANCELLED" }, firstAt: { gte: start, lt: end } }, select: { id: true, title: true, seats: true }, orderBy: { firstAt: "asc" }, take: 500 });
  const counts = await seatCounts(db, classes.map((c) => c.id));
  const rows = classes
    .map((c) => {
      const n = counts.get(c.id) ?? { enrolled: 0, waiting: 0 };
      return { title: c.title, seats: c.seats, enrolled: n.enrolled, waiting: n.waiting, fill: c.seats > 0 ? (n.enrolled / c.seats) * 100 : 0 };
    })
    .sort((a, b) => b.fill - a.fill)
    .slice(0, p.top);
  return {
    columns: [{ label: "Class" }, { label: "Seats", num: true }, { label: "Signed up", num: true }, { label: "Waiting", num: true }, { label: "Full", num: true }],
    rows: rows.map((r) => [r.title, String(r.seats), String(r.enrolled), String(r.waiting), pct(r.fill)]),
    facts: rows.map((r) => `${r.title}: ${r.enrolled} of ${r.seats} seats taken (${pct(r.fill)}), ${r.waiting} waiting`),
  };
}

async function giftCards({ shopId, start, end }: Ctx): Promise<Omit<ReportResult, "id" | "label" | "title" | "href">> {
  const r = await liabilityReport(shopId, start, end);
  const rows = r.kinds.map((k) => [k.label, money(k.opening), money(k.closing), String(k.cardsWithBalance)]);
  const facts = r.kinds.map((k) => `${k.label}: ${money(k.opening)} owed at the start, ${money(k.closing)} at the end, ${k.cardsWithBalance} cards with a balance today`);
  facts.push(`Owed on every card today: ${money(r.today)}`);
  return { columns: [{ label: "" }, { label: "At the start", num: true }, { label: "At the end", num: true }, { label: "Cards with money on", num: true }], rows, facts };
}

async function discounts({ shopId, start, end, p }: Ctx): Promise<Omit<ReportResult, "id" | "label" | "title" | "href">> {
  const sales = await db.sale.findMany({ where: { shopId, status: "COMPLETED", createdAt: { gte: start, lt: end } }, select: { discountCents: true, lines: { select: { discountCents: true, promotionId: true, qty: true } } } });
  const promoIds = new Set<string>();
  const by = new Map<string, { cents: number; lines: number }>();
  const add = (k: string, c: number) => {
    const r = by.get(k) ?? { cents: 0, lines: 0 };
    r.cents += c;
    r.lines += 1;
    by.set(k, r);
  };
  for (const s of sales) {
    if (s.discountCents > 0) add("sale", s.discountCents);
    for (const l of s.lines) {
      if (l.qty <= 0 || l.discountCents <= 0) continue;
      if (l.promotionId) promoIds.add(l.promotionId);
      add(l.promotionId ? `promo:${l.promotionId}` : "typed", l.discountCents);
    }
  }
  const promos = promoIds.size ? await db.promotion.findMany({ where: { shopId, id: { in: [...promoIds] } }, select: { id: true, name: true } }) : [];
  const name = (k: string) => (k === "sale" ? "Off the whole sale" : k === "typed" ? "Typed in at the register" : `Sale: ${promos.find((x) => `promo:${x.id}` === k)?.name ?? "a promotion"}`);
  const rows = [...by].sort((a, b) => b[1].cents - a[1].cents).slice(0, p.top);
  return {
    columns: [{ label: "Discount" }, { label: "Times", num: true }, { label: "Given", num: true }],
    rows: rows.map(([k, r]) => [name(k), String(r.lines), money(r.cents)]),
    facts: rows.map(([k, r]) => `${name(k)}: ${r.lines} times, ${money(r.cents)} off`),
  };
}

async function machinesForSale({ shopId, p }: Ctx): Promise<Omit<ReportResult, "id" | "label" | "title" | "href">> {
  const units = await db.stockUnit.findMany({ where: { shopId, status: "IN_STOCK" }, select: { createdAt: true, condition: true, priceCents: true, machine: { select: { brand: true, model: true } } }, orderBy: { createdAt: "asc" }, take: p.top });
  const now = Date.now();
  return {
    columns: [{ label: "Machine" }, { label: "Condition" }, { label: "Price", num: true }, { label: "Days for sale", num: true }],
    rows: units.map((u) => [`${u.machine.brand} ${u.machine.model}`, u.condition.toLowerCase().replace("_", " "), u.priceCents == null ? "-" : money(u.priceCents), String(days(now - u.createdAt.getTime()))]),
    facts: units.map((u) => `${u.machine.brand} ${u.machine.model} (${u.condition.toLowerCase().replace("_", " ")}): ${days(now - u.createdAt.getTime())} days for sale${u.priceCents == null ? "" : `, asking ${money(u.priceCents)}`}`),
  };
}

/** Runs one report for this company with settings already checked (parseAskChoice). */
export async function runReport(shopId: string, id: ReportId, p: AskParams): Promise<ReportResult> {
  const tz = (await db.shop.findUnique({ where: { id: shopId }, select: { timeZone: true } }))?.timeZone ?? "America/New_York";
  const { start, end } = monthRange(p.from, p.to, tz);
  const ctx: Ctx = { shopId, tz, start, end, p };
  const def = REPORT_DEFS.find((d) => d.id === id)!;
  const part =
    id === "best_sellers"
      ? await bestSellers(ctx)
      : id === "slow_items"
        ? await slowItems(ctx)
        : id === "sales_by_kind"
          ? await salesByKind(ctx, false)
          : id === "margins"
            ? await salesByKind(ctx, true)
            : id === "waited_for_parts"
              ? await waitedForParts(ctx)
              : id === "tickets_by_status"
                ? await ticketsByStatus(ctx)
                : id === "class_fill"
                  ? await classFill(ctx)
                  : id === "gift_card_liability"
                    ? await giftCards(ctx)
                    : id === "discounts"
                      ? await discounts(ctx)
                      : await machinesForSale(ctx);
  const bits = [(def.params as readonly string[]).includes("dates") ? (id === "slow_items" ? `not sold since ${fmtDay(p.from)}` : rangeWords(p.from, p.to)) : "now", p.kind ? KIND_WORD[p.kind] ?? p.kind.toLowerCase() : null, p.collection ? `"${p.collection}"` : null].filter(Boolean);
  const href =
    id === "best_sellers" || id === "sales_by_kind" || id === "margins" || id === "discounts"
      ? p.kind === "FABRIC" && id === "best_sellers"
        ? "/fabric?tab=sells"
        : reportsHref("sales", p)
      : id === "slow_items"
        ? p.kind === "FABRIC"
          ? "/fabric?tab=slow"
          : "/parts"
        : id === "waited_for_parts"
          ? "/parts/on-order"
          : id === "tickets_by_status"
            ? reportsHref("tickets", p)
            : id === "class_fill"
              ? "/classes"
              : id === "gift_card_liability"
                ? reportsHref("gift-cards", p)
                : "/units";
  return { id, label: def.label, title: `${def.label}, ${bits.join(", ")}`, href, ...part };
}

/** Today in the shop's zone and its collection names: what the model chooses settings from. */
export async function askContext(shopId: string): Promise<{ today: string; collections: string[] }> {
  const [shop, cols] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId }, select: { timeZone: true } }),
    db.part.groupBy({ by: ["collection"], where: { shopId, collection: { not: null } }, _count: { collection: true }, orderBy: { _count: { collection: "desc" } }, take: 60 }),
  ]);
  return { today: todayIn(shop?.timeZone ?? "America/New_York"), collections: cols.map((c) => c.collection).filter((c): c is string => !!c) };
}
