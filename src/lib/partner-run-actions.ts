import "server-only";
// The work behind src/actions/partner-runs.ts (scheduling-messaging-design.md 13.3 and 13.5), callable with a user so
// the check script can drive it: which machines can ride, the default start, and propose / change / OK / cancel / record.
import crypto from "node:crypto";
import type { PartnerRun, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { assertId } from "@/lib/input";
import { str } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { requireOn } from "@/lib/module-gate";
import { hookContext } from "@/lib/notices/context";
import { normalizeTerms } from "@/lib/partner-terms";
import { partnerLink, runEffects, runPlan, sendRun } from "@/lib/partners";
import { canDo, otherSide, receivedList, type RunState, type Side } from "@/lib/partner-runs";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, fmtDay, parseHm, parseYmd, wall, ymdOf, zonedTime } from "@/lib/zoned";

type Json = Prisma.InputJsonValue;
export type RideJob = { id: string; tag: string; who: string; machine: string; status: string; ticketNumber: number | null; onRun: { id: string; startsAt: Date } | null };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function runState(r: PartnerRun): RunState {
  return { status: r.status as RunState["status"], ownerSide: r.ownerSide as Side, rev: r.rev, okRev: r.okRev, collectedAt: r.collectedAt?.toISOString() ?? null, deliveredAt: r.deliveredAt?.toISOString() ?? null };
}

/** The next date matching the partnership's pickup day (a weekday name), else tomorrow; 10:00 shop time. */
export function defaultStart(pickupDay: string | null, tz: string, now = new Date()): Date {
  const today = ymdOf(now, tz);
  const want = WEEKDAYS.findIndex((w) => w.startsWith((pickupDay ?? "").trim().toLowerCase().slice(0, 3)) && (pickupDay ?? "").trim().length >= 3);
  let ymd = addDays(today, 1);
  if (want >= 0) {
    for (let i = 1; i <= 7; i++) {
      const d = addDays(today, i);
      if (wall(zonedTime(d, 600, tz), tz).weekday === want) {
        ymd = d;
        break;
      }
    }
  }
  return zonedTime(ymd, 600, tz);
}

/**
 * The machines that can go on a run for this link (design 13.3): collect = waiting at the sewing shop; deliver = fixed
 * (or returned unrepaired) and not yet handed back. Each notes the SCHEDULED run it is already on in that direction.
 */
export async function rideJobs(shopId: string, link: { id: string; side: string }): Promise<{ collect: RideJob[]; deliver: RideJob[] }> {
  const jobs = await db.repairJob.findMany({ where: { shopId, linkId: link.id, side: link.side, pickedUpAt: null }, orderBy: { createdAt: "asc" } });
  const runs = await db.partnerRun.findMany({ where: { shopId, linkId: link.id, status: "SCHEDULED" }, select: { id: true, startsAt: true, collect: true, deliver: true } });
  const onRun = (id: string, dir: "collect" | "deliver") => {
    const r = runs.find((x) => x[dir].includes(id));
    return r ? { id: r.id, startsAt: r.startsAt } : null;
  };
  let statusOf: (j: (typeof jobs)[number]) => string;
  if (link.side === "repair") {
    const tickets = await db.ticket.findMany({ where: { shopId, id: { in: jobs.map((j) => j.ticketId).filter((x): x is string => !!x) } }, select: { id: true, status: true } });
    const byId = new Map(tickets.map((t) => [t.id, t.status as string]));
    statusOf = (j) => (j.ticketId ? (byId.get(j.ticketId) ?? j.status) : j.status);
  } else statusOf = (j) => j.status;
  const view = (j: (typeof jobs)[number], dir: "collect" | "deliver"): RideJob => ({ id: j.id, tag: j.tag, who: j.customerName, machine: `${j.brand} ${j.model}`, status: statusOf(j), ticketNumber: j.ticketNumber ?? null, onRun: onRun(j.id, dir) });
  const collect = jobs.filter((j) => statusOf(j) === "AT_SHOP_AWAITING_PICKUP").map((j) => view(j, "collect"));
  const deliver = jobs.filter((j) => ["READY_IN_TRUCK", "RETURNED_UNREPAIRED"].includes(statusOf(j)) && (link.side === "repair" || !j.backAt)).map((j) => view(j, "deliver"));
  return { collect, deliver };
}

async function ownRun(shopId: string, linkId: string, runId: string): Promise<PartnerRun> {
  const r = await db.partnerRun.findUnique({ where: { shopId_id: { shopId, id: assertId(runId) } } });
  if (!r || r.linkId !== linkId) throw new UserError("Run not found.");
  return r;
}

/** The plan's fields from the form: times, the driver, the machines (only this link's eligible ones), the note. */
async function planFrom(shopId: string, link: { id: string; side: string; partnerName: string }, fd: FormData, tz: string, exceptRunId?: string) {
  const ymd = parseYmd(str(fd.get("date")));
  if (!ymd) throw new UserError("Pick a date.");
  const start = parseHm(str(fd.get("start")));
  if (start == null) throw new UserError("Enter a start time like 10:00.");
  const endRaw = str(fd.get("end"));
  const end = endRaw ? parseHm(endRaw) : null;
  if (endRaw && end == null) throw new UserError("Enter an end time like 12:00.");
  if (end != null && (end <= start || end - start > 24 * 60)) throw new UserError("The end time must be after the start, on the same day.");
  const startsAt = zonedTime(ymd, start, tz);
  const endsAt = end != null ? zonedTime(ymd, end, tz) : null;
  const driver: Side = fd.get("driver") === "retail" ? "retail" : "repair";
  const ride = await rideJobs(shopId, link);
  const pick = (name: "collect" | "deliver") => {
    const ids = [...new Set(fd.getAll(name).map((v) => String(v)))];
    const ok = ride[name];
    for (const id of ids) {
      const j = ok.find((x) => x.id === id);
      if (!j) throw new UserError(`Tag ${id} can't go on this run.`);
      if (j.onRun && j.onRun.id !== exceptRunId) throw new UserError(`Tag ${j.tag} is already on the run on ${fmtDay(j.onRun.startsAt, tz)}.`);
    }
    return ids;
  };
  const collect = pick("collect");
  const deliver = pick("deliver");
  if (!collect.length && !deliver.length) throw new UserError("Tick at least one machine going or coming back.");
  const note = str(fd.get("note"))?.trim() ?? "";
  if (note.length > 1000) throw new UserError("The note is too long (1000 characters at most).");
  return { startsAt, endsAt, driver, collect, deliver, note: note || null };
}

async function linkFor(user: CurrentUser, linkId: string) {
  const link = await partnerLink(user.shopId, assertId(linkId));
  return link;
}

/** Schedule a run (Scheduling on). Returns the new run's id. */
export async function proposeRunAs(user: CurrentUser, linkId: string, fd: FormData): Promise<string> {
  await requireOn(user, "scheduling");
  const shopId = user.shopId;
  const link = await linkFor(user, linkId);
  if (!link.features.includes("pickup")) throw new UserError(`${link.partnerName}'s program is an older version that can't take runs yet. Ask them to update.`);
  const tz = await shopTimeZone(shopId);
  const plan = await planFrom(shopId, link, fd, tz);
  if (link.status !== "ACTIVE" && plan.collect.length) throw new UserError("The partnership has ended. Only machines coming back can go on a run.");
  const id = crypto.randomUUID();
  const at = new Date();
  await db.$transaction(async (tx) => {
    const run = await tx.partnerRun.create({ data: { id, shopId, linkId: link.id, ownerSide: link.side, rev: 1, ...plan, events: [{ at: at.toISOString(), side: link.side, what: "scheduled", name: user.name }] as Json } });
    await sendRun(tx, shopId, link.id, "pickup.plan", runPlan(run, user.name) as unknown as Json);
  });
  return id;
}

/** The owner changes the plan (Scheduling on): a new revision, sent to the partner. */
export async function changeRunAs(user: CurrentUser, linkId: string, runId: string, fd: FormData): Promise<void> {
  await requireOn(user, "scheduling");
  const shopId = user.shopId;
  const link = await linkFor(user, linkId);
  const cur = await ownRun(shopId, link.id, runId);
  const why = canDo(runState(cur), link.side as Side, "change", link.partnerName);
  if (why) throw new UserError(why);
  const tz = await shopTimeZone(shopId);
  const plan = await planFrom(shopId, link, fd, tz, cur.id);
  if (link.status !== "ACTIVE" && plan.collect.length) throw new UserError("The partnership has ended. Only machines coming back can go on a run.");
  const at = new Date();
  await db.$transaction(async (tx) => {
    const r = await tx.partnerRun.updateMany({ where: { shopId, id: cur.id, rev: cur.rev, status: "SCHEDULED" }, data: { ...plan, rev: cur.rev + 1, events: [...(cur.events as Json[]), { at: at.toISOString(), side: link.side, what: "changed", name: user.name }] as Json } });
    if (!r.count) throw new UserError("The run changed meanwhile. Reload the page.");
    const run = await tx.partnerRun.findUniqueOrThrow({ where: { shopId_id: { shopId, id: cur.id } } });
    await sendRun(tx, shopId, link.id, "pickup.plan", runPlan(run, user.name) as unknown as Json);
  });
}

/** The other side OKs the plan at its current revision. */
export async function okRunAs(user: CurrentUser, linkId: string, runId: string): Promise<void> {
  const shopId = user.shopId;
  const link = await linkFor(user, linkId);
  const cur = await ownRun(shopId, link.id, runId);
  const why = canDo(runState(cur), link.side as Side, "ok", link.partnerName);
  if (why) throw new UserError(why);
  const at = new Date();
  await db.$transaction(async (tx) => {
    const r = await tx.partnerRun.updateMany({ where: { shopId, id: cur.id, rev: cur.rev, status: "SCHEDULED" }, data: { okRev: cur.rev, okAt: at, events: [...(cur.events as Json[]), { at: at.toISOString(), side: link.side, what: "ok", name: user.name }] as Json } });
    if (!r.count) throw new UserError("The run changed meanwhile. Reload the page.");
    await sendRun(tx, shopId, link.id, "pickup.ok", { id: cur.id, rev: cur.rev, name: user.name, at: at.toISOString() });
  });
}

/** Either side cancels; the side that didn't schedule it must say why. */
export async function cancelRunAs(user: CurrentUser, linkId: string, runId: string, fd: FormData): Promise<void> {
  const shopId = user.shopId;
  const link = await linkFor(user, linkId);
  const cur = await ownRun(shopId, link.id, runId);
  const why = canDo(runState(cur), link.side as Side, "cancel", link.partnerName);
  if (why) throw new UserError(why);
  const note = str(fd.get("note"))?.trim().slice(0, 1000) || null;
  if (!note && cur.ownerSide !== link.side) throw new UserError(`Say why, so ${link.partnerName} knows.`);
  const at = new Date();
  await db.$transaction(async (tx) => {
    const r = await tx.partnerRun.updateMany({ where: { shopId, id: cur.id, status: "SCHEDULED" }, data: { status: "CANCELLED", cancelledAt: at, events: [...(cur.events as Json[]), { at: at.toISOString(), side: link.side, what: "cancelled", name: user.name, note: note ?? undefined }] as Json } });
    if (!r.count) throw new UserError("The run changed meanwhile. Reload the page.");
    await sendRun(tx, shopId, link.id, "pickup.cancel", { id: cur.id, note, name: user.name, at: at.toISOString() });
  });
}

/** This side records what it received (the repair shop: what the driver took; the sewing shop: what arrived). */
export async function recordRunAs(user: CurrentUser, linkId: string, runId: string, fd: FormData): Promise<void> {
  const shopId = user.shopId;
  const link = await linkFor(user, linkId);
  const cur = await ownRun(shopId, link.id, runId);
  const side = link.side as Side;
  const why = canDo(runState(cur), side, "record", link.partnerName);
  if (why) throw new UserError(why);
  const ids = [...new Set(fd.getAll("jobIds").map((v) => assertId(v)))].slice(0, 200);
  const mine = await db.repairJob.findMany({ where: { shopId, linkId: link.id, side: link.side, id: { in: ids } }, select: { id: true } });
  if (mine.length !== ids.length) throw new UserError("One of those machines isn't on this partnership.");
  const which = receivedList(side);
  const at = new Date();
  const ctx = await hookContext(shopId, user.name);
  await db.$transaction(async (tx) => {
    const r = await tx.partnerRun.updateMany({
      where: { shopId, id: cur.id, [`${which}At`]: null },
      data: { [which]: ids, [`${which}At`]: at, status: "DONE", events: [...(cur.events as Json[]), { at: at.toISOString(), side, what: which, name: user.name }] as Json },
    });
    if (!r.count) throw new UserError("You've recorded this run already.");
    await runEffects(tx, shopId, link, side, ids, at, user.id, ctx);
    await sendRun(tx, shopId, link.id, "pickup.done", { id: cur.id, side, list: ids, name: user.name, at: at.toISOString() });
  });
}

/** The partner's side name for messages ("the repair shop" / "the sewing shop"). */
export const partnerSideOf = (link: { side: string }): Side => otherSide(link.side as Side);
export const termsPickupDay = (link: { terms: unknown }) => normalizeTerms(link.terms).pickupDay;
