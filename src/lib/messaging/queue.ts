import "server-only";
// The only way anything creates OutMessage rows (scheduling-messaging-design.md section 4.1, queue.ts).
import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { isDesktop } from "@/lib/modules";
import { allowed, consentState, type SupMap } from "./consent";
import { kickMessages } from "./kick";
import { messagingView, publicBaseUrl, type MessagingView } from "./settings";
import { cleanSubject, cleanText as cleanValue } from "./templates";
import { EXPLICIT_KINDS, KIND_PURPOSE, STOP_LINE_KINDS, type Channel, type ChannelMode, type MessageKind, type SkipReason } from "./types";

type Db = Prisma.TransactionClient | typeof db;
export type Content = { subject?: string | null; body: string };
export type Target = {
  ticketId?: string | null;
  repairJobId?: string | null;
  campaignId?: string | null;
  refType?: string | null;
  refId?: string | null;
  byUserId?: string | null;
  sendAfter?: Date;
  notAfter?: Date | null;
};

export { cleanValue as cleanText };

const STAFF_CAP = 3;

/** Which channels a mode means for a customer. */
function channelsFor(mode: ChannelMode, notifyBy: string): Channel[] {
  if (Array.isArray(mode)) return mode;
  if (mode === "every") return ["email", "sms"];
  if (mode === "preferred") {
    if (notifyBy === "sms") return ["sms"];
    if (notifyBy === "both") return ["email", "sms"];
    if (notifyBy === "none") return [];
    return ["email"];
  }
  // "one": text if allowed and preferred, else email (the caller's allowed() check decides below).
  return notifyBy === "sms" || notifyBy === "both" ? ["sms", "email"] : ["email"];
}

/** A random unsubscribe token (22 chars), the public link when there is one, and the mailto. */
export function unsubscribeParts(shopId: string, replyTo: string): { token: string; url: string | null; mailto: string } {
  void shopId;
  const token = crypto.randomBytes(16).toString("base64url");
  const base = publicBaseUrl();
  return { token, url: base ? `${base}/u/${token}` : null, mailto: `mailto:${replyTo}?subject=${encodeURIComponent(`unsubscribe ${token}`)}` };
}

/**
 * The prefix and footer every message gets (design section 5): texts start with the shop's name and marketing (and
 * staff-typed notices) end with the STOP line; notice emails get a signature; marketing emails the advertisement and
 * postal footer and how to unsubscribe (link first on the hosted app, reply first on the Windows program).
 */
export function finalize(channel: Channel, kind: MessageKind, body: string, ctx: { shopName: string; shopPhone: string | null; postal: string | null; unsubscribeUrl: string | null; replyWord: boolean }): string {
  const marketing = KIND_PURPOSE[kind] === "marketing";
  if (channel === "sms") {
    let text = body.trim();
    if (!text.toLowerCase().startsWith(ctx.shopName.toLowerCase())) text = `${ctx.shopName}: ${text}`;
    if ((marketing || STOP_LINE_KINDS.includes(kind)) && !/reply stop to opt out\.?$/i.test(text)) text = `${text} Reply STOP to opt out.`;
    return text;
  }
  if (!marketing) return `${body.trim()}\n\n${ctx.shopName}${ctx.shopPhone ? ` · ${ctx.shopPhone}` : ""}`;
  const lines = [`${body.trim()}`, "", "--", `This is an advertisement from ${ctx.shopName}${ctx.postal ? `, ${ctx.postal}` : ""}.`];
  // Hosted: the link is the mechanism (one click), the reply a second way. Windows program: the PC may be off, so the
  // reply is the mechanism and a link only an extra when the install has a public address.
  if (!isDesktop() && ctx.unsubscribeUrl) lines.push(`To stop getting these emails: ${ctx.unsubscribeUrl}`, ...(ctx.replyWord ? ["Or reply with the word UNSUBSCRIBE."] : []));
  else lines.push(`To stop getting these emails, reply to this email with the word UNSUBSCRIBE.${ctx.unsubscribeUrl ? ` Or use ${ctx.unsubscribeUrl}` : ""}`);
  return lines.join("\n");
}

async function shopCtx(tx: Db, shopId: string, ms: MessagingView) {
  const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true, address: true } });
  return { shopName: shop.name, shopPhone: shop.phone, postal: ms.postalAddress ?? shop.address, replyTo: ms.replyTo ?? ms.fromEmail };
}

/** Messages this person's staff triggered to an address in the last 24 h (the 3-a-day cap). */
async function staffSentToday(tx: Db, shopId: string, address: string) {
  const since = new Date(Date.now() - 86_400_000);
  return tx.outMessage.count({ where: { shopId, address, byUserId: { not: null }, createdAt: { gte: since }, status: { in: ["QUEUED", "SENDING", "SENT"] } } });
}

type Row = Prisma.OutMessageCreateManyInput;

async function insert(tx: Db, row: Row): Promise<boolean> {
  const r = await tx.outMessage.createMany({ data: [row], skipDuplicates: true });
  return r.count > 0;
}

/** Queue a kind to a customer on the channels the mode allows. Consent is checked here and again by the worker. */
export async function queueToCustomer(
  tx: Db,
  a: Target & {
    shopId: string;
    customerId: string;
    kind: MessageKind;
    channels: ChannelMode;
    content: (channel: Channel) => Content;
    dedupeKey?: string | null;
    recordSkipped?: boolean;
    staffCap?: boolean;
    ms?: MessagingView;
  },
): Promise<{ queued: { channel: Channel; address: string; sendAfter: Date }[]; skipped: { channel: Channel; reason: SkipReason }[]; duplicate: Channel[] }> {
  const purpose = KIND_PURPOSE[a.kind];
  const ms = a.ms ?? (await messagingView(a.shopId, tx));
  const { customers, sup } = await consentState(tx, a.shopId, [a.customerId]);
  const c = customers.get(a.customerId) ?? null;
  const out = { queued: [] as { channel: Channel; address: string; sendAfter: Date }[], skipped: [] as { channel: Channel; reason: SkipReason }[], duplicate: [] as Channel[] };
  if (!c) {
    out.skipped.push({ channel: "email", reason: "no_address" });
    return out;
  }
  const recordSkipped = a.recordSkipped ?? purpose === "notice";
  const staffCap = a.staffCap ?? !!a.byUserId;
  const ctx = await shopCtx(tx, a.shopId, ms);
  const sendAfter = a.sendAfter ?? new Date();
  const one = a.channels === "one";
  for (const channel of channelsFor(a.channels, c.notifyBy)) {
    // "one": the first channel that goes through is the only one.
    if (one && (out.queued.length || out.duplicate.length)) break;
    const ok = allowed(c, channel, purpose, ms, sup);
    if (!ok.ok) {
      out.skipped.push({ channel, reason: ok.reason });
      if (recordSkipped && a.dedupeKey) {
        await insert(tx, baseRow(a, channel, purpose, c.email ?? c.phone ?? "", a.content(channel), sendAfter, { status: "SKIPPED", error: ok.reason, dedupeKey: `${a.dedupeKey}:${channel}:skipped` }));
      }
      continue;
    }
    if (staffCap && (await staffSentToday(tx, a.shopId, ok.address)) >= STAFF_CAP) {
      out.skipped.push({ channel, reason: "staff_cap" });
      continue;
    }
    const content = a.content(channel);
    const unsub = channel === "email" && purpose === "marketing" ? unsubscribeParts(a.shopId, ctx.replyTo ?? "") : null;
    if (purpose === "marketing" && channel === "email" && !ctx.postal) throw new UserError("Add the shop's postal address in Settings -> Messages. Marketing email must show it.");
    const body = finalize(channel, a.kind, content.body, { shopName: ctx.shopName, shopPhone: ctx.shopPhone, postal: ctx.postal, unsubscribeUrl: unsub?.url ?? null, replyWord: true });
    const row = baseRow(a, channel, purpose, ok.address, { subject: content.subject, body }, sendAfter, { dedupeKey: a.dedupeKey ? `${a.dedupeKey}:${channel}` : null, optOutToken: unsub?.token ?? null });
    if (await insert(tx, { id: newId(), ...row })) out.queued.push({ channel, address: ok.address, sendAfter });
    else out.duplicate.push(channel);
  }
  if (out.queued.length) kickMessages();
  return out;
}

function baseRow(a: Target & { shopId: string; customerId?: string | null; kind: MessageKind }, channel: Channel, purpose: string, address: string, content: Content, sendAfter: Date, extra: Partial<Row>): Row {
  return {
    shopId: a.shopId,
    channel,
    purpose,
    kind: a.kind,
    customerId: a.customerId ?? null,
    address,
    subject: channel === "email" ? cleanSubject(content.subject ?? "") || null : null,
    body: content.body,
    sendAfter,
    notAfter: a.notAfter ?? null,
    ticketId: a.ticketId ?? null,
    repairJobId: a.repairJobId ?? null,
    campaignId: a.campaignId ?? null,
    refType: a.refType ?? null,
    refId: a.refId ?? null,
    byUserId: a.byUserId ?? null,
    ...extra,
  };
}

/**
 * Queue to an explicit address (EXPLICIT_KINDS: confirmations, HELP, tests): only suppression is checked; customerId is
 * stored for the record. status "SENDING" (with claimedAt now) is how test sends are inserted: the worker never picks them up.
 */
export async function queueToAddress(
  tx: Db,
  a: Target & { shopId: string; kind: MessageKind; channel: Channel; address: string; content: Content; dedupeKey?: string | null; status?: "QUEUED" | "SENDING"; customerId?: string | null },
): Promise<{ id: string | null; reason?: SkipReason }> {
  const purpose = KIND_PURPOSE[a.kind];
  const ms = await messagingView(a.shopId, tx);
  const { sup } = await consentState(tx, a.shopId, []);
  const ok = allowed(null, a.channel, purpose, ms, sup, a.address);
  if (!ok.ok && !(a.kind === "test" && ok.reason === "channel_off")) return { id: null, reason: ok.reason };
  const ctx = await shopCtx(tx, a.shopId, ms);
  const body = finalize(a.channel, a.kind, a.content.body, { shopName: ctx.shopName, shopPhone: ctx.shopPhone, postal: ctx.postal, unsubscribeUrl: null, replyWord: true });
  const id = newId();
  const status = a.status ?? "QUEUED";
  const row = baseRow({ ...a, kind: a.kind }, a.channel, purpose, a.address, { subject: a.content.subject, body }, a.sendAfter ?? new Date(), {
    id,
    dedupeKey: a.dedupeKey ?? null,
    status,
    ...(status === "SENDING" ? { claimedAt: new Date(), tries: 1 } : {}),
  });
  if (!(await insert(tx, row))) return { id: null, reason: "not_wanted" };
  if (status === "QUEUED") kickMessages();
  return { id };
}

/** A row id the shape Prisma makes (createMany returns none, and callers need it). */
function newId() {
  return `c${crypto.randomBytes(12).toString("hex")}`;
}

export const isExplicitKind = (k: MessageKind) => EXPLICIT_KINDS.includes(k);
export type { SupMap };
