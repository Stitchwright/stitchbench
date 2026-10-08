// Customer price rules (shop-features-round-2-design.md 1.5 and 1.6), the same in the register (while ringing up) and
// on the server (when the sale is saved): a price group's discount ("Guild 10%", or the wholesale price), a machine
// owner's lifetime discount on its supplies ("Lifetime 25%"), a per-yard break ("10+ yd price"), the birthday offer
// ("Birthday 15%"). The bigger of these and a promotion wins on a line, not both (owner's answer 9); a discount an owner
// typed that is bigger still stands. Pure: no database. Cents; percents are whole numbers.
import { roundCents } from "@/lib/register-math";

export type GroupRule = { id: string; name: string; pctOff: number; useWholesale: boolean; kinds: string[]; onSaleItems: boolean };
export type YardBreak = { minYards: number; pctOff: number; kinds: string[] };

export type RuleCtx = {
  /** The customer's price group, while her membership lasts. */
  group?: GroupRule | null;
  /** Her machines bought here that carry a lifetime discount on their supplies (by the customer's machine id). */
  lifetime?: { machineId: string; pctOff: number }[];
  /** The shop's per-yard breaks (one or more steps). */
  yardBreaks?: YardBreak[];
  /** The birthday offer's percent, when she's using it on this sale. */
  birthdayPct?: number | null;
};

export type RuleLine = {
  kind?: string | null;
  qty: number;
  unitPriceCents: number;
  unit?: string | null;
  /** The item's wholesale price (a Wholesale group sells at it). */
  wholesaleCents?: number | null;
  /** The customer's vacuum (or other machine) this supply was bought for. */
  machineId?: string | null;
  /** The item's own break: from this many yards, this price a yard. */
  breakMinQty?: number | null;
  breakPriceCents?: number | null;
  /** A promotion covers the line (a group that doesn't apply to items on sale stands aside). */
  onPromo?: boolean;
};

export type RuleHit = { cents: number; label: string; rule: "group" | "lifetime" | "yard" | "birthday"; groupId?: string };

const pctOf = (gross: number, pct: number) => Math.min(gross, Math.round((gross * Math.max(0, Math.min(100, pct))) / 100));

/** What each rule would take off this line (items being bought only), the biggest first. */
export function ruleHits(ctx: RuleCtx, l: RuleLine): RuleHit[] {
  if (!(l.qty > 0)) return [];
  const gross = Math.abs(roundCents(l.qty * l.unitPriceCents));
  if (gross <= 0) return [];
  const out: RuleHit[] = [];
  const g = ctx.group;
  if (g && (g.onSaleItems || !l.onPromo) && (!g.kinds.length || (l.kind != null && g.kinds.includes(l.kind)))) {
    if (g.useWholesale) {
      if (l.wholesaleCents != null && l.wholesaleCents < l.unitPriceCents) out.push({ cents: Math.min(gross, roundCents(l.qty * (l.unitPriceCents - l.wholesaleCents))), label: `${g.name} price`, rule: "group", groupId: g.id });
    } else if (g.pctOff > 0) out.push({ cents: pctOf(gross, g.pctOff), label: `${g.name} ${g.pctOff}%`, rule: "group", groupId: g.id });
  }
  if (l.machineId) {
    const life = ctx.lifetime?.find((x) => x.machineId === l.machineId);
    if (life && life.pctOff > 0) out.push({ cents: pctOf(gross, life.pctOff), label: `Lifetime ${life.pctOff}%`, rule: "lifetime" });
  }
  if (l.unit === "yd") {
    if (l.breakMinQty != null && l.breakPriceCents != null && l.qty + 1e-9 >= l.breakMinQty && l.breakPriceCents < l.unitPriceCents) {
      out.push({ cents: Math.min(gross, roundCents(l.qty * (l.unitPriceCents - l.breakPriceCents))), label: `${trimNum(l.breakMinQty)}+ yd price`, rule: "yard" });
    } else {
      const step = (ctx.yardBreaks ?? []).filter((b) => l.qty + 1e-9 >= b.minYards && (!b.kinds.length || (l.kind != null && b.kinds.includes(l.kind)))).sort((a, b) => b.pctOff - a.pctOff)[0];
      if (step && step.pctOff > 0) out.push({ cents: pctOf(gross, step.pctOff), label: `${trimNum(step.minYards)}+ yd price`, rule: "yard" });
    }
  }
  if (ctx.birthdayPct && ctx.birthdayPct > 0) out.push({ cents: pctOf(gross, ctx.birthdayPct), label: `Birthday ${ctx.birthdayPct}%`, rule: "birthday" });
  return out.filter((h) => h.cents > 0).sort((a, b) => b.cents - a.cents);
}

/** The biggest rule on the line, or null. */
export const bestRule = (ctx: RuleCtx, l: RuleLine): RuleHit | null => ruleHits(ctx, l)[0] ?? null;

const trimNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

/** A group is in force on a day (YYYY-MM-DD) while it is on and the membership hasn't ended. */
export const groupInForce = (g: { active: boolean } | null | undefined, until: string | null | undefined, today: string) => !!g && g.active && (!until || until >= today);

/** The kinds a price group or a yard break can cover, as the register's report categories name them. */
export const RULE_KINDS: { key: string; label: string }[] = [
  { key: "FABRIC", label: "Fabric" },
  { key: "NOTION", label: "Notions" },
  { key: "THREAD", label: "Thread" },
  { key: "PATTERN", label: "Patterns and books" },
  { key: "ACCESSORY", label: "Accessories" },
  { key: "SUPPLY", label: "Supplies" },
  { key: "PART", label: "Parts" },
  { key: "UNIT", label: "Machines for sale" },
];
