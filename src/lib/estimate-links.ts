import "server-only";
// Estimate approval by link (scheduling-messaging-design.md section 10): the link, the page's view of it, the customer's
// answer, and the bodies of the staff actions (src/actions/estimate-links.ts wraps them with requireUser, so a check
// script can call them with a user). Every query filters by shopId; the public page finds a link by its token's hash
// only and uses that link's shopId from then on.
import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import type { EstimateLink, InboundText, OutMessage, Prisma } from "@/generated/prisma/client";
import { SKIP_REASON_LABEL } from "@/lib/constants";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { requireEquipment } from "@/lib/equipment/gate";
import { answerRetailEstimate, answerTicketEstimate } from "@/lib/estimate-answer";
import { fmtDateTime, money, ticketNo } from "@/lib/format";
import { allowed, consentState } from "@/lib/messaging/consent";
import { seal } from "@/lib/messaging/secrets";
import { publicBaseUrl, type MessagingView } from "@/lib/messaging/settings";
import { queueToCustomer } from "@/lib/messaging/queue";
import { cleanText, firstName, renderKind, type Content } from "@/lib/messaging/templates";
import type { Channel, SkipReason } from "@/lib/messaging/types";
import { requireOn } from "@/lib/module-gate";
import { hookContext } from "@/lib/notices/context";
import type { JobEvent, JobLine } from "@/lib/partners";
import { toE164, fmtPhone } from "@/lib/phone";
import type { CurrentUser } from "@/lib/session";
import { lineTotal, ticketTotals } from "@/lib/ticket-math";
import { dayStart, ymdOf } from "@/lib/zoned";

type Db = Prisma.TransactionClient | typeof db;
type Line = { description: string; amountCents: number };

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DAY = 86_400_000;
export const MAX_ESTIMATE_SENDS_PER_DAY = 3;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Revalidation only means something inside Next: a check script has no request, so a failure here is not an error. */
function refresh(paths: string[]) {
  for (const p of paths) {
    try {
      revalidatePath(p);
    } catch {
      /* outside Next (a check script) */
    }
  }
}
const refreshTarget = (a: { ticketId?: string | null; repairJobId?: string | null }) =>
  refresh([...(a.ticketId ? [`/tickets/${a.ticketId}`] : []), ...(a.repairJobId ? [`/repairs/${a.repairJobId}`] : []), "/", "/register", "/repairs", "/tickets"]);

// ---------------------------------------------------------------------------------------------------------------------
// The link

export type EstimateView = {
  shopName: string;
  shopPhone: string | null;
  firstName: string;
  machine: string;
  ref: string;
  lines: Line[];
  totalCents: number;
  note: string | null;
  expiresAt: Date;
  state: "open" | "answered" | "expired" | "revoked";
  answer: "APPROVED" | "DECLINED" | null;
  answeredAt: Date | null;
  tz: string;
};

/** The ticket's bill as the customer is shown it: each line's total, then "Tax" as its own line. */
export type TicketWithLines = {
  taxRatePct: number;
  lines: { kind: string; description: string; qty: number; unitPriceCents: number; taxable: boolean }[];
};
export function ticketEstimateLines(t: TicketWithLines): { lines: Line[]; totalCents: number } {
  const tot = ticketTotals(t.lines, [], t.taxRatePct);
  const lines: Line[] = t.lines.map((l) => ({
    description: `${cleanText(l.description, 120) || "Item"}${l.qty !== 1 ? ` x${l.qty}` : ""}`,
    amountCents: lineTotal(l),
  }));
  if (tot.tax > 0) lines.push({ description: "Tax", amountCents: tot.tax });
  return { lines, totalCents: tot.total };
}

/** A partner job's bill (the repair shop's lines and tax) as the customer is shown it. */
export function jobEstimateLines(j: { lines: unknown; taxCents: number | null; totalCents: number | null }): { lines: Line[]; totalCents: number } {
  const src = Array.isArray(j.lines) ? (j.lines as JobLine[]) : [];
  const lines: Line[] = src.map((l) => ({ description: `${cleanText(l.description, 120) || "Item"}${l.qty !== 1 && l.qty ? ` x${l.qty}` : ""}`, amountCents: l.amountCents }));
  if ((j.taxCents ?? 0) > 0) lines.push({ description: "Tax", amountCents: j.taxCents! });
  return { lines, totalCents: j.totalCents ?? 0 };
}

/**
 * A new link for one ticket or job. The older unanswered ones are stopped (one live link per ticket / job). The raw token
 * is never returned: it is sealed here until its messages have gone (the worker puts it into the text at send time).
 */
export async function createEstimateLink(
  tx: Db,
  a: { shopId: string; ticketId?: string; repairJobId?: string; customerId: string; totalCents: number; lines: Line[]; note: string | null; days: number; byUserId: string },
): Promise<{ id: string; maskedUrl: string; expiresAt: Date }> {
  const base = publicBaseUrl();
  if (!base) throw new UserError("This install has no public address, so there are no estimate links.");
  if (!a.ticketId === !a.repairJobId) throw new Error("createEstimateLink: a ticket or a job, not both");
  const now = new Date();
  await tx.estimateLink.updateMany({
    where: { shopId: a.shopId, answer: null, revokedAt: null, ...(a.ticketId ? { ticketId: a.ticketId } : { repairJobId: a.repairJobId }) },
    data: { revokedAt: now, tokenSealed: null },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  const id = `c${crypto.randomBytes(12).toString("hex")}`;
  const maskedUrl = `${base}/e/•••${token.slice(-4)}`;
  const expiresAt = new Date(now.getTime() + a.days * DAY);
  await tx.estimateLink.create({
    data: {
      id,
      shopId: a.shopId,
      tokenHash: sha256(token),
      tokenSealed: seal(token, a.shopId, `estimateToken:${id}`),
      maskedUrl,
      ticketId: a.ticketId ?? null,
      repairJobId: a.repairJobId ?? null,
      customerId: a.customerId,
      totalCents: a.totalCents,
      lines: a.lines.map((l) => ({ description: cleanText(l.description, 160), amountCents: l.amountCents })),
      note: a.note ? cleanText(a.note, 500) || null : null,
      expiresAt,
      createdById: a.byUserId,
    },
  });
  return { id, maskedUrl, expiresAt };
}

/** What a link is about right now: the machine and ref to show, and whether the ticket / job still waits for the answer. */
async function targetOf(tx: Db, link: EstimateLink): Promise<{ machine: string; ref: string; waiting: boolean; customerName: string | null }> {
  if (link.ticketId) {
    const t = await tx.ticket.findFirst({
      where: { id: link.ticketId, shopId: link.shopId },
      select: { number: true, status: true, jobType: true, estimateAnswer: true, machine: { select: { brand: true, model: true } }, customer: { select: { name: true } } },
    });
    if (!t) return { machine: "machine", ref: "", waiting: false, customerName: null };
    return {
      machine: t.jobType === "SITE" ? "central vac install" : `${t.machine.brand} ${t.machine.model}`,
      ref: `ticket ${ticketNo(t.number)}`,
      waiting: t.status === "WAITING_CUSTOMER_OK" && !t.estimateAnswer,
      customerName: t.customer?.name ?? null,
    };
  }
  if (link.repairJobId) {
    const j = await tx.repairJob.findUnique({ where: { shopId_id: { shopId: link.shopId, id: link.repairJobId } }, include: { customer: { select: { name: true } } } });
    if (!j || j.side !== "retail") return { machine: "machine", ref: "", waiting: false, customerName: null };
    return { machine: `${j.brand} ${j.model}`, ref: `tag ${j.tag}`, waiting: j.status === "WAITING_CUSTOMER_OK" && !j.approval, customerName: j.customer?.name ?? j.customerName };
  }
  return { machine: "machine", ref: "", waiting: false, customerName: null };
}

/** The link and what the public page shows for it; null for a token that isn't one (no database lookup then). */
export async function estimateByToken(token: string, now = new Date()): Promise<{ link: EstimateLink; view: EstimateView } | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const link = await db.estimateLink.findUnique({ where: { tokenHash: sha256(token) } });
  if (!link) return null;
  const [shop, target] = await Promise.all([db.shop.findUnique({ where: { id: link.shopId }, select: { name: true, phone: true, timeZone: true } }), targetOf(db, link)]);
  if (!shop) return null;
  let state: EstimateView["state"];
  if (link.answer) state = "answered";
  else if (link.revokedAt) state = "revoked";
  else if (link.expiresAt <= now) state = "expired";
  else if (!target.waiting) {
    // The ticket or job moved on (the counter answered, it went back to the bench): the link stops working.
    await db.estimateLink.updateMany({ where: { id: link.id, shopId: link.shopId, answer: null, revokedAt: null }, data: { revokedAt: now, tokenSealed: null } });
    state = "revoked";
  } else state = "open";
  const lines = (Array.isArray(link.lines) ? (link.lines as Line[]) : []).map((l) => ({ description: String(l.description ?? ""), amountCents: Number(l.amountCents) || 0 }));
  return {
    link,
    view: {
      shopName: shop.name,
      shopPhone: shop.phone,
      firstName: firstName(target.customerName ?? ""),
      machine: target.machine,
      ref: target.ref,
      lines,
      totalCents: link.totalCents,
      note: link.note,
      expiresAt: link.expiresAt,
      state,
      answer: link.answer === "APPROVED" || link.answer === "DECLINED" ? link.answer : null,
      answeredAt: link.answeredAt,
      tz: shop.timeZone,
    },
  };
}

class Gone extends Error {}

/**
 * The customer's single answer. "gone" when the link was answered, stopped or has expired, or the counter answered first.
 * `from` = `${clientAddress(req) ?? "address not known"} · ${userAgent.slice(0, 200)}`.
 */
export async function answerByToken(token: string, answer: "APPROVED" | "DECLINED", note: string | null, from: string, now = new Date()): Promise<"ok" | "gone"> {
  if (answer !== "APPROVED" && answer !== "DECLINED") return "gone";
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return "gone";
  const link = await db.estimateLink.findUnique({ where: { tokenHash: sha256(token) } });
  if (!link) return "gone";
  const shopId = link.shopId;
  const cleaned = note ? cleanText(note, 500) || null : null;
  const ctx = await hookContext(shopId);
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { warrantyDays: true } });
  try {
    await db.$transaction(async (tx) => {
      const claimed = await tx.estimateLink.updateMany({
        where: { id: link.id, shopId, answer: null, revokedAt: null, expiresAt: { gt: now } },
        data: { answer, answerNote: cleaned, answeredAt: now, answerFrom: from.slice(0, 400), tokenSealed: null },
      });
      if (!claimed.count) throw new Gone();
      const approvedCents = answer === "APPROVED" ? link.totalCents : null;
      if (link.ticketId) {
        const t = await tx.ticket.findFirst({ where: { id: link.ticketId, shopId } });
        if (t && t.status === "WAITING_CUSTOMER_OK" && !t.estimateAnswer) {
          await answerTicketEstimate(tx, { ticket: t, warrantyDays: shop.warrantyDays, approval: answer, approvedCents, note: cleaned, via: "link", at: now, tz: ctx.tz, ctx });
          await cancelQueuedEstimates(tx, shopId, { ticketId: t.id }, "The customer answered by link");
        } else if (t) {
          const line = `${fmtDateTime(now, ctx.tz)}: Answer by link arrived after it moved on (${answer === "APPROVED" ? "approved" : "declined"}).`;
          await tx.ticket.updateMany({ where: { id: t.id, shopId }, data: { notes: [t.notes, line].filter(Boolean).join("\n").slice(-20_000) } });
        }
      } else if (link.repairJobId) {
        const job = await tx.repairJob.findUnique({ where: { shopId_id: { shopId, id: link.repairJobId } }, include: { customer: { select: { name: true } } } });
        if (job && job.side === "retail" && job.status === "WAITING_CUSTOMER_OK") {
          const byName = firstName(job.customer?.name ?? job.customerName);
          const done = await answerRetailEstimate(tx, { shopId, job, approval: answer, approvedCents, note: cleaned, byName, via: "link", at: now });
          if (!done) throw new Gone(); // the counter answered first
          await cancelQueuedEstimates(tx, shopId, { repairJobId: job.id }, "The customer answered by link");
        } else if (job) {
          const events = [...((job.events as JobEvent[]) ?? []), { at: now.toISOString(), note: "Answer by link arrived after it moved on" }];
          await tx.repairJob.updateMany({ where: { shopId, id: job.id }, data: { events: events as Prisma.InputJsonValue } });
        }
      }
    });
  } catch (e) {
    if (e instanceof Gone) return "gone";
    throw e;
  }
  refreshTarget(link);
  return "ok";
}

/** The worker's "still wanted?" for an estimate message (the notices package's stillWanted calls it): a reason to cancel, or null. */
export async function estimateStillWanted(row: Pick<OutMessage, "kind" | "shopId" | "refType" | "refId" | "ticketId" | "repairJobId">): Promise<string | null> {
  if (row.kind !== "estimate") return null;
  if (row.refType === "estimate" && row.refId) {
    const link = await db.estimateLink.findFirst({ where: { id: row.refId, shopId: row.shopId } });
    if (!link) return "The estimate link was stopped or replaced"; // not this company's, or gone
    if (link?.answer) return "The customer already answered";
    if (link?.revokedAt) return "The estimate link was stopped or replaced";
    if (link && link.expiresAt.getTime() <= Date.now()) return "The estimate link expired";
  }
  if (row.ticketId) {
    const t = await db.ticket.findFirst({ where: { id: row.ticketId, shopId: row.shopId }, select: { status: true, estimateAnswer: true } });
    if (t && (t.status !== "WAITING_CUSTOMER_OK" || t.estimateAnswer)) return "The ticket isn't waiting for the customer's OK any more";
  }
  if (row.repairJobId) {
    const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId: row.shopId, id: row.repairJobId } }, select: { status: true, approval: true } });
    if (j && (j.status !== "WAITING_CUSTOMER_OK" || j.approval)) return "The repair isn't waiting for the customer's OK any more";
  }
  return null;
}

/** Estimate messages still waiting to go out about a ticket / job are stopped once there is an answer. */
export async function cancelQueuedEstimates(tx: Db, shopId: string, where: { ticketId?: string; repairJobId?: string }, why: string): Promise<void> {
  await tx.outMessage.updateMany({ where: { shopId, kind: "estimate", status: "QUEUED", ...where }, data: { status: "CANCELLED", error: why } });
}

/** The customer's text replies (not STOP-type, not yet marked handled) since `since`, oldest first. */
export async function repliesSince(shopId: string, phone: string | null, since: Date): Promise<InboundText[]> {
  const number = toE164(phone);
  if (!number) return [];
  return db.inboundText.findMany({ where: { shopId, fromNumber: number, keyword: null, handledAt: null, receivedAt: { gte: since } }, orderBy: { receivedAt: "asc" }, take: 20 });
}

// ---------------------------------------------------------------------------------------------------------------------
// What a send is: the subject (ticket or job), the wording, the actions' bodies

export type EstimateSubject = {
  target: "ticket" | "job";
  ticketId?: string;
  repairJobId?: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  machine: string;
  ref: string;
  lines: Line[];
  totalCents: number;
};

/**
 * What an estimate for this ticket / job would show, after the checks that make it possible. UserErrors say what's wrong.
 * (Tickets: direct tickets only, waiting for the customer's OK, with something on the bill.)
 */
export async function estimateSubject(shopId: string, target: "ticket" | "job", id: string): Promise<EstimateSubject> {
  if (target === "ticket") {
    const t = await db.ticket.findFirst({
      where: { id, shopId },
      include: { machine: { select: { brand: true, model: true } }, customer: { select: { id: true, name: true, phone: true } }, lines: { orderBy: { createdAt: "asc" } } },
    });
    if (!t) throw new UserError("Ticket not found.");
    // Direct tickets only (design 10.1, the same test as ticketVars().direct): a dealer or a partner shop tells their own customer.
    const partnerJob = await db.repairJob.findFirst({ where: { shopId, ticketId: t.id, side: "repair" }, select: { id: true } });
    if (partnerJob) throw new UserError("This customer came through another shop; they call their customer.");
    if (t.viaAccountId) throw new UserError("This machine came in through a trade account; they tell their customer.");
    if (t.status !== "WAITING_CUSTOMER_OK") throw new UserError("This ticket isn't waiting for the customer's OK.");
    const bill = ticketEstimateLines(t);
    if (bill.totalCents <= 0) throw new UserError("There's nothing on the bill yet.");
    if (!t.customer) throw new UserError("No customer on this ticket.");
    return {
      target,
      ticketId: t.id,
      customerId: t.customer.id,
      customerName: t.customer.name,
      customerPhone: t.customer.phone,
      machine: t.jobType === "SITE" ? "central vac install" : `${t.machine.brand} ${t.machine.model}`,
      ref: `ticket ${ticketNo(t.number)}`,
      ...bill,
    };
  }
  const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id } }, include: { customer: { select: { id: true, name: true, phone: true } } } });
  if (!j || j.side !== "retail") throw new UserError("Repair not found.");
  if (j.status !== "WAITING_CUSTOMER_OK" || j.approval) throw new UserError("This repair isn't waiting for the customer's OK.");
  const bill = jobEstimateLines(j);
  if (bill.totalCents <= 0) throw new UserError("There's nothing on the bill yet.");
  if (!j.customer) throw new UserError("No customer on this repair.");
  return {
    target,
    repairJobId: j.id,
    customerId: j.customer.id,
    customerName: j.customer.name,
    customerPhone: j.customer.phone,
    machine: `${j.brand} ${j.model}`,
    ref: `tag ${j.tag}`,
    ...bill,
  };
}

const LINES_MARK = "[[estimate_lines]]";
const NOTE_MARK = "[[note_line]]";

/**
 * The estimate's wording for one channel, merged. `link` is the masked link (the worker swaps in the real one when it
 * sends) or null for the "they call or reply" wording. The multi-line fields go in after the merge: the template engine
 * flattens the lines of any field it doesn't trust.
 */
export function estimateContent(ms: { templates: unknown }, shop: { name: string; phone: string | null }, s: EstimateSubject, note: string | null, link: string | null, channel: Channel): Content {
  const vars: Record<string, string> = {
    first_name: firstName(s.customerName),
    name: s.customerName,
    shop_name: shop.name,
    shop_phone: shop.phone ?? "",
    machine: s.machine,
    ref: s.ref,
    total: money(s.totalCents),
    estimate_lines: LINES_MARK,
    note_line: NOTE_MARK,
    ...(link ? { estimate_link: link } : {}),
  };
  const out = renderKind(ms, link ? "estimate" : "estimate_nolink", channel, vars);
  const lines = s.lines.map((l) => `${cleanText(l.description, 160)}  ${money(l.amountCents)}`).join("\n");
  const noteLine = note ? `${note}\n\n` : "";
  const fill = (t: string) => t.split(LINES_MARK).join(lines).split(NOTE_MARK).join(noteLine).replace(/\n{3,}/g, "\n\n");
  return { subject: out.subject, body: fill(out.body) };
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** Why a channel can't be used, in the staff's words ("no mobile number on file"). */
export function skipWords(channel: Channel, reason: SkipReason): string {
  if (reason === "no_address") return channel === "sms" ? "no mobile number on file" : "no email on file";
  if (reason === "channel_off") return channel === "sms" ? "texts aren't set up" : "email isn't set up";
  if (reason === "not_asked") return "not asked if texts are OK";
  return lower(SKIP_REASON_LABEL[reason]);
}

/** Channels this customer can be reached on right now for an estimate: ok with the address, or the reason not. */
export async function estimateChannels(shopId: string, customerId: string, ms: MessagingView): Promise<Record<Channel, { ok: true } | { ok: false; why: string }>> {
  const { customers, sup } = await consentState(db, shopId, [customerId]);
  const c = customers.get(customerId) ?? null;
  const one = (ch: Channel) => {
    const r = allowed(c, ch, "notice", ms, sup);
    return r.ok ? ({ ok: true } as const) : ({ ok: false, why: skipWords(ch, r.reason) } as const);
  };
  return { email: one("email"), sms: one("sms") };
}

/** Estimate sends for this ticket / job so far today (shop time): one send is one dedupe key, however many channels. */
async function sendsToday(shopId: string, where: { ticketId?: string; repairJobId?: string }, tz: string, now: Date): Promise<number> {
  const since = dayStart(ymdOf(now, tz), tz);
  const rows = await db.outMessage.findMany({ where: { shopId, kind: "estimate", createdAt: { gte: since }, ...where }, select: { dedupeKey: true, id: true } });
  return new Set(rows.map((r) => (r.dedupeKey ?? r.id).replace(/:(email|sms)(:skipped)?$/, ""))).size;
}

export type SendEstimateInput = { email: boolean; sms: boolean; note: string | null };

/** Send the customer the estimate (the body of the `sendEstimate` action). Needs Marketing. */
export async function sendEstimateAs(user: CurrentUser, target: "ticket" | "job", id: string, input: SendEstimateInput): Promise<void> {
  const shopId = user.shopId;
  await requireOn(user, "marketing");
  if (target === "ticket") {
    const g = await db.ticket.findFirst({ where: { id, shopId }, select: { intakeAt: true, status: true, machine: { select: { equipment: true } } } });
    if (g) await requireEquipment(user, g.machine.equipment, { ticket: g, closing: true });
  } else if (target !== "job") throw new UserError("Pick a ticket or a repair.");
  const s = await estimateSubject(shopId, target, id);
  const channels: Channel[] = [...(input.email ? (["email"] as const) : []), ...(input.sms ? (["sms"] as const) : [])];
  if (!channels.length) throw new UserError("Pick email, text or both.");
  const rawNote = (input.note ?? "").trim();
  if (rawNote.length > 500) throw new UserError("The note is too long. Keep it under 500 characters.");
  const note = rawNote ? cleanText(rawNote, 500) || null : null;
  const now = new Date();
  const ctx = await hookContext(shopId, user.name);
  const where = s.ticketId ? { ticketId: s.ticketId } : { repairJobId: s.repairJobId };
  if ((await sendsToday(shopId, where, ctx.tz, now)) >= MAX_ESTIMATE_SENDS_PER_DAY) throw new UserError(`You've sent this estimate ${MAX_ESTIMATE_SENDS_PER_DAY} times today. Call them instead.`);
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true } });
  const base = publicBaseUrl();
  await db.$transaction(async (tx) => {
    if (s.ticketId) await tx.ticket.updateMany({ where: { id: s.ticketId, shopId }, data: { estimateAnswer: null, estimateAnsweredAt: null } });
    const link = base
      ? await createEstimateLink(tx, { shopId, ...where, customerId: s.customerId, totalCents: s.totalCents, lines: s.lines, note, days: ctx.ms.estimateLinkDays, byUserId: user.id })
      : null;
    const r = await queueToCustomer(tx, {
      shopId,
      customerId: s.customerId,
      kind: "estimate",
      channels,
      content: (ch) => estimateContent(ctx.ms, shop, s, note, link?.maskedUrl ?? null, ch),
      dedupeKey: `estimate:${link?.id ?? Date.now()}`,
      notAfter: link?.expiresAt ?? new Date(now.getTime() + 7 * DAY),
      refType: "estimate",
      refId: link?.id,
      ...where,
      byUserId: user.id,
      ms: ctx.ms,
    });
    if (!r.queued.length) {
      const why = [...new Set(r.skipped.map((k) => skipWords(k.channel, k.reason)))];
      // Thrown inside the transaction: the new link and the revoking of the old one are rolled back with it.
      throw new UserError(why.length ? `Not sent: ${why.join("; ")}.` : "Not sent.");
    }
  });
  refreshTarget(s);
}

/** The customer told the counter their answer (a text reply, or by phone). Counter work: no module check. */
export async function recordEstimateAnswerAs(user: CurrentUser, target: "ticket" | "job", id: string, input: { answer: string; via: string; note: string | null }): Promise<void> {
  const shopId = user.shopId;
  if (input.answer !== "APPROVED" && input.answer !== "DECLINED") throw new UserError("Approve or decline.");
  const answer = input.answer;
  const via = input.via === "text reply" ? "text reply" : "phone";
  const note = input.note ? cleanText(input.note, 500) || null : null;
  const at = new Date();
  if (target !== "ticket" && target !== "job") throw new UserError("Pick a ticket or a repair.");
  let phone: string | null = null;
  const ids: { ticketId?: string; repairJobId?: string } = {};
  if (target === "ticket") {
    const t = await db.ticket.findFirst({ where: { id, shopId }, include: { lines: true, customer: { select: { phone: true } }, shop: { select: { warrantyDays: true } } } });
    if (!t) throw new UserError("Ticket not found.");
    if (t.status !== "WAITING_CUSTOMER_OK" || t.estimateAnswer) throw new UserError("This ticket isn't waiting for the customer's OK. Reload the page.");
    phone = t.customer?.phone ?? null;
    ids.ticketId = t.id;
    // What they approved: the open link's total (what they were shown), else the bill as it stands now.
    const open = await db.estimateLink.findFirst({ where: { shopId, ticketId: t.id, answer: null, revokedAt: null, expiresAt: { gt: at } }, orderBy: { createdAt: "desc" }, select: { totalCents: true } });
    const approvedCents = answer === "APPROVED" ? (open?.totalCents ?? ticketEstimateLines(t).totalCents) : null;
    const ctx = await hookContext(shopId, user.name);
    await db.$transaction(async (tx) => {
      // Guarded: the customer's link answer or another person's click may have moved it on already.
      const fresh = await tx.ticket.findFirst({ where: { id: t.id, shopId } });
      if (!fresh || fresh.status !== "WAITING_CUSTOMER_OK" || fresh.estimateAnswer) throw new UserError("The answer is already recorded. Reload the page.");
      await answerTicketEstimate(tx, { ticket: fresh, warrantyDays: t.shop.warrantyDays, approval: answer, approvedCents, note, via, at, tz: ctx.tz, ctx });
      await closeOut(tx, shopId, { ticketId: t.id }, phone, at, user, t.estimateAnsweredAt);
    });
  } else {
    const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id } }, include: { customer: { select: { phone: true } } } });
    if (!j || j.side !== "retail") throw new UserError("Repair not found.");
    phone = j.customer?.phone ?? null;
    ids.repairJobId = j.id;
    const approvedCents = answer === "APPROVED" ? j.totalCents : null;
    await db.$transaction(async (tx) => {
      const done = await answerRetailEstimate(tx, { shopId, job: j, approval: answer, approvedCents, note, byName: user.name, via, at });
      if (!done) throw new UserError("The answer is already recorded. Reload the page.");
      await closeOut(tx, shopId, { repairJobId: j.id }, phone, at, user, null);
    });
  }
  refreshTarget(ids);
}

/**
 * After an answer: stop the open links and whatever estimate message is still waiting to go out, and mark the customer's
 * unhandled replies since this round of estimates (the oldest send after the previous answer, if any) as handled.
 */
async function closeOut(tx: Db, shopId: string, where: { ticketId?: string; repairJobId?: string }, phone: string | null, at: Date, user: CurrentUser, previousAnswerAt: Date | null) {
  await tx.estimateLink.updateMany({ where: { shopId, ...where, answer: null, revokedAt: null }, data: { revokedAt: at, tokenSealed: null } });
  await cancelQueuedEstimates(tx, shopId, where, "The customer answered");
  const number = toE164(phone);
  if (!number) return;
  const first = await tx.outMessage.findFirst({ where: { shopId, kind: "estimate", ...where, ...(previousAnswerAt ? { createdAt: { gt: previousAnswerAt } } : {}) }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  if (!first) return;
  await tx.inboundText.updateMany({ where: { shopId, fromNumber: number, keyword: null, handledAt: null, receivedAt: { gte: first.createdAt } }, data: { handledAt: at, handledBy: user.id } });
}

/** Stop an open link ("Stop this link"). Counter work: no module check. */
export async function revokeEstimateLinkAs(user: CurrentUser, linkId: string): Promise<void> {
  const link = await db.estimateLink.findFirst({ where: { id: String(linkId), shopId: user.shopId } });
  if (!link) throw new UserError("Estimate link not found.");
  if (link.answer) throw new UserError("The customer already answered this one. Reload the page.");
  if (!link.revokedAt) await db.estimateLink.updateMany({ where: { id: link.id, shopId: user.shopId, answer: null }, data: { revokedAt: new Date(), tokenSealed: null } });
  refreshTarget(link);
}

/** "Mary Smith's number" shown on a slot: formatted when it is a number we know. */
export const phoneText = (phone: string | null): string | null => {
  const n = toE164(phone);
  return n ? fmtPhone(n) : phone;
};
