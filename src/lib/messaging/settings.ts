import "server-only";
// A company's message settings as pages and the worker see them (scheduling-messaging-design.md sections 4.1, 4.2).
// The page view never carries a secret; only sendConfig() (the worker and test sends) opens them.
import crypto from "node:crypto";
import type { MessagingSettings, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isDesktop } from "@/lib/modules";
import { seal, unseal } from "./secrets";

export type MessagingView = Omit<MessagingSettings, "smtpPassSealed" | "twilioTokenSealed" | "testCodeHash"> & {
  hasSmtpPass: boolean;
  hasTwilioToken: boolean;
  secretsUnreadable: boolean;
  /** emailOn && host && fromEmail && a readable password (hosted rules: user and pass required) && not paused */
  emailReady: boolean;
  /** smsOn && twilioSid && a readable token && twilioFrom && tzConfirmedAt && not paused */
  smsReady: boolean;
  /** PUBLIC_URL (env only), no trailing slash */
  publicUrl: string | null;
  /** replyTo set and an admin said someone reads it weekly */
  replyWatched: boolean;
};

export const MESSAGING_DEFAULTS: Omit<MessagingSettings, "shopId" | "updatedAt"> = {
  emailOn: false,
  smtpPreset: null,
  smtpHost: null,
  smtpPort: 587,
  smtpSecurity: "starttls",
  smtpUser: null,
  smtpPassSealed: null,
  smtpPassSavedAt: null,
  fromName: null,
  fromEmail: null,
  replyTo: null,
  replyWatchedAt: null,
  replyWatchedBy: null,
  emailDailyCap: 300,
  smsOn: false,
  twilioSid: null,
  twilioKeySid: null,
  twilioTokenSealed: null,
  twilioTokenSavedAt: null,
  twilioFrom: null,
  smsDailyCap: 300,
  smsPartMills: 11,
  testPhones: [],
  testPhonePending: null,
  testCodeHash: null,
  testCodeUntil: null,
  inboundAt: null,
  inboundIncomplete: 0,
  emailOkAt: null,
  emailError: null,
  emailPausedAt: null,
  emailPausedUntil: null,
  emailCheckAt: null,
  smsOkAt: null,
  smsError: null,
  smsPausedAt: null,
  smsPausedUntil: null,
  smsCheckAt: null,
  marketingHoldAt: null,
  textHoldAt: null,
  textHoldWhy: null,
  postalAddress: null,
  tzConfirmedAt: null,
  tzConfirmedBy: null,
  quietStart: 540,
  quietEnd: 1200,
  noSundayMarketing: true,
  smsConsentText: null,
  consentTexts: [],
  readyNotice: true,
  reminders: true,
  reminderHour: 10,
  abandonNotices: false,
  abandonDays: [7, 30],
  finalNoticeDays: 7,
  serviceDue: false,
  serviceDueMonths: 12,
  serviceDueSince: null,
  serviceDueDay: null,
  reviewRequest: false,
  reviewUrl: null,
  reviewDelayHours: 24,
  reviewEveryDays: 180,
  reviewAfterSales: false,
  estimateLinkDays: 7,
  templates: {},
};

type Db = Prisma.TransactionClient | typeof db;

/** PUBLIC_URL, validated: https, or http for localhost / 127.0.0.1 (tests); no trailing slash. */
export function publicBaseUrl(): string | null {
  const raw = process.env.PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.pathname !== "/" && u.pathname !== "") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The row with defaults for anything missing, secrets replaced by "has one" flags and readiness worked out. */
function toView(shopId: string, row: MessagingSettings | null): MessagingView {
  const r: MessagingSettings = row ?? { shopId, updatedAt: new Date(0), ...MESSAGING_DEFAULTS };
  const { smtpPassSealed, twilioTokenSealed, testCodeHash, ...rest } = r;
  void testCodeHash;
  const pass = unseal(smtpPassSealed, shopId, "smtpPass");
  const token = unseal(twilioTokenSealed, shopId, "twilioToken");
  const passUnreadable = !!smtpPassSealed && !pass;
  const tokenUnreadable = !!twilioTokenSealed && !token;
  const hosted = !isDesktop();
  const emailReady = r.emailOn && !!r.smtpHost && !!r.fromEmail && (!hosted || !!r.smtpUser) && (!!pass || (!hosted && !r.smtpUser)) && !passUnreadable && !r.emailPausedAt;
  const smsReady = r.smsOn && !!r.twilioSid && !!token && !!r.twilioFrom && !!r.tzConfirmedAt && !r.smsPausedAt;
  return {
    ...rest,
    hasSmtpPass: !!smtpPassSealed,
    hasTwilioToken: !!twilioTokenSealed,
    secretsUnreadable: passUnreadable || tokenUnreadable,
    emailReady,
    smsReady,
    publicUrl: publicBaseUrl(),
    replyWatched: !!r.replyTo && !!r.replyWatchedAt,
  };
}

/** The company's settings, or the defaults when it has none; never secrets. */
export async function messagingView(shopId: string, tx: Db = db): Promise<MessagingView> {
  const row = await tx.messagingSettings.findUnique({ where: { shopId } });
  return toView(shopId, row);
}

export type SendConfig = {
  shopId: string;
  shop: { name: string; phone: string | null; address: string | null; email: string | null; timeZone: string };
  view: MessagingView;
  smtpPass: string | null;
  twilioToken: string | null;
};

/** For the worker and test sends only: the view plus the opened secrets. A secret opened with an older key is re-sealed and saved. */
export async function sendConfig(shopId: string): Promise<SendConfig> {
  const [shop, row] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true, address: true, email: true, timeZone: true } }),
    db.messagingSettings.findUnique({ where: { shopId } }),
  ]);
  const pass = row ? unseal(row.smtpPassSealed, shopId, "smtpPass") : null;
  const token = row ? unseal(row.twilioTokenSealed, shopId, "twilioToken") : null;
  const reseal: Prisma.MessagingSettingsUpdateInput = {};
  if (pass?.stale) reseal.smtpPassSealed = seal(pass.plain, shopId, "smtpPass");
  if (token?.stale) reseal.twilioTokenSealed = seal(token.plain, shopId, "twilioToken");
  if (Object.keys(reseal).length) await db.messagingSettings.update({ where: { shopId }, data: reseal }).catch(() => {});
  return { shopId, shop, view: toView(shopId, row), smtpPass: pass?.plain ?? null, twilioToken: token?.plain ?? null };
}

export const DEFAULT_SMS_CONSENT_TEXT =
  "I agree to receive recurring automated marketing text messages from {shop_name} at the number above. Consent is not a condition of purchase. Msg frequency varies. Msg & data rates may apply. Reply STOP to cancel, HELP for help.";

/** The words customers agree to for marketing texts: the saved wording or the default, {shop_name} filled in. */
export function consentWording(ms: { smsConsentText: string | null }, shopName: string): string {
  return (ms.smsConsentText?.trim() || DEFAULT_SMS_CONSENT_TEXT).replace(/\{shop_name\}/g, shopName);
}

/** A short stable code for a wording, printed on the paper form: sha1, first 6 hex, upper-case. */
export function consentCode(wording: string): string {
  return crypto.createHash("sha1").update(wording.trim()).digest("hex").slice(0, 6).toUpperCase();
}

/**
 * Whether a request came from the PC itself: Host is localhost / 127.0.0.1 / [::1] and no proxy header is present (a
 * tunnel that rewrites Host to localhost still adds one; the program's own window adds none).
 */
export function isLocalRequest(h: Headers): boolean {
  const host = (h.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (!local) return false;
  for (const k of ["x-forwarded-for", "x-forwarded-host", "forwarded", "cf-connecting-ip", "x-real-ip"]) if (h.has(k)) return false;
  return true;
}
