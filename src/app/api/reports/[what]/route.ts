// The Reports page's tables as CSV (later-round-1-design.md 3.1): the same functions the page uses, for a range (from, to as
// days in the shop's time zone) and, for sales, a period (day, week, month). Owner or admin only; also works while the
// program is read-only.
import { db } from "@/lib/db";
import { sessionUser } from "@/lib/session";
import { csvResponse } from "@/lib/csv";
import { monthRange } from "@/lib/time-zone";
import { shopTimeZone } from "@/lib/shop-zone";
import { actorOf, audit } from "@/lib/audit";
import { PERIODS, salesReport, type Period } from "@/lib/reports/sales";
import { ticketsReport, topCustomers } from "@/lib/reports/tickets";
import { liabilityReport } from "@/lib/reports/giftcards";
import { taxReport } from "@/lib/reports/tax";
import { storesOf } from "@/lib/stores";

const dollars = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));
const days = (n: number | null) => (n == null ? "" : n.toFixed(1));

export async function GET(req: Request, { params }: { params: Promise<{ what: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  if (user.role === "TECH") return new Response("Only the owner or an admin can download reports.", { status: 403 });
  const { what } = await params;
  const shopId = user.shopId;
  const url = new URL(req.url);
  const tz = await shopTimeZone(shopId);
  const { start, end, fromStr, toStr } = monthRange(url.searchParams.get("from"), url.searchParams.get("to"), tz);
  const period = (PERIODS as string[]).includes(url.searchParams.get("period") ?? "") ? (url.searchParams.get("period") as Period) : "day";
  // One store's figures (shop-features-round-2-design.md 7.4), only a store of this company; anything else is all stores.
  const asked = url.searchParams.get("store");
  const store = asked && asked !== "all" ? ((await storesOf(shopId)).find((s) => s.id === asked) ?? null) : null;
  let data: unknown[][] | null = null;

  if (what === "sales") {
    const r = await salesReport(shopId, tz, start, end, period, store);
    data = [
      [period, "counter", "repairs", "online", "returns", "voids", "discounts", "net_sales", "tax", "money_taken"],
      ...[...r.rows, r.totals].map((x) => [x.period, dollars(x.counter), dollars(x.repairs), dollars(x.online), dollars(x.returns), dollars(x.voids), dollars(x.discounts), dollars(x.net), dollars(x.tax), dollars(x.taken)]),
    ];
  } else if (what === "categories") {
    const r = await salesReport(shopId, tz, start, end, "month", store);
    data = [
      ["source", "category", "counts_as_sale", "quantity", "net", "cost", "margin"],
      ...r.counterCategories.map((c) => ["counter", c.label, c.sale ? "yes" : "no", c.qty, dollars(c.net), dollars(c.cost), dollars(c.margin)]),
      ...r.repairCategories.map((c) => ["repairs", c.label, "yes", c.qty, dollars(c.net), "", ""]),
    ];
  } else if (what === "tenders") {
    const r = await salesReport(shopId, tz, start, end, "month", store);
    data = [["how_paid", "amount"], ...r.tenders.map((t) => [t.label, dollars(t.cents)])];
  } else if (what === "tickets") {
    const r = await ticketsReport(shopId, start, end, new Date(), store);
    data = [
      ["measure", "value"],
      ["tickets in", r.ticketsIn],
      ["tickets out", r.ticketsOut],
      ["abandoned", r.abandoned],
      ["open now", r.openNow],
      ...r.openAges.map((a) => [`open ${a.band}`, a.count]),
      ["average repair value", dollars(r.averageRepair)],
      ["days to ready (median)", days(r.daysToReady.median)],
      ["days to ready (longest)", days(r.daysToReady.longest)],
      ["days to collected (median)", days(r.daysToCollected.median)],
      ["days to collected (longest)", days(r.daysToCollected.longest)],
      [],
      ["tech", "tickets closed", "labor hours billed", "labor billed", "parts billed"],
      ...r.techs.map((t) => [t.name, t.closed, t.laborHours, dollars(t.laborCents), dollars(t.partsCents)]),
      [],
      ["equipment", "in", "out", "open now"],
      ...r.byKind.map((k) => [k.kind, k.in, k.out, k.open]),
    ];
  } else if (what === "customers") {
    const r = await topCustomers(shopId, start, end, 100, store);
    data = [["customer", "visits", "counter_sales", "repairs", "total"], ...r.map((c) => [c.name, c.visits, dollars(c.counterCents), dollars(c.repairCents), dollars(c.totalCents)])];
  } else if (what === "gift-cards") {
    const r = await liabilityReport(shopId, start, end);
    data = [["kind", "line", "amount"]];
    for (const k of r.kinds) {
      data.push([k.label, "balance at start", dollars(k.opening)]);
      for (const m of k.movement) data.push([k.label, m.label, dollars(m.cents)]);
      data.push([k.label, "balance at end", dollars(k.closing)]);
    }
  } else if (what === "tax" || what === "tax-exempt") {
    const r = await taxReport(shopId, tz, start, end, store);
    if (what === "tax") {
      data = [
        ["rate_percent", "gross_sales", "non_taxable_sales", "taxable_sales", "tax_collected", "returns_and_voids_gross", "returns_and_voids_tax"],
        ...r.rates.map((x) => [x.ratePct, dollars(x.gross), dollars(x.nonTaxable), dollars(x.taxable), dollars(x.tax), dollars(x.returnsGross), dollars(x.returnsTax)]),
        ["total", dollars(r.totals.gross), dollars(r.totals.nonTaxable), dollars(r.totals.taxable), dollars(r.totals.tax), "", ""],
        [],
        ["stripe_tax_orders", "date", "ship_to_state", "tax_recorded", "shipped"],
        ...r.stripe.map((s) => [s.orderNumber, s.day, s.state, dollars(s.taxCents), s.shipped ? "yes" : "no"]),
      ];
    } else {
      data = [["what", "number", "date", "customer", "certificate", "exempt_amount"], ...r.exempt.map((e) => [e.kind, e.number, e.day, e.customer, e.certificate, dollars(e.amountCents)])];
    }
  }
  if (!data) return new Response("Unknown report.", { status: 404 });
  await audit(db, actorOf(user), { action: "export.download", subjectType: "Report", subjectLabel: `${what} ${fromStr} to ${toStr}` });
  return csvResponse(data, `${what}_${fromStr}_${toStr}.csv`);
}
