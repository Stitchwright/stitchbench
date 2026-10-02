import "server-only";
// "Bags due" (modules-design.md section 10.c′): customers whose bagged vacuum is due for bags, worked out from what they
// bought (the vacuum itself, bags rung up for it, bags on its repair tickets, or bags on a sale with no vacuum picked
// when they have one bagged vacuum), the call list's marks (called, snoozed, stopped), the one-off send through
// Marketing, and the worker's "still wanted?" for a queued reminder. runBagsDue does nothing: automatic sending is cut.
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { str } from "@/lib/format";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView } from "@/lib/messaging/settings";
import { firstName, renderKind } from "@/lib/messaging/templates";
import { moduleOn } from "@/lib/module-gate";
import { isDesktop, moduleState, requireModule } from "@/lib/modules";
import type { CurrentUser } from "@/lib/session";
import { suppliesFor } from "@/lib/vac/finder";
import { monthsBetween, ymdOf } from "@/lib/zoned";

const DAY = 86_400_000;
/** Listed this many days before due, and "contacted" counts from this many days before due. */
export const BAGS_WINDOW_DAYS = 14;
export const BAG_DAYS_MIN = 30;
export const BAG_DAYS_MAX = 730;
const BAG_WORD = /\bbags?\b/i;

export type BagsDueRow = {
  machineId: string;
  customerId: string;
  customer: { name: string; phone: string | null; email: string | null };
  brand: string;
  model: string;
  bagType: string | null;
  /** When they last got bags (or the vacuum). */
  lastBagsAt: Date;
  dueAt: Date;
  dueOn: string;
  overdue: boolean;
  /** The first bag the finder says fits and the shop stocks, or null. */
  offer: string | null;
  care: { contactedAt: Date | null; contactedBy: string | null; contactNote: string | null; snoozedUntil: Date | null; stopped: boolean } | null;
};

type PartBit = { numberKeys: string[]; description: string } | null;

/** The keys of every bag entry in the community cross-reference that any of these parts shares a number with. */
async function bagKeys(parts: PartBit[]): Promise<Set<string>> {
  const keys = [...new Set(parts.flatMap((p) => p?.numberKeys ?? []))];
  if (!keys.length) return new Set();
  const rows = await db.xPart.findMany({ where: { category: "Vacuum bag", numberKeys: { hasSome: keys } }, select: { numberKeys: true } });
  return new Set(rows.flatMap((r) => r.numberKeys));
}

/** A line is bags when its part meets a "Vacuum bag" entry, or its words say bag(s). */
const looksLikeBags = (line: { description: string }, part: PartBit, keys: Set<string>) => BAG_WORD.test(line.description) || (!!part && (BAG_WORD.test(part.description) || part.numberKeys.some((k) => keys.has(k))));

const latest = (...dates: (Date | null | undefined)[]) => dates.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

/**
 * Who is due: bagged vacuums with a customer, not stopped or snoozed, whose last bags (or the vacuum's sale) plus the
 * shop's days between bags falls within the next 14 days or has passed, and nobody has got in touch since 14 days
 * before it was due. Sorted by due date. `offers: false` skips the finder lookups (for a count).
 */
export async function bagsDue(shopId: string, now: Date = new Date(), opts: { offers?: boolean } = {}): Promise<BagsDueRow[]> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { timeZone: true, bagReminderDays: true } });
  if (!shop) return [];
  const bagged = await db.machine.findMany({
    where: { shopId, equipment: "VACUUM", customerId: { not: null }, details: { path: ["bagged"], equals: "Bagged" } },
    include: { customer: { select: { id: true, name: true, phone: true, email: true } }, vacCare: true, stock: { select: { status: true, soldAt: true } } },
    take: 2000,
  });
  if (!bagged.length) return [];
  const perCustomer = new Map<string, number>();
  for (const m of bagged) perCustomer.set(m.customerId!, (perCustomer.get(m.customerId!) ?? 0) + 1);
  const live = bagged.filter((m) => !m.vacCare?.stopped && !(m.vacCare?.snoozedUntil && m.vacCare.snoozedUntil > now));
  if (!live.length) return [];
  const ids = live.map((m) => m.id);
  const customerIds = [...new Set(live.map((m) => m.customerId!))];
  const part = { select: { numberKeys: true, description: true } };
  const [forMachine, forCustomer, onTickets] = await Promise.all([
    db.saleLine.findMany({ where: { machineId: { in: ids }, qty: { gt: 0 }, sale: { shopId, status: "COMPLETED" } }, include: { part, sale: { select: { createdAt: true } } } }),
    db.saleLine.findMany({ where: { machineId: null, qty: { gt: 0 }, sale: { shopId, status: "COMPLETED", customerId: { in: customerIds } } }, include: { part, sale: { select: { createdAt: true, customerId: true } } } }),
    db.ticketLine.findMany({ where: { kind: "PART", ticket: { shopId, machineId: { in: ids } } }, include: { part, ticket: { select: { machineId: true } } } }),
  ]);
  const keys = await bagKeys([...forMachine, ...forCustomer, ...onTickets].map((l) => l.part));
  const byMachine = new Map<string, Date>();
  const byCustomer = new Map<string, Date>();
  for (const l of forMachine) if (looksLikeBags(l, l.part, keys)) byMachine.set(l.machineId!, latest(byMachine.get(l.machineId!), l.sale.createdAt)!);
  for (const l of onTickets) if (looksLikeBags(l, l.part, keys)) byMachine.set(l.ticket.machineId, latest(byMachine.get(l.ticket.machineId), l.createdAt)!);
  for (const l of forCustomer) if (l.sale.customerId && looksLikeBags(l, l.part, keys)) byCustomer.set(l.sale.customerId, latest(byCustomer.get(l.sale.customerId), l.sale.createdAt)!);

  const days = shop.bagReminderDays;
  const horizon = now.getTime() + BAGS_WINDOW_DAYS * DAY;
  const rows: BagsDueRow[] = [];
  for (const m of live) {
    const sold = m.stock?.status === "SOLD" ? m.stock.soldAt : null;
    const onlyOne = perCustomer.get(m.customerId!) === 1;
    const base = latest(sold, byMachine.get(m.id), onlyOne ? byCustomer.get(m.customerId!) : null);
    if (!base) continue;
    const dueAt = new Date(base.getTime() + days * DAY);
    if (dueAt.getTime() > horizon) continue;
    const since = dueAt.getTime() - BAGS_WINDOW_DAYS * DAY;
    if (m.vacCare?.contactedAt && m.vacCare.contactedAt.getTime() >= since) continue;
    const d = (m.details ?? {}) as Record<string, unknown>;
    rows.push({
      machineId: m.id,
      customerId: m.customerId!,
      customer: { name: m.customer!.name, phone: m.customer!.phone, email: m.customer!.email },
      brand: m.brand,
      model: m.model,
      bagType: typeof d.bagType === "string" && d.bagType.trim() ? d.bagType.trim() : null,
      lastBagsAt: base,
      dueAt,
      dueOn: ymdOf(dueAt, shop.timeZone),
      overdue: dueAt.getTime() <= now.getTime(),
      offer: null,
      care: m.vacCare ? { contactedAt: m.vacCare.contactedAt, contactedBy: m.vacCare.contactedBy, contactNote: m.vacCare.contactNote, snoozedUntil: m.vacCare.snoozedUntil, stopped: m.vacCare.stopped } : null,
    });
  }
  rows.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  if (opts.offers !== false) {
    const cache = new Map<string, string | null>();
    for (const r of rows) {
      const k = `${r.brand}|${r.model}|${r.bagType ?? ""}`;
      if (!cache.has(k)) {
        const { supplies } = await suppliesFor(shopId, { brand: r.brand, model: r.model, text: r.bagType });
        cache.set(k, supplies.find((s) => s.category === "Vacuum bag" && s.items.length)?.name ?? null);
      }
      r.offer = cache.get(k) ?? null;
    }
  }
  return rows;
}

export async function bagsDueCount(shopId: string): Promise<number> {
  return (await bagsDue(shopId, new Date(), { offers: false })).length;
}

/** The scheduler's hook: automatic sending is cut in this build, so this does nothing (notices' runSchedulers still calls it). */
export async function runBagsDue(_now: Date, _shopIds?: string[]): Promise<void> {
  void _now;
  void _shopIds;
}

/** Why a queued bags-due message should no longer go out, or null to send it. */
export async function bagsDueStillWanted(row: { shopId: string; refId: string | null; createdAt: Date }): Promise<string | null> {
  if (!(await moduleState(row.shopId, "vac")).active) return "Vac Shop is off";
  const m = row.refId ? await db.machine.findFirst({ where: { id: row.refId, shopId: row.shopId }, include: { vacCare: true } }) : null;
  if (!m) return "The vacuum is gone";
  if (m.vacCare?.stopped) return "Reminders stopped";
  if (m.vacCare?.snoozedUntil && m.vacCare.snoozedUntil > new Date()) return "Snoozed";
  const since = await db.saleLine.findMany({ where: { machineId: m.id, qty: { gt: 0 }, sale: { shopId: row.shopId, status: "COMPLETED", createdAt: { gt: row.createdAt } } }, include: { part: { select: { numberKeys: true, description: true } } } });
  if (since.length) {
    const keys = await bagKeys(since.map((l) => l.part));
    if (since.some((l) => looksLikeBags(l, l.part, keys))) return "They bought bags";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The call list's marks and the settings (each with a user; the actions add requireUser / requireAdmin)

async function vacuumOf(user: CurrentUser, machineId: string) {
  await requireModule(user, "vac");
  const m = await db.machine.findFirst({ where: { id: machineId, shopId: user.shopId, equipment: "VACUUM" }, select: { id: true } });
  if (!m) throw new UserError("Vacuum not found.");
  return m.id;
}

type CareData = { contactedAt?: Date | null; contactedBy?: string | null; contactNote?: string | null; snoozedUntil?: Date | null; stopped?: boolean };

/** The VacCare row for one of this company's vacuums (refusing a row that somehow belongs to another company). */
async function careUpsert(shopId: string, machineId: string, data: CareData): Promise<void> {
  const have = await db.vacCare.findUnique({ where: { machineId }, select: { shopId: true } });
  if (have && have.shopId !== shopId) throw new UserError("Vacuum not found.");
  await db.vacCare.upsert({ where: { machineId }, create: { machineId, shopId, ...data }, update: data });
}

export async function markCalledFor(user: CurrentUser, machineId: string, fd?: FormData): Promise<void> {
  const id = await vacuumOf(user, machineId);
  const note = str(fd?.get("note") ?? null)?.slice(0, 200) ?? null;
  await careUpsert(user.shopId, id, { contactedAt: new Date(), contactedBy: user.name, contactNote: note });
}

export async function snoozeBagsFor(user: CurrentUser, machineId: string, days = 30): Promise<void> {
  const id = await vacuumOf(user, machineId);
  await careUpsert(user.shopId, id, { snoozedUntil: new Date(Date.now() + days * DAY) });
}

export async function stopBagsFor(user: CurrentUser, machineId: string, stopped = true): Promise<void> {
  const id = await vacuumOf(user, machineId);
  await careUpsert(user.shopId, id, { stopped });
}

export async function saveBagDaysFor(user: CurrentUser, fd: FormData): Promise<void> {
  await requireModule(user, "vac");
  const n = Number(str(fd.get("bagReminderDays")));
  if (!Number.isInteger(n) || n < BAG_DAYS_MIN || n > BAG_DAYS_MAX) throw new UserError(`Days between bags: a whole number from ${BAG_DAYS_MIN} to ${BAG_DAYS_MAX}.`);
  await db.shop.update({ where: { id: user.shopId }, data: { bagReminderDays: n } });
}

export type BagsSendResult = { queued: number; skipped: number; already: number };

/**
 * "Send reminders to the n due now": one bags_due message per due vacuum through Marketing (consent and addresses
 * decide), the row marked contacted only when something was queued. Needs Vac Shop and Marketing both active.
 */
export async function sendBagRemindersFor(user: CurrentUser, now: Date = new Date()): Promise<BagsSendResult> {
  const shopId = user.shopId;
  await requireModule(user, "vac");
  if (!(await moduleOn(shopId, "marketing"))) throw new UserError("Sending reminders needs the Marketing module. This is your call list until then.");
  const [shop, ms, rows] = await Promise.all([db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true, address: true, timeZone: true } }), messagingView(shopId), bagsDue(shopId, now)]);
  if (!ms.emailReady && !ms.smsReady) throw new UserError("Email or texts have to be set up first (Settings → Messages).");
  // Marketing email carries the postal address and, without a public unsubscribe link, needs someone reading replies.
  const emailOk = !!(ms.postalAddress ?? shop.address) && (!(isDesktop() || !ms.publicUrl) || ms.replyWatched);
  const out: BagsSendResult = { queued: 0, skipped: 0, already: 0 };
  for (const r of rows) {
    const vars = {
      first_name: firstName(r.customer.name),
      name: r.customer.name,
      shop_name: shop.name,
      shop_phone: shop.phone ?? "",
      machine: `${r.brand} ${r.model}`.replace(/\s+/g, " ").trim(),
      months: String(monthsBetween(r.lastBagsAt, now, shop.timeZone)),
      bag_line: r.offer ? ` We have ${r.offer} in stock.` : "",
    };
    const q = await queueToCustomer(db, {
      shopId,
      customerId: r.customerId,
      kind: "bags_due",
      channels: emailOk ? "one" : ["sms"],
      dedupeKey: `bags_due:${r.machineId}:${r.dueOn}`,
      refType: "machine",
      refId: r.machineId,
      sendAfter: now,
      byUserId: user.id,
      staffCap: false,
      recordSkipped: false,
      ms,
      content: (ch) => renderKind(ms, "bags_due", ch, vars),
    });
    if (q.queued.length) {
      out.queued += 1;
      await careUpsert(shopId, r.machineId, { contactedAt: now, contactedBy: "message" });
    } else if (q.duplicate.length) out.already += 1;
    else out.skipped += 1;
  }
  return out;
}

/** The toast after a send. */
export function bagsSendWords(r: BagsSendResult): string {
  const parts = [`Queued ${r.queued}.`];
  if (r.skipped) parts.push(`${r.skipped} have no consent or no address: they stay on the list to call.`);
  if (r.already) parts.push(`${r.already} already had one queued.`);
  return parts.join(" ");
}
