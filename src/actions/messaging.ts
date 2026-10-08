"use server";
// Settings -> Messages and the outbox's buttons (scheduling-messaging-design.md section 8.1). Every action is
// requireAdmin(); since 7 Oct 2026 (pricing-review-2026-10.md) the setup is in the base, for the ready, parts-in and
// estimate messages, and only what is Marketing's own (its automatic messages and wording, held marketing, the
// restore hold) also needs requireOn(user, "marketing"). Secrets are sealed here and never sent back to a page.
import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isUserError, safe, UserError } from "@/lib/action";
import { requireAdmin, requireUser, type CurrentUser } from "@/lib/session";
import { moduleOn, requireOn } from "@/lib/module-gate";
import { isDesktop } from "@/lib/modules";
import { allow } from "@/lib/rate-limit";
import { fmtPhone, toE164, validEmail } from "@/lib/phone";
import { parseHm, wall } from "@/lib/zoned";
import { consentCode, consentWording, isLocalRequest, messagingView, sendConfig, type MessagingView, type SendConfig } from "@/lib/messaging/settings";
import { seal, type SecretField } from "@/lib/messaging/secrets";
import { isPreset } from "@/lib/messaging/presets";
import { checkTemplate, cleanSubject, DEFAULT_TEMPLATES, FIELDS, plainText, render, SAMPLE_VARS, TEMPLATE_KEYS, templateFor } from "@/lib/messaging/templates";
import { queueToAddress, type Content } from "@/lib/messaging/queue";
import { messageRun, sendOneNow } from "@/lib/messaging/worker";
import { checkSmtpHost, verifySmtp } from "@/lib/messaging/smtp";
import { checkTwilio, sendText } from "@/lib/messaging/twilio";
import { isSendError } from "@/lib/messaging/errors";
import { BASE_KINDS, BASE_TEMPLATE_KINDS, type Channel } from "@/lib/messaging/types";

// ---------- small helpers ----------

const str = (fd: FormData, name: string): string | null => {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
};
const on = (fd: FormData, name: string) => fd.get(name) === "on";

/** A whole number within [min, max], or the message. A blank field gives `fallback` when one is set. */
function int(fd: FormData, name: string, min: number, max: number, msg: string, fallback?: number): number {
  const raw = str(fd, name);
  if (raw == null && fallback != null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(msg);
  return n;
}

type SettingsData = Omit<Prisma.MessagingSettingsUncheckedCreateInput, "shopId" | "shop">;

/** The MessagingSettings row is made on the first save. */
async function upsertSettings(shopId: string, data: SettingsData) {
  await db.messagingSettings.upsert({ where: { shopId }, create: { shopId, ...data }, update: data as Prisma.MessagingSettingsUncheckedUpdateInput });
}

function afterSave() {
  revalidatePath("/settings/messages", "layout");
  revalidatePath("/messages");
}

/** An owner or admin: the messaging setup is in the base (the ticket's own notices). */
async function admin(): Promise<CurrentUser> {
  return requireAdmin();
}

/** An owner or admin, with Marketing on: what only marketing uses. */
async function marketingAdmin(): Promise<CurrentUser> {
  const user = await requireAdmin();
  await requireOn(user, "marketing");
  return user;
}

const shopFor = (shopId: string) => db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true, address: true, email: true, timeZone: true } });

// A "use server" file may export only async functions, so this stays a plain const (the page has its own copy).
const LOCAL_ONLY_MESSAGE = "Enter passwords on the shop PC itself (in the StitchBench window), not from another device on the network.";

type SecretChange = { mode: "keep" } | { mode: "clear" } | { mode: "set"; plain: string };

/**
 * What to do with a secret field: a blank input keeps the stored one, the "forget" tick clears it, and a typed value is
 * taken only from the PC itself on the Windows program (4.2).
 */
async function secretChange(fd: FormData, name: string, forget: string, trim: boolean): Promise<SecretChange> {
  if (on(fd, forget)) return { mode: "clear" };
  const raw = fd.get(name);
  const v = typeof raw === "string" ? (trim ? raw.trim() : raw) : "";
  if (!v.trim()) return { mode: "keep" };
  if (isDesktop() && !isLocalRequest(await headers())) throw new UserError(LOCAL_ONLY_MESSAGE);
  return { mode: "set", plain: v };
}

/** The plain secret a save would leave in place: the typed one, the stored one, or none. */
async function resolvedSecret(change: SecretChange, shopId: string, field: "smtpPass" | "twilioToken"): Promise<string | null> {
  if (change.mode === "set") return change.plain;
  if (change.mode === "clear") return null;
  const cfg = await sendConfig(shopId);
  return field === "smtpPass" ? cfg.smtpPass : cfg.twilioToken;
}

function sealedFields(change: SecretChange, shopId: string, field: SecretField, sealedKey: "smtpPassSealed" | "twilioTokenSealed", savedKey: "smtpPassSavedAt" | "twilioTokenSavedAt"): SettingsData {
  if (change.mode === "keep") return {};
  if (change.mode === "clear") return { [sealedKey]: null, [savedKey]: null };
  return { [sealedKey]: seal(change.plain, shopId, field), [savedKey]: new Date() };
}

const NOT_SAVED = " Nothing was saved. Tick 'Save without checking' if you're offline.";

/** A failed connection check as words for the admin (never credentials). */
function checkFailed(e: unknown, fallback: string): never {
  if (isUserError(e)) throw e;
  const msg = isSendError(e) ? e.message : fallback;
  throw new UserError(`${msg}${NOT_SAVED}`);
}

/** 540 -> "9:00 am" */
function hm12(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

// ---------- settings ----------

export const saveEmailSettings = safe(async function saveEmailSettings(fd: FormData) {
  const user = await admin();
  const shopId = user.shopId;
  const cur = await messagingView(shopId);
  const hosted = !isDesktop();

  const emailOn = on(fd, "emailOn");
  const presetRaw = str(fd, "smtpPreset");
  const smtpPreset = isPreset(presetRaw) ? presetRaw : null;
  const smtpHost = str(fd, "smtpHost")?.toLowerCase() ?? null;
  if (emailOn && !smtpHost) throw new UserError("Enter your mail server, like smtp.gmail.com.");
  if (smtpHost && !/^[a-z0-9.-]+$/.test(smtpHost)) throw new UserError("Enter your mail server, like smtp.gmail.com.");
  const smtpPort = int(fd, "smtpPort", 1, 65535, "Check the port: usually 587, or 465 for SSL.", cur.smtpPort);
  const securityRaw = str(fd, "smtpSecurity") ?? cur.smtpSecurity;
  if (securityRaw !== "starttls" && securityRaw !== "tls" && securityRaw !== "none") throw new UserError("Pick the connection security.");
  // Plain connections and private servers: checkSmtpHost() applies the hosted rules (and SMTP_ALLOW_HOSTS loosens them for tests).
  const smtpSecurity = securityRaw;
  const smtpUser = str(fd, "smtpUser");
  const fromName = str(fd, "fromName");
  if (fromName && (fromName.length > 80 || /[\r\n]/.test(fromName))) throw new UserError("Use a plain name, one line.");
  const fromRaw = str(fd, "fromEmail");
  const fromEmail = validEmail(fromRaw);
  if ((emailOn || fromRaw) && !fromEmail) throw new UserError("Enter the address emails come from.");
  const replyRaw = str(fd, "replyTo");
  const replyTo = validEmail(replyRaw);
  if (replyRaw && !replyTo) throw new UserError("Enter a plain reply-to address, like shop@example.com.");

  const pass = await secretChange(fd, "smtpPass", "forgetPass", false);
  const plainPass = await resolvedSecret(pass, shopId, "smtpPass");
  if (emailOn && hosted && (!smtpUser || !plainPass)) throw new UserError("Enter the user name and password your mail provider gave you.");
  if (emailOn && smtpUser && !plainPass) throw new UserError("Enter the user name and password your mail provider gave you.");
  if (emailOn && smtpHost) await checkSmtpHost(smtpHost, smtpPort, smtpSecurity);

  // "Someone reads this mailbox": recorded with the tick, dropped when the address changes.
  const replyChanged = (replyTo ?? null) !== (cur.replyTo ?? null);
  const watched = on(fd, "replyWatched") && !!replyTo;
  const replyWatchedAt = watched ? (replyChanged ? new Date() : (cur.replyWatchedAt ?? new Date())) : null;
  const replyWatchedBy = watched ? (replyChanged || !cur.replyWatchedAt ? user.id : cur.replyWatchedBy) : null;

  const secret = sealedFields(pass, shopId, "smtpPass", "smtpPassSealed", "smtpPassSavedAt");

  if (emailOn && !on(fd, "skipCheck")) {
    if (!allow(`smtp-verify:${shopId}`, 10, 3_600_000)) throw new UserError("That's a lot of checks. Try again in an hour.");
    const shop = await shopFor(shopId);
    const view: MessagingView = {
      ...cur,
      emailOn,
      smtpPreset,
      smtpHost,
      smtpPort,
      smtpSecurity,
      smtpUser,
      fromName,
      fromEmail,
      replyTo,
      hasSmtpPass: !!plainPass,
      emailPausedAt: null,
      emailPausedUntil: null,
      emailError: null,
      emailReady: true,
    };
    const cfg: SendConfig = { shopId, shop, view, smtpPass: plainPass, twilioToken: null };
    try {
      await verifySmtp(cfg);
    } catch (e) {
      checkFailed(e, "The mail server couldn't be reached.");
    }
  }

  await upsertSettings(shopId, {
    emailOn,
    smtpPreset,
    smtpHost,
    smtpPort,
    smtpSecurity,
    smtpUser,
    fromName,
    fromEmail,
    replyTo,
    replyWatchedAt,
    replyWatchedBy,
    emailPausedAt: null,
    emailPausedUntil: null,
    emailCheckAt: null,
    emailError: null,
    ...secret,
  });
  afterSave();
});

export const saveTextSettings = safe(async function saveTextSettings(fd: FormData) {
  const user = await admin();
  const shopId = user.shopId;
  const cur = await messagingView(shopId);

  const smsOn = on(fd, "smsOn");
  if (smsOn && !cur.tzConfirmedAt) throw new UserError("Check the shop's time zone first (just below).");
  const twilioSid = str(fd, "twilioSid");
  if ((smsOn || twilioSid) && !(twilioSid && /^AC[0-9a-f]{32}$/i.test(twilioSid))) {
    throw new UserError("The Account SID starts with AC and is 34 characters. Find it on your Twilio console's front page.");
  }
  const twilioKeySid = str(fd, "twilioKeySid");
  if (twilioKeySid && !/^SK[0-9a-f]{32}$/i.test(twilioKeySid)) throw new UserError("An API key SID starts with SK.");
  const token = await secretChange(fd, "twilioToken", "forgetToken", true);
  const plainToken = await resolvedSecret(token, shopId, "twilioToken");
  if (smsOn && !plainToken) throw new UserError("Enter the Auth Token, or the API key's secret.");
  const fromRaw = str(fd, "twilioFrom");
  const twilioFrom = toE164(fromRaw);
  if ((smsOn || fromRaw) && !twilioFrom) throw new UserError("Enter your Twilio number like (555) 123-4567.");

  const secret = sealedFields(token, shopId, "twilioToken", "twilioTokenSealed", "twilioTokenSavedAt");

  if (smsOn && twilioSid && plainToken && !on(fd, "skipCheck")) {
    if (!allow(`twilio-verify:${shopId}`, 10, 3_600_000)) throw new UserError("That's a lot of checks. Try again in an hour.");
    try {
      await checkTwilio(twilioSid, twilioKeySid ?? twilioSid, plainToken);
    } catch (e) {
      if (isSendError(e) && (e.code === "401" || e.kind === "settings")) throw new UserError(`Twilio said the SID or the token / secret is wrong.${NOT_SAVED}`);
      checkFailed(e, "Twilio couldn't be reached.");
    }
  }

  await upsertSettings(shopId, {
    smsOn,
    twilioSid,
    twilioKeySid,
    twilioFrom,
    smsPausedAt: null,
    smsPausedUntil: null,
    smsCheckAt: null,
    smsError: null,
    ...secret,
  });
  afterSave();
});

/** An IANA time zone this server knows (America/New_York...), with the same message Settings -> Shop gives. */
function validTimeZone(tz: string | null): string {
  if (!tz) throw new UserError("Pick a time zone.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new UserError(`"${tz}" isn't a time zone. Use a name like America/New_York or America/Chicago.`);
  }
}

export const confirmTimeZone = safe(async function confirmTimeZone(fd: FormData) {
  const user = await admin();
  const timeZone = validTimeZone(str(fd, "timeZone"));
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true } });
  if (shop.timeZone !== timeZone) {
    await db.shop.update({ where: { id: user.shopId }, data: { timeZone } });
    revalidatePath("/", "layout");
  }
  await upsertSettings(user.shopId, { tzConfirmedAt: new Date(), tzConfirmedBy: user.id });
  afterSave();
});

type ConsentHistory = { code: string; text: string; from: string | null; to: string };

export const saveMessageRules = safe(async function saveMessageRules(fd: FormData) {
  const user = await admin();
  const shopId = user.shopId;
  const [cur, shop] = await Promise.all([messagingView(shopId), shopFor(shopId)]);

  const postalAddress = str(fd, "postalAddress");
  if (postalAddress && postalAddress.length > 300) throw new UserError("Keep the postal address under 300 characters.");
  const QUIET = "Texts can only go out between 8:00 am and 9:00 pm.";
  const quietStart = parseHm(str(fd, "quietStart"));
  const quietEnd = parseHm(str(fd, "quietEnd"));
  if (quietStart == null || quietEnd == null) throw new UserError("Enter the quiet hours like 09:00 and 20:00.");
  if (quietStart < 8 * 60 || quietEnd > 21 * 60 || quietStart >= quietEnd) throw new UserError(QUIET);
  const noSundayMarketing = on(fd, "noSundayMarketing");
  const emailDailyCap = int(fd, "emailDailyCap", 1, 5000, "Daily caps are between 1 and 5000.", cur.emailDailyCap);
  const smsDailyCap = int(fd, "smsDailyCap", 1, 5000, "Daily caps are between 1 and 5000.", cur.smsDailyCap);
  const smsPartMills = int(fd, "smsPartMills", 1, 1000, "The text part price is between 1 and 1000 tenths of a cent.", cur.smsPartMills);

  const wordingRaw = str(fd, "smsConsentText");
  if (wordingRaw && wordingRaw.length > 1000) throw new UserError("Keep the consent wording under 1000 characters.");
  if (wordingRaw) {
    const filled = wordingRaw.replace(/\{shop_name\}/g, shop.name).toLowerCase();
    const namesShop = filled.includes(shop.name.toLowerCase());
    if (!namesShop || !/\bstop\b/.test(filled) || !filled.includes("not a condition")) {
      throw new UserError("The wording must name the shop, say consent is not a condition of purchase, and tell people they can reply STOP.");
    }
  }
  const smsConsentText = wordingRaw;

  // A changed wording keeps the old one (with its code) for paper forms already printed.
  const oldWording = consentWording(cur, shop.name);
  const newWording = consentWording({ smsConsentText }, shop.name);
  const history = Array.isArray(cur.consentTexts) ? ([...(cur.consentTexts as unknown[])] as ConsentHistory[]) : [];
  if (oldWording.trim() !== newWording.trim()) {
    const last = history[history.length - 1];
    const from = last?.to ?? (cur.updatedAt.getTime() > 0 ? cur.updatedAt.toISOString() : null);
    history.push({ code: consentCode(oldWording), text: oldWording, from, to: new Date().toISOString() });
  }

  await upsertSettings(shopId, {
    postalAddress,
    quietStart,
    quietEnd,
    noSundayMarketing,
    emailDailyCap,
    smsDailyCap,
    smsPartMills,
    smsConsentText,
    consentTexts: history as unknown as Prisma.InputJsonValue,
  });
  afterSave();
});

/** "7, 30" -> [7, 30]: one to four whole numbers of days, 1-365, going up. */
function parseAbandonDays(raw: string | null): number[] {
  const MSG = "List the days after 'ready' like 7, 30.";
  const parts = (raw ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 4) throw new UserError(MSG);
  const days = parts.map((p) => Number(p));
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 365)) throw new UserError(MSG);
  for (let i = 1; i < days.length; i++) if (days[i] <= days[i - 1]) throw new UserError(MSG);
  return days;
}

export const saveAutoMessages = safe(async function saveAutoMessages(fd: FormData) {
  const user = await admin();
  const cur = await messagingView(user.shopId);
  // Without Marketing only the base notices' settings change (the form shows the rest read-only); the rest is kept.
  if (!(await moduleOn(user.shopId, "marketing"))) {
    const estimateLinkDays = int(fd, "estimateLinkDays", 1, 30, "Estimate links stay open 1 to 30 days.", cur.estimateLinkDays);
    await upsertSettings(user.shopId, { readyNotice: on(fd, "readyNotice"), estimateLinkDays });
    afterSave();
    return;
  }

  const readyNotice = on(fd, "readyNotice");
  const reminders = on(fd, "reminders");
  const reminderHour = int(fd, "reminderHour", 8, 20, "Reminders go out between 8 am and 8 pm: pick an hour from 8 to 20.", cur.reminderHour);
  const abandonNotices = on(fd, "abandonNotices");
  const abandonDays = parseAbandonDays(str(fd, "abandonDays") ?? cur.abandonDays.join(", "));
  const finalNoticeDays = int(fd, "finalNoticeDays", 1, 60, "The final notice goes 1 to 60 days before the abandon date.", cur.finalNoticeDays);
  const serviceDue = on(fd, "serviceDue");
  const serviceDueMonths = int(fd, "serviceDueMonths", 3, 60, "Service reminders go after 3 to 60 months.", cur.serviceDueMonths);
  const serviceDueSince = serviceDue ? (cur.serviceDue ? cur.serviceDueSince : new Date()) : null;
  const reviewRequest = on(fd, "reviewRequest");
  const reviewUrl = str(fd, "reviewUrl");
  if (reviewUrl && (reviewUrl.length > 500 || !/^https:\/\/\S+$/.test(reviewUrl))) throw new UserError("Paste your Google review link (it starts with https://).");
  if (reviewRequest && !reviewUrl) throw new UserError("Paste your Google review link (it starts with https://).");
  const reviewDelayHours = int(fd, "reviewDelayHours", 1, 168, "Ask for a review 1 to 168 hours after pickup.", cur.reviewDelayHours);
  const reviewEveryDays = int(fd, "reviewEveryDays", 30, 3650, "Ask each customer at most once every 30 to 3650 days.", cur.reviewEveryDays);
  const reviewAfterSales = on(fd, "reviewAfterSales");
  const estimateLinkDays = int(fd, "estimateLinkDays", 1, 30, "Estimate links stay open 1 to 30 days.", cur.estimateLinkDays);

  await upsertSettings(user.shopId, {
    readyNotice,
    reminders,
    reminderHour,
    abandonNotices,
    abandonDays,
    finalNoticeDays,
    serviceDue,
    serviceDueMonths,
    serviceDueSince,
    reviewRequest,
    reviewUrl,
    reviewDelayHours,
    reviewEveryDays,
    reviewAfterSales,
    estimateLinkDays,
  });
  afterSave();
});

// ---------- wording ----------

const LIMITS = { sms: 480, email: 5000, subject: 150 } as const;

function templateKind(key: string): { kind: string; part: keyof typeof LIMITS } {
  if (!TEMPLATE_KEYS.includes(key)) throw new UserError("Unknown message.");
  const [kind, part] = key.split(".") as [string, keyof typeof LIMITS];
  return { kind, part };
}

async function writeTemplates(shopId: string, cur: MessagingView, change: (t: Record<string, string>) => void) {
  const t = cur.templates && typeof cur.templates === "object" && !Array.isArray(cur.templates) ? { ...(cur.templates as Record<string, string>) } : {};
  change(t);
  await upsertSettings(shopId, { templates: t as Prisma.InputJsonValue });
  afterSave();
}

/** The wording of a base notice is the base's; every other wording is Marketing's (or Scheduling's, sent through it). */
async function templateAdmin(kind: string): Promise<CurrentUser> {
  return BASE_TEMPLATE_KINDS.includes(kind) ? admin() : marketingAdmin();
}

export const saveTemplate = safe(async function saveTemplate(key: string, fd: FormData) {
  const { kind, part } = templateKind(key);
  const user = await templateAdmin(kind);
  const cur = await messagingView(user.shopId);
  const typed = String(fd.get("text") ?? "").replace(/\r\n?/g, "\n");
  const text = plainText(typed).text.trim();
  if (text.length > LIMITS[part]) throw new UserError(`Keep it under ${LIMITS[part]} characters.`);
  if (part === "subject" && /[\n]/.test(text)) throw new UserError("Use a one-line subject.");
  if (part === "subject" && /^(re|fw|fwd):/i.test(text)) throw new UserError("Don't start the subject with RE: or FW: unless it's a real reply.");
  checkTemplate(text, FIELDS[kind] ?? []);
  await writeTemplates(user.shopId, cur, (t) => {
    if (!text || text === DEFAULT_TEMPLATES[key]) delete t[key];
    else t[key] = text;
  });
});

export const resetTemplate = safe(async function resetTemplate(key: string) {
  const user = await templateAdmin(templateKind(key).kind);
  const cur = await messagingView(user.shopId);
  await writeTemplates(user.shopId, cur, (t) => {
    delete t[key];
  });
});

// ---------- tests ----------

/** The sample values with this shop's name and phone in. */
function sampleVars(shop: { name: string; phone: string | null }): Record<string, string> {
  return { ...SAMPLE_VARS, shop_name: shop.name, shop_phone: shop.phone ?? SAMPLE_VARS.shop_phone };
}

/**
 * Sends one email or text to the admin's own address right away (not safe(): the detail comes back). `sample` names a
 * template key to render with the sample values; otherwise a fixed test line goes.
 */
export async function sendTestMessage(fd: FormData): Promise<{ ok: true; detail: string } | { error: string }> {
  try {
    const user = await admin();
    const shopId = user.shopId;
    const channelRaw = str(fd, "channel");
    if (channelRaw !== "email" && channelRaw !== "sms") throw new UserError("Pick email or text.");
    const channel: Channel = channelRaw;
    const [view, shop] = await Promise.all([messagingView(shopId), shopFor(shopId)]);

    let address: string;
    if (channel === "email") {
      const to = validEmail(str(fd, "to"));
      const allowedTo = [validEmail(user.email), view.fromEmail, view.replyTo].filter((a): a is string => !!a);
      if (!to || !allowedTo.includes(to)) throw new UserError("Test emails go only to your own login address, the From address or the Reply-to address.");
      address = to;
    } else {
      const to = toE164(str(fd, "to"));
      if (!to || !view.testPhones.includes(to)) throw new UserError("Add your mobile number as a test number first.");
      const w = wall(new Date(), shop.timeZone);
      const m = w.hour * 60 + w.minute;
      if (m < view.quietStart || m >= view.quietEnd) throw new UserError(`Texts can only go out between ${hm12(view.quietStart)} and ${hm12(view.quietEnd)}.`);
      address = to;
    }
    if (!allow(`test:${shopId}`, 10, 3_600_000)) throw new UserError("That's a lot of tests. Try again in an hour.");

    const sample = str(fd, "sample");
    let content: Content;
    if (sample && TEMPLATE_KEYS.includes(sample)) {
      const kind = sample.split(".")[0];
      const vars = sampleVars(shop);
      content =
        channel === "sms"
          ? { body: render(templateFor(view, `${kind}.sms`), vars) }
          : { subject: cleanSubject(render(templateFor(view, `${kind}.subject`), vars)), body: render(templateFor(view, `${kind}.email`), vars) };
      if (!content.body.trim()) throw new UserError("That message has no wording for this channel.");
    } else {
      const when = new Date().toLocaleString("en-US", { timeZone: shop.timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      content =
        channel === "sms"
          ? { body: `This is a test text from StitchBench (${when}). If you got it, texts are working.` }
          : { subject: "StitchBench test email", body: `This is a test email from StitchBench, sent ${when}.\n\nIf you're reading it, email is working.` };
    }

    const q = await queueToAddress(db, { shopId, kind: "test", channel, address, content, status: "SENDING", byUserId: user.id });
    if (!q.id) throw new UserError(q.reason === "opted_out" ? "That address opted out of messages, so a test can't go there." : "The test couldn't be queued. Try again.");
    const r = await sendOneNow(q.id);
    if ("error" in r) return { error: r.error };
    return { ok: true, detail: r.detail || `Sent to ${channel === "sms" ? fmtPhone(address) : address}.` };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export const addTestPhone = safe(async function addTestPhone(fd: FormData) {
  const user = await admin();
  const shopId = user.shopId;
  const phone = toE164(str(fd, "phone"));
  if (!phone) throw new UserError("Enter a mobile number like (555) 123-4567.");
  const cfg = await sendConfig(shopId);
  if (cfg.view.testPhones.includes(phone)) throw new UserError("That number is already a test number.");
  if (cfg.view.testPhones.length >= 5) throw new UserError("Five test numbers at most.");
  if (!cfg.view.twilioSid || !cfg.twilioToken || !cfg.view.twilioFrom) throw new UserError("Save your Twilio settings first: the code is texted from your Twilio number.");
  if (!allow(`testcode:${shopId}`, 5, 3_600_000)) throw new UserError("That's a lot of codes. Try again in an hour.");
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  try {
    await sendText(cfg, phone, `${cfg.shop.name}: your StitchBench test code is ${code}`);
  } catch (e) {
    if (isSendError(e)) throw new UserError(`The code couldn't be sent: ${e.message}`);
    throw e;
  }
  await upsertSettings(shopId, { testPhonePending: phone, testCodeHash: sha256(code), testCodeUntil: new Date(Date.now() + 10 * 60_000) });
  afterSave();
});

export const confirmTestPhone = safe(async function confirmTestPhone(fd: FormData) {
  const user = await admin();
  const shopId = user.shopId;
  const code = (str(fd, "code") ?? "").replace(/\s+/g, "");
  const row = await db.messagingSettings.findUnique({ where: { shopId }, select: { testPhonePending: true, testCodeHash: true, testCodeUntil: true, testPhones: true } });
  const BAD = "That code isn't right, or it's more than 10 minutes old.";
  if (!row?.testPhonePending || !row.testCodeHash || !row.testCodeUntil) throw new UserError("Add the number first: a code is texted to it.");
  if (!/^\d{6}$/.test(code) || row.testCodeUntil.getTime() < Date.now()) throw new UserError(BAD);
  const a = Buffer.from(sha256(code));
  const b = Buffer.from(row.testCodeHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new UserError(BAD);
  const testPhones = row.testPhones.includes(row.testPhonePending) ? row.testPhones : [...row.testPhones, row.testPhonePending];
  await upsertSettings(shopId, { testPhones, testPhonePending: null, testCodeHash: null, testCodeUntil: null });
  afterSave();
});

/** Removing a test number is allowed whatever the module says. */
export const removeTestPhone = safe(async function removeTestPhone(phone: string) {
  const user = await requireAdmin();
  const row = await db.messagingSettings.findUnique({ where: { shopId: user.shopId }, select: { testPhones: true, testPhonePending: true } });
  if (!row) return;
  const data: SettingsData = { testPhones: row.testPhones.filter((p) => p !== phone) };
  if (row.testPhonePending === phone) Object.assign(data, { testPhonePending: null, testCodeHash: null, testCodeUntil: null });
  await upsertSettings(user.shopId, data);
  afterSave();
});

// ---------- the outbox ----------

export const runMessagesNow = safe(async function runMessagesNow() {
  const user = await admin();
  if (!allow(`run:${user.id}`, 6, 60_000)) throw new UserError("Give it a minute: that's been pressed a few times already.");
  const r = await messageRun({ forceSchedulers: true });
  if ("busy" in r) throw new UserError("Messages are being sent right now. Try again in a minute.");
  if ("off" in r) throw new UserError("Messages are switched off on this server (MESSAGES=off).");
  revalidatePath("/messages");
});

export const retryMessage = safe(async function retryMessage(id: string, fd?: FormData) {
  const user = await admin();
  const row = await db.outMessage.findFirst({ where: { id, shopId: user.shopId }, select: { id: true, status: true, error: true, kind: true } });
  if (!row) throw new UserError("Message not found.");
  if (!(BASE_KINDS as string[]).includes(row.kind)) await requireOn(user, "marketing");
  if (row.status !== "FAILED") throw new UserError("Only a message that wasn't sent can be retried.");
  if (/may have gone out/i.test(row.error ?? "") && fd?.get("confirm") !== "on") {
    throw new UserError("This one may already have gone out. Tick the box to send it again anyway.");
  }
  await db.outMessage.update({ where: { id: row.id }, data: { status: "QUEUED", retryTries: 0, nextTryAt: null, sendAfter: new Date(), error: null, claimedAt: null } });
  revalidatePath("/messages");
});

/** Stops a waiting message. Any user; an uncollected-machine notice only an owner or admin (no module check). */
export const cancelMessage = safe(async function cancelMessage(id: string) {
  const user = await requireUser();
  const row = await db.outMessage.findFirst({ where: { id, shopId: user.shopId }, select: { id: true, status: true, kind: true } });
  if (!row) throw new UserError("Message not found.");
  if (row.status !== "QUEUED") throw new UserError("Only a waiting message can be stopped.");
  if (row.kind === "abandon" && user.role === "TECH") throw new UserError("Only an owner or admin can stop an uncollected-machine notice: it's your proof of notice.");
  await db.outMessage.updateMany({ where: { id: row.id, shopId: user.shopId, status: "QUEUED" }, data: { status: "CANCELLED", cancelledById: user.id, error: `Cancelled by ${user.name}` } });
  revalidatePath("/messages");
});

const STALE_MS = 48 * 3_600_000;
const staleWhere = (shopId: string): Prisma.OutMessageWhereInput => ({ shopId, purpose: "marketing", status: "QUEUED", sendAfter: { lt: new Date(Date.now() - STALE_MS) } });

/** Marketing messages that waited more than two days go out now. */
export const releaseHeld = safe(async function releaseHeld() {
  const user = await marketingAdmin();
  await db.outMessage.updateMany({ where: staleWhere(user.shopId), data: { sendAfter: new Date(), nextTryAt: null } });
  revalidatePath("/messages");
});

/** ... or are dropped (no module check: stopping work is always allowed). */
export const cancelHeld = safe(async function cancelHeld() {
  const user = await requireAdmin();
  await db.outMessage.updateMany({ where: staleWhere(user.shopId), data: { status: "CANCELLED", cancelledById: user.id, error: `Cancelled by ${user.name}` } });
  revalidatePath("/messages");
});

export const releaseMarketingHold = safe(async function releaseMarketingHold(fd: FormData) {
  const user = await marketingAdmin();
  if (!on(fd, "checked")) throw new UserError("Tick the box first: check Messages -> Opt-outs (and your mailbox) for opt-outs recorded since the backup.");
  await upsertSettings(user.shopId, { marketingHoldAt: null });
  afterSave();
});

export const releaseTextHold = safe(async function releaseTextHold(fd: FormData) {
  const user = await admin();
  if (!on(fd, "checked")) throw new UserError("Tick the box first: read the latest replies in the Twilio console.");
  await upsertSettings(user.shopId, { textHoldAt: null, textHoldWhy: null, inboundIncomplete: 0 });
  afterSave();
});
