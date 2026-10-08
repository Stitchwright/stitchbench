import "server-only";
// "Running low" for printer and cutter owners (shop-features-round-2-design.md 6.3, package supplies-due, Maker Shop):
// a customer who bought a 3D printer, resin printer, craft cutter, laser or die cutter here, and how often she buys its
// supplies (filament, resin, mats, blades, vinyl, laser stock: items whose type says so), gives a "probably running low"
// date: her own average gap between purchases after the last one, or six weeks after her last (or after the machine's
// sale, when she hasn't bought any). The Supplies due list: Called, Snooze, Stop, or a one-off send through Marketing;
// never sent on its own (the bags-due rule). Vacuums keep their own bags-due list (src/lib/vac/bags-due.ts), whose
// matching reads the finder; this is the same pattern with a rule per kind. Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str } from "@/lib/format";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView } from "@/lib/messaging/settings";
import { firstName } from "@/lib/messaging/templates";
import { moduleOn } from "@/lib/module-gate";
import { isDesktop, moduleState, requireModule } from "@/lib/modules";
import { ymdOf } from "@/lib/zoned";
import type { ItemType } from "@/lib/item-details";
import type { CurrentUser } from "@/lib/session";

const DAY = 86_400_000;
/** Listed this many days before the running-low date; a call or message counts from this many days before it. */
export const SUPPLIES_WINDOW_DAYS = 7;
export const SNOOZE_DAYS = 30;
const MIN_GAP = 14;
const MAX_GAP = 365;

/** Per machine kind: what its supplies are called, which item types count, and the gap when she has no pattern yet. */
export const SUPPLY_RULES: Record<string, { word: string; types: ItemType[]; defaultDays: number }> = {
  "3d-printer": { word: "filament", types: ["filament"], defaultDays: 42 },
  "resin-printer": { word: "resin", types: ["resin"], defaultDays: 42 },
  "craft-cutter": { word: "mats, blades and vinyl", types: ["mat", "blade", "vinyl"], defaultDays: 42 },
  "laser-cutter": { word: "laser material", types: ["laser-material"], defaultDays: 42 },
  "die-cutter": { word: "cutting mats", types: ["mat"], defaultDays: 90 },
};

/**
 * The running-low date (pure): with two purchases or more, her own average gap (14 to 365 days) after the last one;
 * with one, the kind's default after it; with none, the default after the machine's sale.
 */
export function runningLowAt(purchases: Date[], soldAt: Date, defaultDays: number): { at: Date; from: "her pace" | "last purchase" | "the machine's sale"; gapDays: number } {
  const times = [...new Set(purchases.map((d) => d.getTime()))].sort((a, b) => a - b);
  if (times.length >= 2) {
    const gap = Math.min(MAX_GAP, Math.max(MIN_GAP, Math.round((times.at(-1)! - times[0]) / (times.length - 1) / DAY)));
    return { at: new Date(times.at(-1)! + gap * DAY), from: "her pace", gapDays: gap };
  }
  if (times.length === 1) return { at: new Date(times[0] + defaultDays * DAY), from: "last purchase", gapDays: defaultDays };
  return { at: new Date(soldAt.getTime() + defaultDays * DAY), from: "the machine's sale", gapDays: defaultDays };
}

export type SuppliesRow = {
  machineId: string;
  kind: string;
  word: string;
  customerId: string;
  customer: { name: string; phone: string | null; email: string | null };
  brand: string;
  model: string;
  lastBoughtAt: Date | null;
  dueAt: Date;
  dueOn: string;
  from: "her pace" | "last purchase" | "the machine's sale";
  overdue: boolean;
  /** What she bought last of it, if it is on the shelf now ("Bambu PLA black"). */
  offer: string | null;
  care: { calledAt: Date | null; calledBy: string | null; callNote: string | null; snoozeUntil: Date | null } | null;
};

/**
 * Who is probably running low: printers and cutters sold here to a customer (not stopped, not snoozed), whose running-low
 * date falls within the next week or has passed, and nobody has been in touch since a week before it. Soonest first.
 */
export async function suppliesDue(shopId: string, now: Date = new Date()): Promise<SuppliesRow[]> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { timeZone: true } });
  if (!shop) return [];
  const machines = await db.machine.findMany({
    where: { shopId, customerId: { not: null }, kind: { in: Object.keys(SUPPLY_RULES) }, stock: { is: { status: "SOLD" } } },
    include: { customer: { select: { name: true, phone: true, email: true } }, suppliesCare: true, stock: { select: { soldAt: true } } },
    take: 2000,
  });
  const live = machines.filter((m) => !m.suppliesCare?.stoppedAt && !(m.suppliesCare?.snoozeUntil && m.suppliesCare.snoozeUntil > now));
  if (!live.length) return [];
  const types = [...new Set(Object.values(SUPPLY_RULES).flatMap((r) => r.types))];
  const lines = await db.saleLine.findMany({
    where: { qty: { gt: 0 }, sale: { shopId, status: "COMPLETED", customerId: { in: [...new Set(live.map((m) => m.customerId!))] } }, part: { shopId, itemType: { in: types } } },
    select: { machineId: true, part: { select: { id: true, itemType: true, qtyOnHand: true, description: true } }, sale: { select: { createdAt: true, customerId: true } } },
  });
  const horizon = now.getTime() + SUPPLIES_WINDOW_DAYS * DAY;
  const rows: SuppliesRow[] = [];
  for (const m of live) {
    const rule = SUPPLY_RULES[m.kind];
    const soldAt = m.stock?.soldAt ?? m.createdAt;
    // Her purchases of this kind's supplies since the machine was sold (named for this machine or not).
    const mine = lines.filter((l) => l.sale.customerId === m.customerId && rule.types.includes(l.part!.itemType as ItemType) && (!l.machineId || l.machineId === m.id) && l.sale.createdAt >= soldAt);
    const due = runningLowAt(
      mine.map((l) => l.sale.createdAt),
      soldAt,
      rule.defaultDays,
    );
    if (due.at.getTime() > horizon) continue;
    const since = due.at.getTime() - SUPPLIES_WINDOW_DAYS * DAY;
    if (m.suppliesCare?.calledAt && m.suppliesCare.calledAt.getTime() >= since) continue;
    const last = mine.sort((a, b) => b.sale.createdAt.getTime() - a.sale.createdAt.getTime())[0] ?? null;
    rows.push({
      machineId: m.id,
      kind: m.kind,
      word: rule.word,
      customerId: m.customerId!,
      customer: m.customer!,
      brand: m.brand,
      model: m.model,
      lastBoughtAt: last?.sale.createdAt ?? null,
      dueAt: due.at,
      dueOn: ymdOf(due.at, shop.timeZone),
      from: due.from,
      overdue: due.at.getTime() <= now.getTime(),
      offer: last && last.part!.qtyOnHand > 0 ? last.part!.description : null,
      care: m.suppliesCare ? { calledAt: m.suppliesCare.calledAt, calledBy: m.suppliesCare.calledBy, callNote: m.suppliesCare.callNote, snoozeUntil: m.suppliesCare.snoozeUntil } : null,
    });
  }
  return rows.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

export async function suppliesDueCount(shopId: string): Promise<number> {
  return (await suppliesDue(shopId)).length;
}

// ---------------------------------------------------------------------------------------------------------------------
// The list's marks (Maker Shop on)

async function machineOf(user: CurrentUser, machineId: string) {
  await requireModule(user, "maker");
  const m = await db.machine.findFirst({ where: { id: assertId(machineId), shopId: user.shopId, kind: { in: Object.keys(SUPPLY_RULES) } }, select: { id: true } });
  if (!m) throw new UserError("Machine not found.");
  return m.id;
}

type CareData = { calledAt?: Date | null; calledBy?: string | null; callNote?: string | null; snoozeUntil?: Date | null; stoppedAt?: Date | null };

async function careUpsert(shopId: string, machineId: string, data: CareData): Promise<void> {
  const have = await db.suppliesCare.findUnique({ where: { machineId }, select: { shopId: true } });
  if (have && have.shopId !== shopId) throw new UserError("Machine not found.");
  await db.suppliesCare.upsert({ where: { machineId }, create: { machineId, shopId, ...data }, update: data });
}

export async function markSuppliesCalledFor(user: CurrentUser, machineId: string, fd?: FormData): Promise<string> {
  const id = await machineOf(user, machineId);
  const note = str(fd?.get("note") ?? null)?.slice(0, 200) ?? null;
  await careUpsert(user.shopId, id, { calledAt: new Date(), calledBy: user.name, callNote: note });
  return "Marked as called.";
}

export async function snoozeSuppliesFor(user: CurrentUser, machineId: string, days = SNOOZE_DAYS): Promise<string> {
  const id = await machineOf(user, machineId);
  await careUpsert(user.shopId, id, { snoozeUntil: new Date(Date.now() + days * DAY) });
  return `Left off the list for ${days} days.`;
}

export async function stopSuppliesFor(user: CurrentUser, machineId: string, stopped = true): Promise<string> {
  const id = await machineOf(user, machineId);
  await careUpsert(user.shopId, id, { stoppedAt: stopped ? new Date() : null });
  return stopped ? "No more reminders for this machine." : "Reminders are back on for this machine.";
}

/** The worker, right before a queued reminder goes: a reason to cancel, or null to send. */
export async function suppliesStillWanted(row: { shopId: string; refId: string | null; createdAt: Date }): Promise<string | null> {
  if (!(await moduleState(row.shopId, "maker")).active) return "Maker Shop is off";
  const m = row.refId ? await db.machine.findFirst({ where: { id: row.refId, shopId: row.shopId }, include: { suppliesCare: true } }) : null;
  if (!m || !m.customerId) return "The machine is gone";
  if (m.suppliesCare?.stoppedAt) return "Reminders stopped";
  const rule = SUPPLY_RULES[m.kind];
  if (!rule) return "Not a printer or cutter any more";
  const bought = await db.saleLine.count({ where: { qty: { gt: 0 }, part: { shopId: row.shopId, itemType: { in: rule.types } }, sale: { shopId: row.shopId, status: "COMPLETED", customerId: m.customerId, createdAt: { gt: row.createdAt } } } });
  return bought ? `They bought ${rule.word}` : null;
}

export type SuppliesSendResult = { queued: number; skipped: number; already: number };

/**
 * "Send reminders to the n due now": one supplies_due message per row due now through Marketing (consent and addresses
 * decide), the row marked contacted when something was queued. Needs Maker Shop and Marketing; an owner or admin.
 */
export async function sendSuppliesRemindersFor(user: CurrentUser, now: Date = new Date()): Promise<SuppliesSendResult> {
  const shopId = user.shopId;
  if (user.role === "TECH") throw new UserError("Only an owner or admin can send reminders.");
  await requireModule(user, "maker");
  if (!(await moduleOn(shopId, "marketing"))) throw new UserError("Sending reminders needs the Marketing module. This is your call list until then.");
  const [shop, ms, rows] = await Promise.all([db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true, address: true } }), messagingView(shopId), suppliesDue(shopId, now)]);
  if (!ms.emailReady && !ms.smsReady) throw new UserError("Email or texts have to be set up first (Settings → Messages).");
  const emailOk = !!(ms.postalAddress ?? shop.address) && (!(isDesktop() || !ms.publicUrl) || ms.replyWatched);
  const out: SuppliesSendResult = { queued: 0, skipped: 0, already: 0 };
  for (const r of rows.filter((x) => x.overdue)) {
    const machine = `${r.brand} ${r.model}`.replace(/\s+/g, " ").trim();
    const body = `Hi ${firstName(r.customer.name)}, running low on ${r.word} for your ${machine}?${r.offer ? ` We have ${r.offer} in stock.` : ""} Call ${shop.phone ?? "us"} or stop by.`;
    const q = await queueToCustomer(db, {
      shopId,
      customerId: r.customerId,
      kind: "supplies_due",
      channels: emailOk ? "one" : ["sms"],
      dedupeKey: `supplies_due:${r.machineId}:${r.dueOn}`,
      refType: "machine",
      refId: r.machineId,
      sendAfter: now,
      byUserId: user.id,
      staffCap: false,
      recordSkipped: false,
      ms,
      content: (ch) => (ch === "email" ? { subject: `Running low on ${r.word} for your ${machine}?`, body } : { body }),
    });
    if (q.queued.length) {
      out.queued += 1;
      await careUpsert(shopId, r.machineId, { calledAt: now, calledBy: "message" });
    } else if (q.duplicate.length) out.already += 1;
    else out.skipped += 1;
  }
  return out;
}
