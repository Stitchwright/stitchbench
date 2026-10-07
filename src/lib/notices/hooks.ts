import "server-only";
// Where automatic notices hang off ticket and job changes (scheduling-messaging-design.md sections 7.1 and 9.2, 9.4).
// The exported names and signatures are a contract with foundation's callers; every hook that runs in a transaction uses
// only `tx` and the context loaded before it.
import type { Prisma, OutMessage } from "@/generated/prisma/client";
import type { TicketStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { SKIP_REASON_LABEL } from "@/lib/constants";
import { addDays, fmtDay, fmtTime, parseYmd, ymdOf, zonedTime } from "@/lib/zoned";
import { fmtPhone, toE164, validEmail } from "@/lib/phone";
import { UserError } from "@/lib/user-error";
import { allow } from "@/lib/rate-limit";
import type { CurrentUser } from "@/lib/session";
import type { JobEvent } from "@/lib/partners";
import { queueToCustomer } from "@/lib/messaging/queue";
import { nextTextTime } from "@/lib/messaging/quiet";
import { messagingView, type MessagingView } from "@/lib/messaging/settings";
import { renderKind } from "@/lib/messaging/templates";
import type { Channel, SkipReason } from "@/lib/messaging/types";
import type { TicketForStatus } from "@/lib/ticket-status";
import { hookContext, type HookCtx } from "@/lib/notices/context";
import { abandonDate, abandonStages, currentStage, parseStageKey, sendable, stageKey, type AbandonStage } from "@/lib/notices/abandon";
import { abandonTarget, abandonVars, jobVars, ticketVars, type AbandonTarget } from "@/lib/notices/vars";
import { estimateStillWanted } from "@/lib/estimate-links";
import { bagsDueStillWanted } from "@/lib/vac/bags-due";
import { partsInStillWanted } from "@/lib/part-waits";
import { orderNoticeStillWanted } from "@/lib/shop/online-shop";
import { renewNoticeStillWanted } from "@/lib/software";
import { suppliesStillWanted } from "@/lib/supplies-due";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof db;

export type JobForHook = { id: string; shopId: string; linkId: string; customerId: string | null; status: string; backAt: Date | null; pickedUpAt: Date | null };

/** The retail job statuses that mean "the repair shop says it's ready". */
export const READY_JOB_STATUSES = ["READY_FOR_PICKUP", "READY_IN_TRUCK", "RETURNED_UNREPAIRED"];

/** Seconds a ready notice waits so a mistaken status click can be undone (READY_NOTICE_DELAY_SECONDS, default 120). */
export function readyDelayMs(): number {
  const raw = process.env.READY_NOTICE_DELAY_SECONDS;
  const n = raw === undefined || raw.trim() === "" ? 120 : Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : 120) * 1000;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "A text", "An email", "A text and an email" */
function channelWords(channels: Channel[]): string {
  const hasText = channels.includes("sms");
  const hasMail = channels.includes("email");
  return hasText && hasMail ? "A text and an email" : hasText ? "A text" : "An email";
}

/** "8:32 pm", or "9:00 am tomorrow" / "9:00 am on Oct 7" when it is another day than `from` (shop time). */
function timeWords(d: Date, from: Date, tz: string): string {
  const day = ymdOf(d, tz);
  const today = ymdOf(from, tz);
  if (day === today) return fmtTime(d, tz);
  return `${fmtTime(d, tz)} ${day === addDays(today, 1) ? "tomorrow" : `on ${fmtDay(d, tz)}`}`;
}

/** When a queued text really goes: the worker holds every text outside the shop's quiet hours. */
function goesAt(q: { channel: Channel; address: string; sendAfter: Date }, ms: MessagingView, tz: string): Date {
  return q.channel === "sms" ? nextTextTime(q.sendAfter, tz, ms, false, q.address) : q.sendAfter;
}

/**
 * "A text and an email go to Mary at 8:32 pm" / "An email goes to Mary at 8:32 pm and a text at 9:00 am tomorrow": the
 * channels that were queued, with the time each really goes out.
 */
function goesWhen(queued: { channel: Channel; address: string; sendAfter: Date }[], name: string, now: Date, ms: MessagingView, tz: string): string {
  const at = new Map<Channel, Date>();
  for (const q of queued) at.set(q.channel, goesAt(q, ms, tz));
  const times = [...new Set([...at.values()].map((d) => d.getTime()))];
  const channels = [...at.keys()];
  if (times.length <= 1) {
    const d = at.get(channels[0]) ?? now;
    return `${channelWords(channels)} ${channels.length > 1 ? "go" : "goes"} to ${name} at ${timeWords(d, now, tz)}`;
  }
  const parts = channels.map((ch, i) => `${i === 0 ? (ch === "sms" ? "A text" : "An email") : ch === "sms" ? "a text" : "an email"} at ${timeWords(at.get(ch)!, now, tz)}`);
  return `${parts[0]} goes to ${name} and ${parts.slice(1).join(" and ")}`;
}

/** The stage notice for a target, queued (also used by the scheduler and "Send the current notice now"). */
export async function queueAbandonNotice(
  tx: Db,
  a: { shopId: string; target: AbandonTarget; stage: AbandonStage; ms: MessagingView; dedupeKey: string; sendAfter?: Date; byUserId?: string | null; staffCap?: boolean; recordSkipped?: boolean },
) {
  const { target, stage, ms } = a;
  const vars = abandonVars(target);
  return queueToCustomer(tx, {
    shopId: a.shopId,
    customerId: target.customerId,
    kind: "abandon",
    channels: "every",
    recordSkipped: a.recordSkipped ?? true,
    dedupeKey: a.dedupeKey,
    ...(target.kind === "ticket" ? { ticketId: target.id } : { repairJobId: target.id }),
    refType: "stage",
    refId: stageKey(target.start, stage),
    sendAfter: a.sendAfter,
    byUserId: a.byUserId ?? null,
    staffCap: a.staffCap,
    ms,
    content: (ch) => renderKind(ms, stage.final ? "abandon_final" : "abandon", ch, vars),
  });
}

/**
 * Inside the transaction that changed a ticket's status (only when it really changed). Returns the line for the staff
 * toast ("A text goes to Mary Smith at 10:44 am...") or null.
 */
export async function onTicketStatus(tx: Tx, t: TicketForStatus, status: TicketStatus, at: Date, ctx: HookCtx): Promise<string | null> {
  if (status !== "WAITING_CUSTOMER_OK") {
    // No longer waiting for the customer's OK: an estimate still waiting to go out would only confuse them.
    await tx.outMessage.updateMany({
      where: { shopId: t.shopId, ticketId: t.id, status: "QUEUED", kind: "estimate" },
      data: { status: "CANCELLED", error: "The ticket moved on before it went out" },
    });
  }
  if (status !== "READY_FOR_PICKUP") {
    // Leaving the pickup shelf: what was waiting to go out about it is stopped (whether or not Marketing is on).
    await tx.outMessage.updateMany({
      where: { shopId: t.shopId, ticketId: t.id, status: "QUEUED", kind: { in: ["ready", "abandon"] } },
      data: { status: "CANCELLED", error: "The ticket moved on before it went out" },
    });
    return null;
  }
  if (!ctx.notices || !ctx.ms.readyNotice) return null;
  const v = await ticketVars(tx, t.id, t.shopId);
  if (!v || !v.direct || v.jobType === "SITE" || !v.customerId) return null;
  const ready = t.pickupReadyAt ?? at;
  const sendAfter = new Date(at.getTime() + readyDelayMs());
  const r = await queueToCustomer(tx, {
    shopId: t.shopId,
    customerId: v.customerId,
    kind: "ready",
    channels: "preferred",
    dedupeKey: `ready:t:${t.id}:${ready.getTime()}`,
    ticketId: t.id,
    sendAfter,
    ms: ctx.ms,
    content: (ch) => renderKind(ctx.ms, "ready", ch, v.vars),
  });
  const name = v.vars.name || "the customer";
  if (r.queued.length) return `Ready. ${goesWhen(r.queued, name, at, ctx.ms, ctx.tz)}. Change the status back before then to stop it.`;
  if (!r.skipped.length) return null;
  const c = await tx.customer.findFirst({ where: { id: v.customerId, shopId: t.shopId }, select: { phone: true } });
  const phone = toE164(c?.phone);
  const reason = SKIP_REASON_LABEL[r.skipped[0].reason as SkipReason];
  return `Ready. No message: ${lower(reason)}. Call ${v.vars.first_name || name}${phone ? ` at ${fmtPhone(phone)}` : c?.phone ? ` at ${c.phone}` : ""}.`;
}

/**
 * Retail side, inside the transaction that applied a partner's job.update whose status changed. Leaving the ready states
 * (or collected) stops anything waiting; entering one sends nothing (the job shows on "Is it here?").
 */
export async function onJobStatus(tx: Tx, job: JobForHook, status: string, at: Date, ctx: HookCtx): Promise<void> {
  void at;
  void ctx;
  if (READY_JOB_STATUSES.includes(status)) return;
  await tx.outMessage.updateMany({
    where: { shopId: job.shopId, repairJobId: job.id, status: "QUEUED", kind: { in: ["ready", "abandon"] } },
    data: { status: "CANCELLED", error: "The repair moved on before it went out" },
  });
}

/**
 * Retail side: these jobs are back at our counter (a run's delivered list, "It's back"). `backAt` is already set. A
 * person confirmed it is here, so the ready notice goes now. Returns the line for the toast, or null.
 */
export async function onJobsBack(tx: Tx, shopId: string, jobIds: string[], at: Date, byUserId: string | null, ctx: HookCtx): Promise<string | null> {
  if (!ctx.notices || !ctx.ms.readyNotice || !jobIds.length) return null;
  const jobs = await tx.repairJob.findMany({
    where: { shopId, id: { in: jobIds }, side: "retail", customerId: { not: null }, pickedUpAt: null, backAt: { not: null } },
    select: { id: true, customerId: true, backAt: true },
  });
  const sent = new Set<string>();
  const channels = new Set<Channel>();
  let latest = at; // when the last of them goes out (texts wait for the shop's quiet hours to end)
  let skipped = 0;
  let noAddress = 0;
  for (const j of jobs) {
    const v = await jobVars(tx, j.id, shopId);
    if (!v || !j.customerId || !j.backAt) continue;
    const r = await queueToCustomer(tx, {
      shopId,
      customerId: j.customerId,
      kind: "ready",
      channels: "preferred",
      dedupeKey: `ready:j:${j.id}:${j.backAt.getTime()}`,
      repairJobId: j.id,
      sendAfter: at,
      byUserId,
      staffCap: false,
      ms: ctx.ms,
      content: (ch) => renderKind(ctx.ms, "ready", ch, v.vars),
    });
    if (r.queued.length) {
      sent.add(j.customerId);
      for (const q of r.queued) {
        channels.add(q.channel);
        const goes = goesAt(q, ctx.ms, ctx.tz);
        if (goes > latest) latest = goes;
      }
    } else if (r.skipped.length) {
      skipped += 1;
      if (r.skipped.every((s) => s.reason === "no_address")) noAddress += 1;
    }
  }
  if (!sent.size && !skipped) return null;
  const parts: string[] = [];
  if (sent.size) {
    const label = channels.size === 1 ? (channels.has("sms") ? "Texts" : "Emails") : "Messages";
    const when = latest > at ? `${channels.has("email") ? "by " : "at "}${timeWords(latest, at, ctx.tz)} (quiet hours)` : "now";
    parts.push(`${label} go to ${sent.size} customer${sent.size === 1 ? "" : "s"} ${when}`);
  }
  if (skipped) parts.push(`${skipped} ${noAddress === skipped ? `ha${skipped === 1 ? "s" : "ve"} no mobile number or email` : "can't be messaged"}: call them`);
  return `Recorded. ${parts.join("; ")}.`;
}

// ---------- stillWanted ----------

const keyParts = (row: OutMessage) => (row.dedupeKey ?? "").split(":");

/** Worker, right before sending: a reason to cancel ("The machine was picked up"), or null to send. */
export async function stillWanted(row: OutMessage): Promise<string | null> {
  if (row.kind === "bags_due") {
    const r: unknown = await bagsDueStillWanted(row);
    if (typeof r === "string") return r;
    return r === false ? "It's no longer due" : null;
  }
  switch (row.kind) {
    case "ready":
      return readyWanted(row);
    case "abandon":
      return abandonWanted(row);
    case "reminder":
      return reminderWanted(row);
    case "estimate":
      return estimateStillWanted(row);
    case "service_due":
      return serviceDueWanted(row);
    case "consent_confirm":
      return consentWanted(row);
    case "parts_in":
      return partsInStillWanted(row);
    case "order_notice":
      return orderNoticeStillWanted(row);
    case "software_renew":
      return renewNoticeStillWanted(row);
    case "supplies_due":
      return suppliesStillWanted(row);
    default:
      return null;
  }
}

const GONE = "It was picked up or moved on";

async function readyWanted(row: OutMessage): Promise<string | null> {
  const p = keyParts(row); // ready:t:{id}:{ms}:{channel} (manual rows: manual:ready:{id}:{ms}:{channel})
  const auto = p[0] === "ready";
  const at = auto && /^\d+$/.test(p[3] ?? "") ? Number(p[3]) : null;
  if (row.ticketId) {
    const t = await db.ticket.findFirst({ where: { id: row.ticketId, shopId: row.shopId }, select: { status: true, pickupReadyAt: true } });
    if (!t || t.status !== "READY_FOR_PICKUP") return GONE;
    if (at !== null && t.pickupReadyAt?.getTime() !== at) return GONE;
    return null;
  }
  if (row.repairJobId) {
    const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId: row.shopId, id: row.repairJobId } }, select: { status: true, pickedUpAt: true, backAt: true } });
    if (!j || j.pickedUpAt || !j.backAt || !READY_JOB_STATUSES.includes(j.status)) return GONE;
    if (at !== null && j.backAt.getTime() !== at) return GONE;
  }
  return null;
}

async function abandonWanted(row: OutMessage): Promise<string | null> {
  const parsed = parseStageKey(row.refId);
  if (!parsed) return null;
  const target = await abandonTarget(db, row.shopId, { ticketId: row.ticketId, jobId: row.repairJobId });
  if (!target || target.start.getTime() !== parsed.start) return GONE;
  // A notice a person asked for ("Send the current notice now") goes out whatever the window says.
  if (row.dedupeKey?.startsWith("manual:")) return null;
  const ms = await messagingView(row.shopId);
  const stages = abandonStages(target.start, ms.abandonDays, target.abandonedAfterDays, ms.finalNoticeDays, ms.reminderHour, target.tz);
  const s = sendable(stages, new Date(), abandonDate(target.start, target.abandonedAfterDays, target.tz));
  if (!s) return "Too late to send: decide by hand";
  return s.key === parsed.key ? null : "A later notice replaced it";
}

async function reminderWanted(row: OutMessage): Promise<string | null> {
  const p = keyParts(row); // remind:m:{meetingId}:{enrollmentId}:{startsAt ms}:{channel} / remind:a:{id}:{startsAt ms}:{channel}
  if (row.refType === "meeting" && row.refId) {
    const enrollmentId = p[3];
    const keyed = Number(p[4]);
    const m = await db.classMeeting.findFirst({ where: { id: row.refId, shopId: row.shopId }, include: { shopClass: { select: { status: true } } } });
    if (!m || m.cancelled || m.shopClass.status === "CANCELLED") return "The booking changed";
    const e = enrollmentId ? await db.enrollment.findFirst({ where: { id: enrollmentId, shopId: row.shopId }, select: { status: true } }) : null;
    if (!e || e.status !== "ENROLLED") return "The booking changed";
    if (Number.isFinite(keyed) && m.startsAt.getTime() !== keyed) return "The time changed";
    return null;
  }
  if (row.refType === "appointment" && row.refId) {
    const keyed = Number(p[3]);
    const a = await db.appointment.findFirst({ where: { id: row.refId, shopId: row.shopId }, select: { status: true, blocked: true, startsAt: true } });
    if (!a || a.status !== "BOOKED" || a.blocked) return "The booking changed";
    if (Number.isFinite(keyed) && a.startsAt.getTime() !== keyed) return "The time changed";
  }
  return null;
}

/** A listed machine came back in after the message was queued: a ticket or a retail job newer than the message. */
async function serviceDueWanted(row: OutMessage): Promise<string | null> {
  if (!row.customerId) return null;
  const machines = await db.machine.findMany({ where: { shopId: row.shopId, OR: [{ customerId: row.customerId, serviceNoticeFor: { not: null } }, ...(row.refType === "machine" && row.refId ? [{ id: row.refId }] : [])] }, select: { id: true } });
  if (!machines.length) return null;
  const ids = machines.map((m) => m.id);
  const [t, j] = await Promise.all([
    db.ticket.findFirst({ where: { shopId: row.shopId, machineId: { in: ids }, intakeAt: { gt: row.createdAt } }, select: { id: true } }),
    db.repairJob.findFirst({ where: { shopId: row.shopId, machineId: { in: ids }, side: "retail", createdAt: { gt: row.createdAt } }, select: { id: true } }),
  ]);
  return t || j ? "The machine came back in" : null;
}

async function consentWanted(row: OutMessage): Promise<string | null> {
  if (!row.customerId) return null;
  const c = await db.customer.findFirst({ where: { id: row.customerId, shopId: row.shopId }, select: { smsConsentAt: true, smsConsentPhone: true } });
  return !c || !c.smsConsentAt || c.smsConsentPhone !== row.address ? "Consent withdrawn" : null;
}

// ---------- the work behind src/actions/notices.ts (the actions check who is asking and the module; these do the rest) ----------

export type NoticeTarget = { ticketId?: string | null; jobId?: string | null };

/**
 * "It's back at the counter" for retail jobs: backAt, a history line, and the ready notice (onJobsBack), in one
 * transaction. `callThem`: the note asks staff to call someone (Messages off, or a customer who can't be messaged).
 */
export async function recordBack(user: CurrentUser, ids: string[], o: { single: boolean; now?: Date }): Promise<{ note: string; callThem: boolean }> {
  const shopId = user.shopId;
  const at = o.now ?? new Date();
  const ctx = await hookContext(shopId, user.name); // before the transaction: the hook never opens a second connection
  const jobs = await db.repairJob.findMany({ where: { shopId, id: { in: ids }, side: "retail" } });
  let eligible = jobs.filter((j) => !j.pickedUpAt && READY_JOB_STATUSES.includes(j.status) && !j.backAt);
  if (o.single) {
    const j = jobs[0];
    if (!j) throw new UserError("Repair not found.");
    if (j.pickedUpAt || !READY_JOB_STATUSES.includes(j.status)) throw new UserError("It isn't back from the repair shop yet.");
    if (j.backAt) throw new UserError("Already recorded.");
  } else if (!eligible.length) throw new UserError("Nothing to record: those are already recorded, picked up, or not ready yet.");
  eligible = eligible.slice(0, 100);
  return db.$transaction(
    async (tx) => {
      const done: string[] = [];
      for (const j of eligible) {
        const events = [...(Array.isArray(j.events) ? (j.events as JobEvent[]) : []), { at: at.toISOString(), note: `Back at the counter (${user.name})` }];
        const r = await tx.repairJob.updateMany({ where: { shopId, id: j.id, backAt: null, pickedUpAt: null }, data: { backAt: at, events: events as Prisma.InputJsonValue } });
        if (r.count) done.push(j.id);
      }
      if (!done.length) throw new UserError("Already recorded.");
      const note = await onJobsBack(tx, shopId, done, at, user.id, ctx);
      if (note) return { note, callThem: /call them/.test(note) };
      if (ctx.notices) return { note: "Recorded.", callThem: false };
      return { note: `Recorded. Messages are off: call the ${done.length === 1 ? "customer" : "customers"}.`, callThem: true };
    },
    { timeout: 60_000 },
  );
}

/** The ticket or retail job must be this shop's: anything else is "not found", whatever shop it belongs to. */
async function ownTarget(shopId: string, t: NoticeTarget): Promise<void> {
  if (t.ticketId) {
    if (!(await db.ticket.findFirst({ where: { id: t.ticketId, shopId }, select: { id: true } }))) throw new UserError("Ticket not found.");
  } else if (t.jobId) {
    const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id: t.jobId } }, select: { side: true } });
    if (!j || j.side !== "retail") throw new UserError("Repair not found.");
  } else throw new UserError("Not found.");
}

const HOW = ["letter", "certified_mail", "phone", "email", "sms"];
const STAGE_KEYS = ["first", "second", "third", "fourth", "final"];

/** A notice given by hand, kept as proof (a SENT row). Anyone may record one; more than 14 days back needs an admin. */
export async function recordManual(
  user: CurrentUser,
  target: NoticeTarget,
  f: { stage: string | null; how: string | null; date: string | null; text: string | null; tracking: string | null },
  now = new Date(),
): Promise<void> {
  const shopId = user.shopId;
  await ownTarget(shopId, target);
  const t = await abandonTarget(db, shopId, target);
  if (!t) throw new UserError(target.jobId ? "Record that it's back at the counter first." : "This ticket isn't waiting for pickup.");
  if (!f.stage || !STAGE_KEYS.includes(f.stage)) throw new UserError("Pick which notice this was.");
  if (!f.how || !HOW.includes(f.how)) throw new UserError("Pick how it was given.");
  const today = ymdOf(now, t.tz);
  const date = f.date ? parseYmd(f.date) : today;
  if (!date) throw new UserError("Enter the date it was given.");
  if (date > today) throw new UserError("The date can't be in the future.");
  if (date < addDays(today, -14) && user.role === "TECH") throw new UserError("Only an owner or admin can record a notice more than 14 days back.");
  const text = (f.text ?? "").trim();
  if (!text) throw new UserError("Say what was sent or said.");
  if (text.length > 5000) throw new UserError("That's too long (5000 characters at most).");
  const tracking = (f.tracking ?? "").trim();
  if (f.how === "certified_mail" && !tracking) throw new UserError("Enter the tracking number.");
  const c = await db.customer.findFirst({ where: { id: t.customerId, shopId }, select: { phone: true, email: true, address: true } });
  const found = f.how === "sms" ? (toE164(c?.phone) ?? c?.phone) : f.how === "email" ? validEmail(c?.email) : f.how === "phone" ? c?.phone : c?.address;
  await db.outMessage.create({
    data: {
      shopId,
      channel: f.how,
      purpose: "notice",
      kind: "abandon",
      customerId: t.customerId,
      address: found?.toString().trim().slice(0, 300) || "by hand",
      body: text,
      status: "SENT",
      // "byhand:" rows were never sent from here: the staff cap (queue.ts) and the worker leave them alone.
      dedupeKey: `byhand:${t.kind}:${t.id}:${now.getTime()}`,
      sentAt: zonedTime(date, 12 * 60, t.tz),
      providerId: f.how === "certified_mail" && tracking ? tracking.slice(0, 200) : null,
      ...(t.kind === "ticket" ? { ticketId: t.id } : { repairJobId: t.id }),
      refType: "stage",
      refId: `${t.start.getTime()}:${f.stage}`,
      byUserId: user.id,
    },
  });
}

/** "Send the ready notice again" / "Send the current notice now": queued now by a person (3 per address per day). */
export async function sendNow(user: CurrentUser, target: NoticeTarget, kind: "ready" | "abandon", now = new Date()): Promise<void> {
  const shopId = user.shopId;
  await ownTarget(shopId, target);
  const id = target.ticketId ?? target.jobId ?? "";
  if (!allow(`notice:${id}`, 5, 3_600_000)) throw new UserError("That's been sent a few times already. Give it a while.");
  const ms = await messagingView(shopId);
  let r;
  if (kind === "abandon") {
    const t = await abandonTarget(db, shopId, target);
    if (!t) throw new UserError(target.jobId ? "It isn't back at the counter, or was picked up." : "This ticket isn't waiting for pickup.");
    const stage = currentStage(abandonStages(t.start, ms.abandonDays, t.abandonedAfterDays, ms.finalNoticeDays, ms.reminderHour, t.tz), now);
    if (!stage) throw new UserError("There is no notice due: check the days under Settings -> Messages.");
    const waiting = await db.outMessage.findFirst({
      where: { shopId, kind: "abandon", refType: "stage", refId: stageKey(t.start, stage), status: { in: ["QUEUED", "SENDING"] }, ...(t.kind === "ticket" ? { ticketId: t.id } : { repairJobId: t.id }) },
      select: { sendAfter: true, channel: true, address: true },
    });
    if (waiting) {
      const goes = goesAt({ channel: waiting.channel as Channel, address: waiting.address, sendAfter: waiting.sendAfter }, ms, t.tz);
      throw new UserError(`That notice is already waiting to go out (${timeWords(goes, now, t.tz)}).`);
    }
    r = await queueAbandonNotice(db, { shopId, target: t, stage, ms, dedupeKey: `manual:abandon:${id}:${now.getTime()}`, sendAfter: now, byUserId: user.id, recordSkipped: false });
  } else {
    let customerId: string | null = null;
    let vars: Record<string, string> | null = null;
    const base: { ticketId?: string; repairJobId?: string } = {};
    if (target.ticketId) {
      const t = await db.ticket.findFirst({ where: { id: target.ticketId, shopId }, select: { status: true } });
      if (!t || t.status !== "READY_FOR_PICKUP") throw new UserError("This ticket isn't waiting for pickup.");
      const v = await ticketVars(db, target.ticketId, shopId);
      if (!v || !v.direct || v.jobType === "SITE") throw new UserError("This ticket isn't waiting for pickup.");
      customerId = v.customerId;
      vars = v.vars;
      base.ticketId = target.ticketId;
    } else if (target.jobId) {
      const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id: target.jobId } }, select: { side: true, backAt: true, pickedUpAt: true } });
      if (!j || j.side !== "retail" || !j.backAt || j.pickedUpAt) throw new UserError("It isn't back at the counter, or was picked up.");
      const v = await jobVars(db, target.jobId, shopId);
      customerId = v?.customerId ?? null;
      vars = v?.vars ?? null;
      base.repairJobId = target.jobId;
    }
    if (!customerId || !vars) throw new UserError("There's no customer on this one.");
    const v = vars;
    r = await queueToCustomer(db, {
      shopId,
      customerId,
      kind: "ready",
      channels: "preferred",
      dedupeKey: `manual:ready:${id}:${now.getTime()}`,
      ...base,
      sendAfter: now,
      byUserId: user.id,
      recordSkipped: false,
      ms,
      content: (ch) => renderKind(ms, "ready", ch, v),
    });
  }
  if (r.queued.length) return;
  const why = r.skipped[0]?.reason as SkipReason | undefined;
  if (why === "staff_cap") throw new UserError("They've had 3 messages from you today. Call them instead.");
  throw new UserError(why ? `${SKIP_REASON_LABEL[why]}. Call them instead.` : "Nothing was queued.");
}

