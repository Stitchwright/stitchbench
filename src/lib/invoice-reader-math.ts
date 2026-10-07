// The packing slip or invoice reader's pure parts (shop-features-round-2-design.md 1.10): the request (class read, the
// picture only), reading the model's answer into lines, and grouping the lines against the order and the shop's items by
// item number (never by guessing names). Pure: no database.
import type { Built } from "@/lib/assistant/prompts";
import { jsonOf } from "@/lib/assistant/prompts";

export const INVOICE_SYSTEM = `You read one page of a supplier's packing slip or invoice for a sewing and quilting shop. Answer with JSON only: {"lines":[{"itemNumber":"","description":"","qty":0,"unitCost":0}],"supplier":""}. One entry per product line on the page, in order. "itemNumber": the supplier's or maker's item number exactly as printed (empty if none). "qty": the quantity shipped (not ordered, not back-ordered) as a number. "unitCost": the price each (or a yard) in dollars as a number, empty if not shown. Leave out freight, tax, totals and subtotals. Never guess a number you can't read.`;

export function buildInvoiceRead(page: number, of: number, supplier: string | null): Built {
  return {
    feature: "read_invoice",
    cls: "read",
    system: INVOICE_SYSTEM,
    messages: [{ role: "user", content: `Read page ${page} of ${of}.${supplier ? ` The supplier is ${supplier.slice(0, 80)}.` : ""}` }],
    maxTokens: 1500,
  };
}

export type SlipLine = { itemNumber: string | null; description: string; qty: number; unitCostTenThou: number | null };

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : null);

/** The lines in an answer: a quantity above zero, a number or a description; costs to the ten-thousandth of a dollar. */
export function parseSlip(answer: string): SlipLine[] | null {
  const j = jsonOf(answer) as { lines?: unknown } | null;
  if (!j || typeof j !== "object" || !Array.isArray(j.lines)) return null;
  const out: SlipLine[] = [];
  for (const raw of j.lines.slice(0, 200)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const qty = Number(String(r.qty ?? "").replace(/[^0-9.]/g, ""));
    const cost = Number(String(r.unitCost ?? "").replace(/[$,\s]/g, ""));
    const itemNumber = text(r.itemNumber, 60);
    const description = text(r.description, 200) ?? "";
    if (!(qty > 0) || qty > 100_000 || (!itemNumber && !description)) continue;
    out.push({ itemNumber, description, qty: Math.round(qty * 1000) / 1000, unitCostTenThou: Number.isFinite(cost) && cost > 0 && cost < 100_000 ? Math.round(cost * 10_000) : null });
  }
  return out;
}

/** A number reduced to letters and digits (the shop's numberKeys rule). */
export const slipKey = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, "");

export type OrderLineIn = { id: string; partId: string | null; itemNumber: string; qty: number; receivedYards: number; unit: string; costCents: number | null; keys: string[] };
export type ItemIn = { id: string; partNumber: string; description: string; keys: string[]; costTenThou: number | null; costCents: number | null };

export type Matched =
  | { group: "order"; slip: SlipLine; lineId: string; partId: string | null; onOrder: number; outstanding: number; oldCostTenThou: number | null; costChange: number | null }
  | { group: "item"; slip: SlipLine; partId: string; partNumber: string; oldCostTenThou: number | null; costChange: number | null }
  | { group: "new"; slip: SlipLine };

const tenThouOf = (cents: number | null, tenThou: number | null) => (tenThou != null ? tenThou : cents != null ? cents * 100 : null);

/** The change from the old cost to the slip's, as a fraction (0.12 for 12% up), or null when either is missing or equal. */
export function costChange(oldTenThou: number | null, newTenThou: number | null): number | null {
  if (oldTenThou == null || newTenThou == null || oldTenThou <= 0 || oldTenThou === newTenThou) return null;
  return (newTenThou - oldTenThou) / oldTenThou;
}

/**
 * Each slip line against the order's lines (by item number: the line's own number or its item's numbers), else the
 * shop's items (their numbers), else new to the shop. An order line takes one slip line; a slip line one order line.
 */
export function matchSlip(slip: SlipLine[], orderLines: OrderLineIn[], items: ItemIn[]): Matched[] {
  const used = new Set<string>();
  return slip.map((s) => {
    const k = s.itemNumber ? slipKey(s.itemNumber) : "";
    if (k) {
      const line = orderLines.find((l) => !used.has(l.id) && (slipKey(l.itemNumber) === k || l.keys.includes(k)));
      if (line) {
        used.add(line.id);
        const item = items.find((i) => i.id === line.partId);
        const old = line.costCents != null ? line.costCents * 100 : item ? tenThouOf(item.costCents, item.costTenThou) : null;
        return { group: "order", slip: s, lineId: line.id, partId: line.partId, onOrder: line.qty, outstanding: Math.max(0, line.qty - line.receivedYards), oldCostTenThou: old, costChange: costChange(old, s.unitCostTenThou) };
      }
      const item = items.find((i) => slipKey(i.partNumber) === k || i.keys.includes(k));
      if (item) {
        const old = tenThouOf(item.costCents, item.costTenThou);
        return { group: "item", slip: s, partId: item.id, partNumber: item.partNumber, oldCostTenThou: old, costChange: costChange(old, s.unitCostTenThou) };
      }
    }
    return { group: "new", slip: s };
  });
}
