import "server-only";
// The message worker (scheduling-messaging-design.md section 4.3): one run at a time across every server copy
// (JobLease "messages"), a per-row claim so a message goes once, and every send's outcome written back. A background
// job: it never touches the request cycle (no revalidatePath) and takes its clock from `now`, so checks can inject one.
import type { OutMessage, Prisma } from "@/generated/prisma/client";
import { SKIP_REASON_LABEL } from "@/lib/constants";
import { db } from "@/lib/db";
import { withLease } from "@/lib/lease";
import { shopsWith, shopsWithWorkingBase } from "@/lib/module-gate";
import { isDesktop } from "@/lib/modules";
import { stillWanted } from "@/lib/notices/hooks";
import { runSchedulers } from "@/lib/notices/scheduler";
import { addDays, fmtTime, ymdOf, zonedTime } from "@/lib/zoned";
import { buildCampaigns } from "./campaign-build";
import { allowed, consentState, suppress } from "./consent";
import { isSendError, SendError } from "./errors";
import { pollDelivery, pollReplies } from "./inbound";
import { nextTextTime } from "./quiet";
import { unseal } from "./secrets";
import { publicBaseUrl, sendConfig, type SendConfig } from "./settings";
import { openSmtp, verifySmtp, type SmtpSession } from "./smtp";
import { textToHtml } from "./templates";
import { checkTwilio, findSent, sendText } from "./twilio";
import { BASE_KINDS, EXPLICIT_KINDS, type Channel, type MessageKind, type SkipReason } from "./types";
import { dailySummaries } from "@/lib/owner-today";

export type MessageRunResult = { sent: number; failed: number; waiting: number } | { busy: true } | { off: true };

type G = { __messageRun?: Promise<MessageRunResult> | null; __schedAt?: number; __msgStart?: number };
const g = globalThis as unknown as G;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const LEASE = "messages";
const LEASE_TTL = 5 * MIN;
const CLAIM_MS = 100_000; // stop claiming rows this long after the run started
const SHOP_MS = 20_000; // at most this long per shop
const CHANNELS: Channel[] = ["email", "sms"];

export const OFF_MESSAGE = "Messages are switched off on this server (MESSAGES=off).";
const off = () => process.env.MESSAGES === "off";
const log = (what: string) => (e: unknown) => console.error(`messages ${what}:`, e instanceof Error ? e.message : e);

/** The timer's and the kick's entry: one run per process at a time, under the install-wide lease. */
export function runMessages(): Promise<MessageRunResult> {
  if (off()) return Promise.resolve({ off: true });
  if (g.__messageRun) return g.__messageRun;
  const p = messageRun().finally(() => {
    g.__messageRun = null;
  });
  g.__messageRun = p;
  return p;
}

/** One run under the lease ({ busy } when another copy holds it). Checks pass `now` and their own shopIds. */
export async function messageRun(o: { now?: Date; shopIds?: string[]; forceSchedulers?: boolean } = {}): Promise<MessageRunResult> {
  if (off()) return { off: true };
  const r = await withLease(LEASE, LEASE_TTL, (renew) => run(o, renew));
  return r ?? { busy: true };
}

type Counts = { sent: number; failed: number; waiting: number };
type Renew = () => Promise<boolean>;

async function run(o: { now?: Date; shopIds?: string[]; forceSchedulers?: boolean }, renew: Renew): Promise<MessageRunResult> {
  const now = o.now ?? new Date();
  const claimUntil = Date.now() + CLAIM_MS;
  const counts: Counts = { sent: 0, failed: 0, waiting: 0 };
  // 1-3 run for every shop, module or not.
  await recover(now, o.shopIds);
  await tidy(now, o.shopIds);
  await readReplies(now, o.shopIds);
  // The owner's daily summary at each store's closing time (more than one store, shop-features-round-2-design.md 7.5).
  await dailySummaries(now, o.shopIds).catch(log("daily summaries"));
  // 4. Shops with Marketing on send everything; the others send only the base kinds (ready, parts in, estimates and
  // what texting needs), and their other rows stay QUEUED (held). Campaigns and schedulers need Marketing.
  const live = await shopsWith("marketing", o.shopIds);
  const base = await baseOnlyShops(live, o.shopIds);
  const sending = [...live, ...base];
  if (sending.length) {
    await checkPaused(now, sending);
    if (live.length) {
      await buildCampaigns(now, live).catch(log("campaigns"));
      await schedulers(now, live, !!o.forceSchedulers);
    }
    await sendAll(now, sending, new Set(base), counts, renew, claimUntil);
    if (live.length) await sweepCampaigns(now, live);
    counts.waiting = await db.outMessage.count({ where: { status: "QUEUED", OR: [{ shopId: { in: live } }, { shopId: { in: base }, kind: { in: BASE_KINDS } }] } });
  }
  return counts;
}

/** Working shops without Marketing that have a base-kind row waiting (the rest of their rows stay held). */
async function baseOnlyShops(live: string[], shopIds?: string[]): Promise<string[]> {
  const rows = await db.outMessage.findMany({
    where: { shopId: shopIds ? { in: shopIds, notIn: live } : { notIn: live }, status: "QUEUED", kind: { in: BASE_KINDS } },
    distinct: ["shopId"],
    select: { shopId: true },
  });
  return shopsWithWorkingBase(rows.map((r) => r.shopId));
}

const scopeOf = (shopIds?: string[]) => (shopIds ? { shopId: { in: shopIds } } : {});

/** 1. Rows a dead holder left SENDING: notices once more, marketing and tests never (they may have gone). */
async function recover(now: Date, shopIds?: string[]) {
  const stale = new Date(now.getTime() - 2 * MIN);
  const rows = await db.outMessage.findMany({ where: { ...scopeOf(shopIds), status: "SENDING", claimedAt: { lt: stale } }, select: { id: true, kind: true, purpose: true, retryTries: true } });
  for (const r of rows) {
    const where = { id: r.id, status: "SENDING" };
    if (r.kind === "test") await db.outMessage.updateMany({ where, data: { status: "FAILED", error: "Test interrupted" } });
    else if (r.purpose === "marketing") await db.outMessage.updateMany({ where, data: { status: "FAILED", error: "Interrupted while sending; not sent again in case it went out" } });
    else if (r.retryTries === 0) await db.outMessage.updateMany({ where, data: { status: "QUEUED", retryTries: 1, claimedAt: null, nextTryAt: null, error: "Interrupted; sending once more" } });
    else await db.outMessage.updateMany({ where, data: { status: "FAILED", error: "Interrupted twice; not sent again in case it went out" } });
  }
}

/** 2. Expired rows, pauses that have run out, and estimate tokens nothing waits for any more. */
async function tidy(now: Date, shopIds?: string[]) {
  const scope = scopeOf(shopIds);
  await db.outMessage.updateMany({ where: { ...scope, status: "QUEUED", notAfter: { lt: now } }, data: { status: "EXPIRED", error: "Too late to send" } });
  await db.messagingSettings.updateMany({ where: { ...scope, emailPausedUntil: { lte: now } }, data: { emailPausedAt: null, emailPausedUntil: null, emailCheckAt: null, emailError: null } });
  await db.messagingSettings.updateMany({ where: { ...scope, smsPausedUntil: { lte: now } }, data: { smsPausedAt: null, smsPausedUntil: null, smsCheckAt: null, smsError: null } });
  await db.estimateLink.updateMany({
    where: { ...scope, tokenSealed: { not: null }, OR: [{ answeredAt: { not: null } }, { revokedAt: { not: null } }, { expiresAt: { lt: now } }] },
    data: { tokenSealed: null },
  });
  const links = await db.estimateLink.findMany({ where: { ...scope, tokenSealed: { not: null } }, select: { id: true, shopId: true }, take: 500 });
  for (const l of links) await clearEstimateToken(l.shopId, l.id);
}

/** The raw estimate token is kept only while a message still has to carry it. */
async function clearEstimateToken(shopId: string, linkId: string) {
  const pending = await db.outMessage.count({ where: { shopId, refType: "estimate", refId: linkId, status: { in: ["QUEUED", "SENDING"] } } });
  if (!pending) await db.estimateLink.updateMany({ where: { id: linkId, shopId }, data: { tokenSealed: null } });
}

/** 3. Replies and delivery results for every shop with Twilio set up: reading is not sending, so never gated. */
async function readReplies(now: Date, shopIds?: string[]) {
  const rows = await db.messagingSettings.findMany({
    where: { ...scopeOf(shopIds), twilioSid: { not: null }, twilioFrom: { not: null }, twilioTokenSealed: { not: null } },
    select: { shopId: true, inboundAt: true, textHoldAt: true },
  });
  for (const s of rows) {
    try {
      const campaign = await db.campaign.findFirst({
        where: { shopId: s.shopId, channel: "sms", OR: [{ status: "SENDING" }, { finishedAt: { gte: new Date(now.getTime() - DAY) } }] },
        select: { id: true },
      });
      const every = campaign ? MIN : 5 * MIN;
      if (s.inboundAt && now.getTime() - s.inboundAt.getTime() < every) continue;
      const cfg = await sendConfig(s.shopId);
      if (!cfg.twilioToken) {
        if (!s.textHoldAt) await db.messagingSettings.updateMany({ where: { shopId: s.shopId }, data: { textHoldAt: now, textHoldWhy: "Text replies can't be read: enter the Twilio token again" } });
        continue;
      }
      await pollReplies(cfg, now, Date.now() + 20_000);
      await pollDelivery(cfg, now);
    } catch (e) {
      const msg = isSendError(e) ? e.message : "Couldn't read text replies";
      await db.messagingSettings.updateMany({ where: { shopId: s.shopId }, data: { smsError: msg } }).catch(() => {});
    }
  }
}

/** 5. A paused channel with no end date is tried again every hour. */
async function checkPaused(now: Date, live: string[]) {
  const rows = await db.messagingSettings.findMany({
    where: {
      shopId: { in: live },
      OR: [
        { emailPausedAt: { not: null }, emailPausedUntil: null, emailCheckAt: { lte: now } },
        { smsPausedAt: { not: null }, smsPausedUntil: null, smsCheckAt: { lte: now } },
      ],
    },
    select: { shopId: true, emailPausedAt: true, emailPausedUntil: true, emailCheckAt: true, smsPausedAt: true, smsPausedUntil: true, smsCheckAt: true },
  });
  const later = new Date(now.getTime() + HOUR);
  for (const s of rows) {
    const cfg = await sendConfig(s.shopId);
    const again = `Working again (checked by itself at ${fmtTime(now, cfg.shop.timeZone)})`;
    if (s.emailPausedAt && !s.emailPausedUntil && s.emailCheckAt && s.emailCheckAt <= now) {
      try {
        await verifySmtp(cfg);
        await db.messagingSettings.updateMany({ where: { shopId: s.shopId }, data: { emailPausedAt: null, emailCheckAt: null, emailError: again } });
      } catch {
        await db.messagingSettings.updateMany({ where: { shopId: s.shopId }, data: { emailCheckAt: later } });
      }
    }
    if (s.smsPausedAt && !s.smsPausedUntil && s.smsCheckAt && s.smsCheckAt <= now) {
      const v = cfg.view;
      try {
        if (!v.twilioSid || !cfg.twilioToken) throw new SendError("No Twilio token", "settings");
        await checkTwilio(v.twilioSid, v.twilioKeySid ?? v.twilioSid, cfg.twilioToken);
        await db.messagingSettings.updateMany({ where: { shopId: s.shopId }, data: { smsPausedAt: null, smsCheckAt: null, smsError: again } });
      } catch {
        await db.messagingSettings.updateMany({ where: { shopId: s.shopId }, data: { smsCheckAt: later } });
      }
    }
  }
}

/** 7. The automatic notices' schedulers, at most every 5 minutes unless "Send now" forces them. */
async function schedulers(now: Date, live: string[], force: boolean) {
  if (!force && g.__schedAt && Date.now() - g.__schedAt < 5 * MIN) return;
  g.__schedAt = Date.now();
  for (const shopId of live) await runSchedulers(now, [shopId]).catch(log(`schedulers ${shopId}`));
}

const dueWhere = (now: Date): Prisma.OutMessageWhereInput => ({ status: "QUEUED", sendAfter: { lte: now }, OR: [{ nextTryAt: null }, { nextTryAt: { lte: now } }] });

/** 8. Every sending shop with due rows, starting from a different one each run (`baseOnly`: shops without Marketing). */
async function sendAll(now: Date, live: string[], baseOnly: Set<string>, counts: Counts, renew: Renew, claimUntil: number) {
  const due = await db.outMessage.findMany({ where: { shopId: { in: live }, ...dueWhere(now) }, distinct: ["shopId"], select: { shopId: true } });
  let shops = due.map((d) => d.shopId).sort();
  if (!shops.length) return;
  const start = (g.__msgStart ?? 0) % shops.length;
  g.__msgStart = (g.__msgStart ?? 0) + 1;
  shops = [...shops.slice(start), ...shops.slice(0, start)];
  for (const shopId of shops) {
    if (Date.now() > claimUntil) break;
    await sendForShop(shopId, now, counts, renew, Math.min(Date.now() + SHOP_MS, claimUntil), baseOnly.has(shopId)).catch(log(`send ${shopId}`));
  }
}

/** One shop's turn: its settings, its SMTP session, and what has happened to each channel so far. */
type Turn = {
  shopId: string;
  cfg: SendConfig;
  tz: string;
  now: Date;
  counts: Counts;
  until: number;
  smtp: SmtpSession | null;
  stop: Record<Channel, boolean>;
  /** Marketing is off: only the base kinds go. */
  baseOnly: boolean;
  recipientFails: Record<Channel, number>;
  ok: Record<Channel, boolean>;
};

async function sendForShop(shopId: string, now: Date, counts: Counts, renew: Renew, until: number, baseOnly: boolean) {
  const cfg = await sendConfig(shopId);
  const t: Turn = { shopId, cfg, tz: cfg.shop.timeZone, now, counts, until, smtp: null, stop: { email: false, sms: false }, baseOnly, recipientFails: { email: 0, sms: 0 }, ok: { email: false, sms: false } };
  const batch = Math.max(1, Number(process.env.MESSAGE_BATCH ?? 20) || 20);
  try {
    for (const channel of CHANNELS) {
      // A channel that isn't ready (off, paused, secret unreadable) keeps its rows QUEUED: held, not skipped.
      if (!(channel === "email" ? cfg.view.emailReady : cfg.view.smsReady)) continue;
      const rows = await dueRows(t, channel, batch);
      for (const row of rows) {
        if (t.stop[channel] || Date.now() > t.until) break;
        await sendRow(t, row);
        await renew();
      }
    }
  } finally {
    t.smtp?.close();
    const data: Prisma.MessagingSettingsUpdateManyMutationInput = {};
    if (t.ok.email) Object.assign(data, { emailOkAt: now, emailError: null, emailCheckAt: null });
    if (t.ok.sms) Object.assign(data, { smsOkAt: now, smsError: null, smsCheckAt: null });
    if (Object.keys(data).length) await db.messagingSettings.updateMany({ where: { shopId }, data }).catch(log(`ok ${shopId}`));
  }
}

/** Up to `batch` due rows of a channel: notices first, then marketing (unless held or Marketing is off), oldest sendAfter first. */
async function dueRows(t: Turn, channel: Channel, batch: number): Promise<OutMessage[]> {
  const v = t.cfg.view;
  const base: Prisma.OutMessageWhereInput = { shopId: t.shopId, channel, ...dueWhere(t.now) };
  const notices = await db.outMessage.findMany({ where: { ...base, purpose: "notice", ...(t.baseOnly ? { kind: { in: BASE_KINDS } } : {}) }, orderBy: { sendAfter: "asc" }, take: batch });
  const room = batch - notices.length;
  if (t.baseOnly || room <= 0 || v.marketingHoldAt || (channel === "sms" && v.textHoldAt)) return notices;
  // Marketing older than 48 h waits for a person ("Send them" / "Cancel them").
  const marketing = await db.outMessage.findMany({
    where: { ...base, purpose: "marketing", sendAfter: { lte: t.now, gte: new Date(t.now.getTime() - 48 * HOUR) } },
    orderBy: { sendAfter: "asc" },
    take: room,
  });
  return [...notices, ...marketing];
}

const skipped = (reason: SkipReason) => ({ status: "SKIPPED", error: SKIP_REASON_LABEL[reason] });

/** Ends a row's journey from the status it is in now (QUEUED before the claim, SENDING after). */
async function finish(t: Turn, row: OutMessage, from: "QUEUED" | "SENDING", data: { status: string; error: string | null }) {
  await db.outMessage.updateMany({ where: { id: row.id, status: from }, data: { ...data, claimedAt: null } });
  t.counts.failed += 1;
}

async function defer(row: OutMessage, at: Date) {
  await db.outMessage.updateMany({ where: { id: row.id, status: "QUEUED" }, data: { sendAfter: at } });
}

/** The unsubscribe headers of a marketing email (design 3.3): link first on the hosted app, mailto first on the Windows program. */
function emailHeaders(t: Turn, row: OutMessage, marketing: boolean): Record<string, string> {
  if (!marketing || !row.optOutToken) return {};
  const v = t.cfg.view;
  const replyTo = v.replyTo ?? v.fromEmail ?? "";
  const base = publicBaseUrl();
  const url = base ? `${base}/api/u/${row.optOutToken}` : null;
  const mailto = `mailto:${replyTo}?subject=${encodeURIComponent(`unsubscribe ${row.optOutToken}`)}`;
  if (!isDesktop() && url) return { "List-Unsubscribe": `<${url}>, <${mailto}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  return { "List-Unsubscribe": url ? `<${mailto}>, <${url}>` : `<${mailto}>` };
}

async function smtpFor(t: Turn): Promise<SmtpSession> {
  if (!t.smtp) t.smtp = await openSmtp(t.cfg);
  return t.smtp;
}

async function sendRow(t: Turn, row: OutMessage) {
  const { shopId, now, cfg } = t;
  const v = cfg.view;
  const channel = row.channel as Channel;
  const kind = row.kind as MessageKind;
  const marketing = row.purpose === "marketing";

  // 8.1 Still wanted?
  const why = await stillWanted(row);
  if (why) return finish(t, row, "QUEUED", { status: "CANCELLED", error: why.slice(0, 500) });

  // 8.2 Consent, with the customer's record as it is now.
  const explicit = !row.customerId || EXPLICIT_KINDS.includes(kind);
  const { customers, sup } = await consentState(db, shopId, explicit || !row.customerId ? [] : [row.customerId]);
  const c = explicit || !row.customerId ? null : (customers.get(row.customerId) ?? null);
  if (!explicit && !c) return finish(t, row, "QUEUED", skipped("no_address"));
  const ok = allowed(c, channel, marketing ? "marketing" : "notice", v, sup, explicit ? row.address : undefined);
  if (!ok.ok) return finish(t, row, "QUEUED", skipped(ok.reason));
  if (ok.address !== row.address) return finish(t, row, "QUEUED", skipped("changed"));

  // 8.3 Marketing texts: an unread reply holds them; one per number per 24 h; four per 30 days.
  if (marketing && channel === "sms") {
    const unread = await db.inboundText.findFirst({ where: { shopId, fromNumber: row.address, keyword: null, handledAt: null }, select: { sid: true } });
    if (unread) return finish(t, row, "QUEUED", skipped("unread_reply"));
    const dayAgo = new Date(now.getTime() - DAY);
    const recent = await db.outMessage.findFirst({
      where: {
        shopId,
        channel: "sms",
        purpose: "marketing",
        address: row.address,
        id: { not: row.id },
        OR: [
          { status: "SENT", sentAt: { gte: dayAgo } },
          { status: "SENDING", claimedAt: { gte: dayAgo } },
        ],
      },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true, claimedAt: true },
    });
    if (recent) return defer(row, new Date((recent.sentAt ?? recent.claimedAt ?? now).getTime() + DAY));
    const monthAgo = new Date(now.getTime() - 30 * DAY);
    const n = await db.outMessage.count({
      where: {
        shopId,
        channel: "sms",
        purpose: "marketing",
        address: row.address,
        id: { not: row.id },
        OR: [
          { status: "SENT", sentAt: { gte: monthAgo } },
          { status: "SENDING", claimedAt: { gte: monthAgo } },
        ],
      },
    });
    if (n >= 4) return finish(t, row, "QUEUED", skipped("too_often"));
  }

  // 8.4 Quiet hours (every text).
  if (channel === "sms") {
    const at = nextTextTime(now, t.tz, { quietStart: v.quietStart, quietEnd: v.quietEnd, noSundayMarketing: v.noSundayMarketing }, marketing, row.address);
    if (at.getTime() > now.getTime()) return defer(row, at);
  }

  // 8.5 Marketing daily caps: at the cap, every due marketing row of the channel moves to the next shop-day. Online-order
  // mail counts too when Settings -> Online shop says so (online-and-parts-design.md section 3).
  const capped: Prisma.OutMessageWhereInput = v.ordersInCap ? { OR: [{ purpose: "marketing" }, { kind: { in: ["order_notice", "pay_link"] } }] } : { purpose: "marketing" };
  if (marketing || (v.ordersInCap && (kind === "order_notice" || kind === "pay_link"))) {
    const dayStart = zonedTime(ymdOf(now, t.tz), 0, t.tz);
    const cap = channel === "email" ? v.emailDailyCap : v.smsDailyCap;
    const n = await db.outMessage.count({
      where: {
        shopId,
        channel,
        AND: [
          capped,
          {
            OR: [
              { status: "SENT", sentAt: { gte: dayStart } },
              { status: "SENDING", claimedAt: { gte: dayStart } },
            ],
          },
        ],
      },
    });
    if (n >= cap) {
      const next = zonedTime(addDays(ymdOf(now, t.tz), 1), v.quietStart, t.tz);
      // AND, not a spread: dueWhere has an OR of its own and would otherwise replace the capped filter and defer every due row.
      await db.outMessage.updateMany({ where: { shopId, channel, AND: [capped, dueWhere(now)] }, data: { sendAfter: next } });
      // Marketing rows sort after every notice, so stopping the channel here loses nothing. An order message sits among
      // the other notices (it is one), so only it steps aside: the repair-ready and reminder rows behind it still go.
      if (marketing) t.stop[channel] = true;
      return;
    }
  }

  // 8.6 Claim it (another copy may have it already).
  const claimed = await db.outMessage.updateMany({ where: { id: row.id, status: "QUEUED" }, data: { status: "SENDING", claimedAt: now, tries: { increment: 1 } } });
  if (!claimed.count) return;
  const tries = row.tries + 1;

  // 8.7 Estimate links: the real token goes in for sending only; the stored body keeps the mask.
  let body = row.body;
  if (row.refType === "estimate" && row.refId) {
    const link = await db.estimateLink.findFirst({ where: { id: row.refId, shopId }, select: { id: true, tokenSealed: true, maskedUrl: true } });
    const token = link?.tokenSealed ? unseal(link.tokenSealed, shopId, `estimateToken:${link.id}`) : null;
    const base = publicBaseUrl();
    if (!link || !token || !base) return finish(t, row, "SENDING", { status: "FAILED", error: "The link can't be sent any more; send the estimate again" });
    body = body.split(link.maskedUrl).join(`${base}/e/${token.plain}`);
  }

  // 8.8 Send.
  try {
    let providerId: string;
    if (channel === "email") {
      const s = await smtpFor(t);
      const r = await s.send({ to: row.address, toName: null, subject: row.subject ?? "", text: body, html: textToHtml(body), headers: emailHeaders(t, row, marketing) });
      providerId = r.id;
    } else {
      try {
        providerId = (await sendText(cfg, row.address, body)).id;
      } catch (e) {
        if (!(isSendError(e) && e.kind === "ambiguous")) throw e;
        // Twilio may have taken it: look before sending twice (the clock may be injected, so the earlier of the two).
        const since = new Date(Math.min(now.getTime(), Date.now()));
        const sid = await findSent(cfg, row.address, body, since).catch(() => null);
        if (!sid) throw e;
        providerId = sid;
      }
    }
    // 8.9 Sent.
    await db.outMessage.updateMany({ where: { id: row.id, status: "SENDING" }, data: { status: "SENT", sentAt: now, providerId, error: null, nextTryAt: null } });
    t.counts.sent += 1;
    t.ok[channel] = true;
    t.recipientFails[channel] = 0;
    if (row.refType === "estimate" && row.refId) await clearEstimateToken(shopId, row.refId);
  } catch (e) {
    const err = isSendError(e) ? e : new SendError(`Couldn't send: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`, "retry");
    await onSendError(t, row, channel, marketing, err, tries);
  }
}

const backoff = (now: Date, exp: number, capMs: number) => new Date(now.getTime() + Math.min(capMs, 30_000 * 2 ** Math.min(exp, 5)));

/** 8.9 A failed send, by kind (design 4.3). */
async function onSendError(t: Turn, row: OutMessage, channel: Channel, marketing: boolean, err: SendError, tries: number) {
  const { shopId, now, tz } = t;
  const sending = { id: row.id, status: "SENDING" };
  const message = err.message.slice(0, 500);
  switch (err.kind) {
    case "offline": {
      // Nothing fails for the internet being down: back in the queue with a short backoff, the channel waits.
      await db.outMessage.updateMany({ where: sending, data: { status: "QUEUED", claimedAt: null, nextTryAt: backoff(now, tries, 10 * MIN), error: message } });
      await channelOffline(t, channel);
      t.stop[channel] = true;
      return;
    }
    case "retry": {
      const retryTries = row.retryTries + 1;
      if (retryTries >= 8) {
        await db.outMessage.updateMany({ where: sending, data: { status: "FAILED", claimedAt: null, retryTries, error: message } });
        t.counts.failed += 1;
      } else {
        await db.outMessage.updateMany({ where: sending, data: { status: "QUEUED", claimedAt: null, retryTries, nextTryAt: backoff(now, retryTries, 30 * MIN), error: message } });
      }
      t.stop[channel] = true;
      return;
    }
    case "recipient": {
      await db.outMessage.updateMany({ where: sending, data: { status: "FAILED", claimedAt: null, error: message } });
      t.counts.failed += 1;
      if (channel === "sms" && err.code === "21610") {
        await suppress(db, {
          shopId,
          channel: "sms",
          address: row.address,
          scope: "all",
          source: "carrier",
          customerId: row.customerId,
          detail: "Twilio 21610: the number has opted out of texts from this number",
        });
      }
      t.recipientFails[channel] += 1;
      if (t.recipientFails[channel] >= 3)
        await pauseChannel(t, channel, `${channel === "email" ? "The mail server" : "Twilio"} is refusing messages: ${message}`, new Date(now.getTime() + HOUR), null);
      return;
    }
    case "settings": {
      await db.outMessage.updateMany({ where: sending, data: { status: "QUEUED", claimedAt: null, error: message } });
      await pauseChannel(t, channel, message, new Date(now.getTime() + HOUR), null);
      return;
    }
    case "quota": {
      await db.outMessage.updateMany({ where: sending, data: { status: "QUEUED", claimedAt: null, error: message } });
      const until = zonedTime(addDays(ymdOf(now, tz), 1), 8 * 60, tz);
      await pauseChannel(t, channel, message, null, until);
      return;
    }
    case "ambiguous": {
      if (channel === "email") {
        // The connection is in an unknown state: the next email gets a fresh session.
        t.smtp?.close();
        t.smtp = null;
      }
      if (marketing || row.retryTries >= 1) {
        await db.outMessage.updateMany({ where: sending, data: { status: "FAILED", claimedAt: null, error: "May have gone out; not sent again" } });
        t.counts.failed += 1;
      } else {
        await db.outMessage.updateMany({
          where: sending,
          data: { status: "QUEUED", claimedAt: null, retryTries: row.retryTries + 1, nextTryAt: new Date(now.getTime() + 30_000), error: "May have gone out; sending once more" },
        });
      }
      return;
    }
  }
}

/**
 * The channel can't be reached: the status line says since when. Under hosted rules `*CheckAt` marks when a day of this
 * is up; then it isn't the internet but the settings, and the channel pauses (an hourly re-check from there).
 */
async function channelOffline(t: Turn, channel: Channel) {
  const { shopId, now, tz, cfg } = t;
  const v = cfg.view;
  const current = channel === "email" ? v.emailError : v.smsError;
  const checkAt = channel === "email" ? v.emailCheckAt : v.smsCheckAt;
  const target = channel === "email" ? (v.smtpHost ?? "the mail server") : "Twilio";
  const hosted = !isDesktop();
  if (hosted && checkAt && checkAt.getTime() <= now.getTime()) {
    const why =
      channel === "email"
        ? `Can't reach ${target} for a day. Check the server name and port; some hosts block outgoing mail (see INSTALL.md).`
        : "Can't reach Twilio for a day. Check this server's internet connection.";
    await pauseChannel(t, channel, why, new Date(now.getTime() + HOUR), null);
    return;
  }
  const text = current && current.startsWith("Can't reach") ? current : `Can't reach ${target} since ${fmtTime(now, tz)}`;
  const data: Prisma.MessagingSettingsUpdateManyMutationInput = channel === "email" ? { emailError: text } : { smsError: text };
  if (hosted && !checkAt) Object.assign(data, channel === "email" ? { emailCheckAt: new Date(now.getTime() + DAY) } : { smsCheckAt: new Date(now.getTime() + DAY) });
  await db.messagingSettings.updateMany({ where: { shopId }, data });
  t.ok[channel] = false;
}

/** Pauses a channel: with `until` it resumes by itself (a quota), else the hourly check at `checkAt` decides. */
async function pauseChannel(t: Turn, channel: Channel, message: string, checkAt: Date | null, until: Date | null) {
  const data: Prisma.MessagingSettingsUpdateManyMutationInput =
    channel === "email"
      ? { emailPausedAt: t.now, emailPausedUntil: until, emailCheckAt: checkAt, emailError: message }
      : { smsPausedAt: t.now, smsPausedUntil: until, smsCheckAt: checkAt, smsError: message };
  await db.messagingSettings.updateMany({ where: { shopId: t.shopId }, data });
  t.ok[channel] = false;
  t.stop[channel] = true;
}

/** 9. Campaigns whose members are all built and whose messages have all gone are finished. */
async function sweepCampaigns(now: Date, live: string[]) {
  const rows = await db.campaign.findMany({ where: { shopId: { in: live }, status: "SENDING" }, select: { id: true, shopId: true, members: true, built: true } });
  for (const c of rows) {
    const total = Array.isArray(c.members) ? c.members.length : 0;
    if (c.built < total) continue;
    const pending = await db.outMessage.count({ where: { shopId: c.shopId, campaignId: c.id, status: { in: ["QUEUED", "SENDING"] } } });
    if (!pending) await db.campaign.updateMany({ where: { id: c.id, shopId: c.shopId, status: "SENDING" }, data: { status: "SENT", finishedAt: now } });
  }
}

/** A test message the admin just queued as SENDING: sent at once, on its own connection, outside the run. */
export async function sendOneNow(id: string): Promise<{ ok: true; detail: string } | { error: string }> {
  if (off()) return { error: OFF_MESSAGE };
  const row = await db.outMessage.findUnique({ where: { id } });
  if (!row || row.kind !== "test" || row.status !== "SENDING") return { error: "That test message isn't waiting to be sent." };
  const cfg = await sendConfig(row.shopId);
  const now = new Date();
  try {
    let providerId: string;
    if (row.channel === "email") {
      const s = await openSmtp(cfg);
      try {
        providerId = (await s.send({ to: row.address, subject: row.subject ?? "Test message", text: row.body, html: textToHtml(row.body), headers: {} })).id;
      } finally {
        s.close();
      }
    } else {
      providerId = (await sendText(cfg, row.address, row.body)).id;
    }
    await db.outMessage.updateMany({ where: { id: row.id, status: "SENDING" }, data: { status: "SENT", sentAt: now, providerId, error: null } });
    await db.messagingSettings.updateMany({ where: { shopId: row.shopId }, data: row.channel === "email" ? { emailOkAt: now } : { smsOkAt: now } });
    return { ok: true, detail: `Sent to ${row.address}.` };
  } catch (e) {
    const msg = isSendError(e) ? e.message : "The message couldn't be sent.";
    await db.outMessage.updateMany({ where: { id: row.id, status: "SENDING" }, data: { status: "FAILED", error: msg.slice(0, 500) } });
    return { error: msg };
  }
}
