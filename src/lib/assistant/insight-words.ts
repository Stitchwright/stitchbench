// Words on fabric insight (shop-features-round-2-design.md 5.5): the cards the program makes from its own numbers (best
// collections and colors, slow groups, what is at clearance), and the request that words each in one sentence. The
// numbers are the program's; the model only says them ("These 12 Christmas prints haven't sold since January"). Pure:
// no database (the Insight type only).
import type { Insight } from "@/lib/fabric-insight";
import { jsonOf, type Built, type Voice } from "./prompts";

export type InsightCard = { ref: string; title: string; facts: string };

const yd = (n: number) => `${Math.round(n * 10) / 10} yd`;
const money = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The cards for a tab, at most six: What sells (best collections and color, the slowest collection) or Slow fabric (by stage, color and collection). */
export function insightCards(insight: Pick<Insight, "groups" | "slow" | "settings">, tab: "sells" | "slow"): InsightCard[] {
  const cards: Omit<InsightCard, "ref">[] = [];
  if (tab === "sells") {
    const cols = insight.groups.collection.filter((g) => g.name && g.perWeek > 0.05).sort((a, b) => b.perWeek - a.perWeek);
    for (const g of cols.slice(0, 3)) cards.push({ title: `${g.name}`, facts: `Collection ${g.name}: ${plural(g.items, "fabric")}, ${yd(g.perWeek)} sold a week together over the last ${insight.settings.fabVelocityWeeks} weeks, ${g.weeks == null ? "no sales" : `${Math.round(g.weeks)} weeks of supply`}, ${money(g.margin)} margin in 12 months, ${yd(g.qty)} on hand.` });
    const color = insight.groups.color.filter((g) => g.name && g.perWeek > 0.05).sort((a, b) => b.perWeek - a.perWeek)[0];
    if (color) cards.push({ title: `Color: ${color.name}`, facts: `Fabrics tagged ${color.name}: ${plural(color.items, "fabric")}, ${yd(color.perWeek)} sold a week together, ${yd(color.qty)} on hand.` });
    const slowCol = insight.groups.collection.filter((g) => g.name && g.items >= 2 && (g.weeks == null || g.weeks > 26)).sort((a, b) => b.qty - a.qty)[0];
    if (slowCol) cards.push({ title: `${slowCol.name} (slow)`, facts: `Collection ${slowCol.name}: ${plural(slowCol.items, "fabric")}, ${yd(slowCol.qty)} on hand, ${slowCol.weeks == null ? "nothing sold" : `${yd(slowCol.perWeek)} a week, about ${Math.round(slowCol.weeks)} weeks of supply`} over the last ${insight.settings.fabVelocityWeeks} weeks.` });
  } else {
    const slow = insight.slow;
    for (const stage of ["clearance", "markdown"] as const) {
      const rows = slow.filter((r) => r.stage === stage);
      if (!rows.length) continue;
      const yards = rows.reduce((a, r) => a + r.item.qty, 0);
      const oldest = Math.max(...rows.map((r) => r.item.aged?.oldestDays ?? 0));
      cards.push({ title: stage === "clearance" ? "Ready for clearance" : "Ready for a markdown", facts: `${plural(rows.length, "fabric")} at the ${stage} stage: ${yd(yards)} on hand, the oldest in stock ${oldest} days.` });
    }
    const group = (key: (r: (typeof slow)[number]) => string[]) => {
      const m = new Map<string, typeof slow>();
      for (const r of slow) for (const k of key(r)) m.set(k, [...(m.get(k) ?? []), r]);
      return [...m].filter(([k, rs]) => k && rs.length >= 2).sort((a, b) => b[1].length - a[1].length)[0] ?? null;
    };
    const byTag = group((r) => r.item.colorTags);
    if (byTag) {
      const [tag, rs] = byTag;
      const sold = Math.round((rs.reduce((a, r) => a + (r.item.aged?.soldShare ?? 0), 0) / rs.length) * 100);
      cards.push({ title: `Tagged ${tag}`, facts: `${plural(rs.length, "slow fabric")} tagged ${tag}: ${yd(rs.reduce((a, r) => a + r.item.qty, 0))} on hand, about ${sold}% of what came in sold, the oldest in stock ${Math.max(...rs.map((r) => r.item.aged?.oldestDays ?? 0))} days.` });
    }
    const byCol = group((r) => (r.item.collection ? [r.item.collection] : []));
    if (byCol) {
      const [col, rs] = byCol;
      cards.push({ title: col, facts: `${plural(rs.length, "slow fabric")} from the ${col} collection: ${yd(rs.reduce((a, r) => a + r.item.qty, 0))} on hand, the oldest in stock ${Math.max(...rs.map((r) => r.item.aged?.oldestDays ?? 0))} days.` });
    }
  }
  return cards.slice(0, 6).map((c, i) => ({ ref: `c${i + 1}`, ...c }));
}

export function buildInsightWords(cards: InsightCard[], voice: Voice): Built {
  return {
    feature: "explain_insight",
    cls: "draft",
    system: `You turn a fabric shop's own numbers into words for the shop owner of ${String(voice.shopName ?? "").slice(0, 80) || "a quilt shop"}. For each card, write one plain sentence of at most 25 words saying what the numbers mean, like "These 12 Christmas prints haven't sold in eight months." Use only the numbers on the card; never add a number, a cause or advice. Answer with JSON only: {"lines":[{"ref":"c1","text":"..."}]}`,
    messages: [{ role: "user", content: cards.map((c) => `[${c.ref}] ${c.facts}`).join("\n") }],
    maxTokens: 600,
  };
}

/** One sentence per card that was offered, plain text, at most 200 characters. */
export function parseInsightWords(text: string, cards: InsightCard[]): Record<string, string> | null {
  const j = jsonOf(text) as { lines?: unknown } | null;
  if (!j || !Array.isArray(j.lines)) return null;
  const refs = new Set(cards.map((c) => c.ref));
  const out: Record<string, string> = {};
  for (const l of j.lines) {
    const o = l as { ref?: unknown; text?: unknown };
    if (typeof o?.ref === "string" && refs.has(o.ref) && typeof o.text === "string" && o.text.trim() && !out[o.ref]) out[o.ref] = o.text.replace(/[*_#`>]/g, "").trim().slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}
