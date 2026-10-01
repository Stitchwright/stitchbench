import "server-only";
// Reading what customers text back (STOP, START, HELP, anything else) and how sent texts fared
// (scheduling-messaging-design.md section 4.1, inbound.ts). Reading is never gated: it runs for every shop with Twilio
// set up, whatever the module, switch or pause, because an opt-out must be honoured whether or not anything is sent.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { toE164 } from "@/lib/phone";
import { addDays, ymdOf, zonedTime } from "@/lib/zoned";
import { recordConsent, suppress, unsuppress } from "./consent";
import { queueToAddress } from "./queue";
import type { SendConfig } from "./settings";
import { renderKind } from "./templates";
import { listReplies, messageStatus, type Reply } from "./twilio";

const STOP = /^(stop|stopall|stop all|unsubscribe|cancel|end|quit|optout|opt out|revoke)$/i;
const START = /^(start|unstop)$/i;
const YES = /^yes$/i;
const HELP = /^(help|info)$/i;
const LOOKS_LIKE_STOP = /\b(stop|unsubscribe|opt[\s-]?out|revoke|remove me|don'?t (text|message) me|no more (texts|messages))\b/i;

export const INCOMPLETE_HOLD = "Some text replies couldn't be read yet";
const DAY = 86_400_000;

const ymdUtc = (d: Date) => d.toISOString().slice(0, 10);
const utcDayStart = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

type Tx = Prisma.TransactionClient;

/** The first customer of the shop whose number is this one (phones are stored as typed, so the match is on toE164). */
async function customerWithNumber(tx: Tx, shopId: string, from: string): Promise<string | null> {
  const tail = from.slice(-4);
  if (!/^\d{4}$/.test(tail)) return null;
  const rows = await tx.customer.findMany({ where: { shopId, phone: { contains: tail } }, select: { id: true, phone: true }, orderBy: { createdAt: "asc" }, take: 200 });
  return rows.find((c) => toE164(c.phone) === from)?.id ?? null;
}

/** Stores one reply and acts on its keyword; false when it was already stored. */
async function handleReply(cfg: SendConfig, r: Reply, now: Date): Promise<boolean> {
  const shopId = cfg.shopId;
  const from = toE164(r.from) ?? r.from.trim();
  if (!from) return false;
  const body = r.body.trim();
  return db.$transaction(async (tx) => {
    const seen = await tx.inboundText.findUnique({ where: { shopId_sid: { shopId, sid: r.sid } }, select: { sid: true } });
    if (seen) return false;
    const customerId = await customerWithNumber(tx, shopId, from);
    let keyword: string | null = null;
    let handled = false;
    if (STOP.test(body) || LOOKS_LIKE_STOP.test(body)) {
      keyword = STOP.test(body) ? "STOP" : "STOPLIKE";
      handled = true;
    } else if (START.test(body)) {
      keyword = "START";
      handled = true;
    } else if (YES.test(body)) {
      const s = await tx.suppression.findUnique({ where: { shopId_channel_address: { shopId, channel: "sms", address: from } }, select: { source: true } });
      if (s && (s.source === "reply" || s.source === "carrier")) {
        keyword = "START";
        handled = true;
      }
    } else if (HELP.test(body)) {
      keyword = "HELP";
      handled = true;
    }
    await tx.inboundText.create({
      data: { shopId, sid: r.sid, fromNumber: from, body: r.body.slice(0, 4000), receivedAt: r.receivedAt, customerId, keyword, handledAt: handled ? now : null, handledBy: handled ? "auto" : null },
    });
    if (keyword === "STOP" || keyword === "STOPLIKE") {
      await suppress(tx, { shopId, channel: "sms", address: from, scope: "all", source: "reply", customerId, detail: body.slice(0, 500) });
    } else if (keyword === "START") {
      const s = await tx.suppression.findUnique({ where: { shopId_channel_address: { shopId, channel: "sms", address: from } }, select: { source: true } });
      if (s) await unsuppress(tx, { shopId, channel: "sms", address: from, source: "reply", customerId, detail: body.slice(0, 500) });
    } else if (keyword === "HELP") {
      await recordConsent(tx, { shopId, customerId, channel: "sms", address: from, event: "help", source: "reply", detail: body.slice(0, 500) });
      const content = renderKind(cfg.view, "help_reply", "sms", { shop_name: cfg.shop.name, shop_phone: cfg.shop.phone ?? "" });
      await queueToAddress(tx, { shopId, kind: "help_reply", channel: "sms", address: from, content, dedupeKey: `help:${from}:${ymdOf(now, cfg.shop.timeZone)}`, customerId });
    }
    return true;
  });
}

/**
 * Reads the shop's text replies one UTC day at a time, oldest first, from the watermark's day (minus a day of overlap)
 * up to today. A day read to its last page is acted on and the watermark moves to its end (today: `now`), saved at
 * once; a day cut off by the deadline is left for the next run. Three runs in a row that didn't reach today hold
 * marketing texts (textHoldAt); a run that reaches today lifts that hold. Returns how many new replies were stored.
 */
export async function pollReplies(cfg: SendConfig, now: Date, deadline: number): Promise<number> {
  const shopId = cfg.shopId;
  const v = cfg.view;
  if (!v.twilioSid || !v.twilioFrom || !cfg.twilioToken) return 0;
  const newest = v.inboundAt ? null : await db.inboundText.findFirst({ where: { shopId }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } });
  const watermark = v.inboundAt ?? newest?.receivedAt ?? new Date(now.getTime() - 2 * DAY);
  const today = ymdUtc(now);
  let day = addDays(ymdUtc(watermark), -1);
  if (day > today) day = today;
  let stored = 0;
  let reachedToday = false;
  for (;;) {
    const { replies, complete } = await listReplies(cfg, day, deadline);
    if (!complete) break;
    for (const r of replies) if (await handleReply(cfg, r, now)) stored += 1;
    const isToday = day >= today;
    const inboundAt = isToday ? now : utcDayStart(addDays(day, 1));
    await db.messagingSettings.updateMany({ where: { shopId }, data: { inboundAt } });
    if (isToday) {
      reachedToday = true;
      break;
    }
    day = addDays(day, 1);
    if (Date.now() > deadline) break;
  }
  if (reachedToday) {
    const data: Prisma.MessagingSettingsUpdateManyMutationInput = { inboundIncomplete: 0 };
    if (v.textHoldAt && v.textHoldWhy === INCOMPLETE_HOLD) {
      data.textHoldAt = null;
      data.textHoldWhy = null;
    }
    await db.messagingSettings.updateMany({ where: { shopId }, data });
  } else {
    const n = v.inboundIncomplete + 1;
    const data: Prisma.MessagingSettingsUpdateManyMutationInput = { inboundIncomplete: n };
    if (n >= 3 && !v.textHoldAt) {
      data.textHoldAt = now;
      data.textHoldWhy = INCOMPLETE_HOLD;
    }
    await db.messagingSettings.updateMany({ where: { shopId }, data });
  }
  return stored;
}

/** Twilio's error codes as plain words for the status column. */
export const DELIVERY_WORDS: Record<number, string> = {
  30003: "phone off or unreachable",
  30005: "unknown number",
  30006: "landline or can't receive texts",
  30007: "blocked by the carrier as spam",
  30034: "blocked: the Twilio number isn't registered for business texting",
};

const CARRIER_BLOCK = [DELIVERY_WORDS[30007], DELIVERY_WORDS[30034]];
export const CARRIER_BLOCK_ERROR = "US carriers are blocking your texts. Your Twilio number must be registered for business texting (A2P 10DLC, or toll-free verification).";

const FINAL = ["delivered", "undelivered", "failed"];

/**
 * Asks Twilio how texts sent in the last 48 h fared (oldest first, up to 100 per shop per run) and writes the final
 * word. Five carrier blocks (30007 / 30034) in one shop-day pause texts with the registration message.
 */
export async function pollDelivery(cfg: SendConfig, now: Date): Promise<void> {
  const shopId = cfg.shopId;
  const rows = await db.outMessage.findMany({
    where: { shopId, channel: "sms", status: "SENT", deliveryStatus: null, providerId: { not: null }, sentAt: { gte: new Date(now.getTime() - 48 * 3_600_000) } },
    orderBy: { sentAt: "asc" },
    take: 100,
    select: { id: true, providerId: true },
  });
  for (const r of rows) {
    if (!r.providerId) continue;
    const s = await messageStatus(cfg, r.providerId);
    if (!FINAL.includes(s.status)) continue;
    const words = s.errorCode == null ? null : (DELIVERY_WORDS[s.errorCode] ?? `Twilio error ${s.errorCode}`);
    await db.outMessage.update({ where: { id: r.id }, data: { deliveryStatus: s.status, deliveryError: s.status === "delivered" ? null : words } });
  }
  if (!rows.length) return;
  const dayStart = zonedTime(ymdOf(now, cfg.shop.timeZone), 0, cfg.shop.timeZone);
  const blocks = await db.outMessage.count({ where: { shopId, channel: "sms", deliveryError: { in: CARRIER_BLOCK }, sentAt: { gte: dayStart } } });
  if (blocks >= 5 && !cfg.view.smsPausedAt) {
    await db.messagingSettings.updateMany({ where: { shopId }, data: { smsPausedAt: now, smsPausedUntil: null, smsError: CARRIER_BLOCK_ERROR, smsCheckAt: new Date(now.getTime() + 3_600_000) } });
  }
}
