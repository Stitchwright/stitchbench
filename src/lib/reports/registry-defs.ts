// The reports Ask your shop may choose from (shop-features-round-2-design.md 5.1), their settings, and the check of the
// model's pick. Pure: no database, so the prompt builder, the client and the check script share it.

export const REPORT_DEFS = [
  { id: "best_sellers", label: "Best sellers", blurb: "items that sold the most money in a date range", params: ["dates", "kind", "collection", "top"], example: "Which precuts sold best since spring?" },
  { id: "slow_items", label: "Slow items", blurb: "items in stock that haven't sold since a date (the 'from' date), most money tied up first", params: ["dates", "kind", "collection", "top"], example: "What thread hasn't sold since January?" },
  { id: "sales_by_kind", label: "Sales by kind", blurb: "sales in a date range split by kind (fabric, thread, notions, machines, classes...) and repairs", params: ["dates"], example: "How much fabric did we sell last month?" },
  { id: "margins", label: "Margins", blurb: "sales, margin and margin % by kind in a date range", params: ["dates"], example: "Where do we make the best margin?" },
  { id: "waited_for_parts", label: "Waited for parts", blurb: "repair tickets whose parts took longest to arrive (or are still waiting), longest first", params: ["dates", "top"], example: "Which machines waited longest for parts?" },
  { id: "tickets_by_status", label: "Tickets by status", blurb: "open repair tickets now, counted by status, with the oldest", params: [], example: "How many machines are waiting on parts?" },
  { id: "class_fill", label: "Class fill", blurb: "classes starting in a date range: seats, signed up, waiting list and how full", params: ["dates", "top"], example: "Which classes filled up this fall?" },
  { id: "gift_card_liability", label: "Gift cards owed", blurb: "gift card and store credit balances owed at the start and end of a date range", params: ["dates"], example: "How much do we owe on gift cards?" },
  { id: "discounts", label: "Discounts given", blurb: "discounts in a date range: by sale (promotion), typed at the register, or off the whole sale", params: ["dates", "top"], example: "How much did the summer sale give away?" },
  { id: "machines_for_sale", label: "Machines for sale", blurb: "machines for sale in stock now, longest for sale first", params: ["top"], example: "Which machines have been for sale longest?" },
] as const;

export type ReportId = (typeof REPORT_DEFS)[number]["id"];
export type ReportParam = "dates" | "kind" | "collection" | "top";
export const REPORT_IDS = REPORT_DEFS.map((d) => d.id) as ReportId[];

/** The kinds a report may narrow to (Part kinds the counter sells). */
export const ASK_KINDS = ["FABRIC", "THREAD", "NOTION", "PATTERN", "ACCESSORY", "SUPPLY", "PART"] as const;

/** store: a store named in the question ("at the Florida store"), one of the company's (more than one store, 7.5); null = all. */
export type AskParams = { from: string; to: string; kind: string | null; collection: string | null; top: number; store?: string | null };
export type AskChoice = { report: ReportId; params: AskParams } | { report: "none" };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (s: unknown): s is string => typeof s === "string" && YMD.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The model's pick made safe: a report from the list (else "none"), dates that are real days with from <= to <= today and
 * at most five years back (missing: this year so far), a kind from the list, a collection the shop has (matched in any
 * case), top N from 1 to 50 (default 10). Null when the answer isn't JSON at all.
 */
export function checkChoice(j: unknown, today: string, collections: readonly string[], stores: readonly string[] = []): AskChoice | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const id = String(o.report ?? "");
  const def = REPORT_DEFS.find((d) => d.id === id);
  if (!def) return { report: "none" };
  const earliest = addDays(today, -5 * 366);
  let to = validDay(o.to) && o.to <= today ? o.to : today;
  let from = validDay(o.from) ? o.from : `${today.slice(0, 4)}-01-01`;
  if (from < earliest) from = earliest;
  if (from > to) [from, to] = [to, from];
  const kind = typeof o.kind === "string" && (ASK_KINDS as readonly string[]).includes(o.kind.toUpperCase()) ? o.kind.toUpperCase() : null;
  const wanted = typeof o.collection === "string" ? o.collection.trim().toLowerCase() : "";
  const collection = wanted ? (collections.find((c) => c.toLowerCase() === wanted) ?? collections.find((c) => c.toLowerCase().includes(wanted)) ?? null) : null;
  const n = Math.round(Number(o.top));
  const top = Number.isFinite(n) && n >= 1 ? Math.min(50, n) : 10;
  const has = (p: ReportParam) => (def.params as readonly string[]).includes(p);
  // A store from the company's list (any case, or a word of its name); anything else is every store.
  const askedStore = typeof o.store === "string" ? o.store.trim().toLowerCase().replace(/\s+store$/, "") : "";
  const store = askedStore && stores.length > 1 ? (stores.find((s) => s.toLowerCase() === askedStore) ?? stores.find((s) => askedStore.includes(s.toLowerCase()) || s.toLowerCase().includes(askedStore)) ?? null) : null;
  return {
    report: def.id,
    params: { from, to, kind: has("kind") ? kind : null, collection: has("collection") ? collection : null, top: has("top") ? top : 25, ...(store ? { store } : {}) },
  };
}
