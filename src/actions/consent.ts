"use server";

// Consent and opt-out records (scheduling-messaging-design.md section 8.2). Never module-gated: these records are the
// law's, not the module's, so they can be made whether or not Marketing is on.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { assertId } from "@/lib/input";
import { str } from "@/lib/format";
import { toE164, usMarketingNumber, validEmail } from "@/lib/phone";
import { dayStart, parseYmd, ymdOf } from "@/lib/zoned";
import { shopTimeZone } from "@/lib/shop-zone";
import { CONSENT_SOURCE_LABEL } from "@/lib/constants";
import { addressForOptOutCode, recordConsent, suppress, unsuppress } from "@/lib/messaging/consent";
import { consentCode, consentWording, messagingView } from "@/lib/messaging/settings";
import { queueToAddress } from "@/lib/messaging/queue";
import { render, templateFor } from "@/lib/messaging/templates";
import type { Channel } from "@/lib/messaging/types";
import { isNotifyBy } from "@/components/notify-by-field";

function refresh(customerId?: string | null) {
  if (customerId) revalidatePath(`/customers/${customerId}`);
  revalidatePath("/messages", "layout");
}

async function ownCustomer(shopId: string, customerId: unknown) {
  const c = await db.customer.findFirst({ where: { id: assertId(customerId), shopId } });
  if (!c) throw new UserError("Customer not found.");
  return c;
}

/** "How should we tell them": from the ticket / job "They said: ..." buttons (the customer page edits it through CustomerForm). */
export const setNotifyBy = safe(async function setNotifyBy(customerId: string, fd: FormData) {
  const user = await requireUser();
  const c = await ownCustomer(user.shopId, customerId);
  const notifyBy = str(fd.get("notifyBy")) ?? "";
  if (!isNotifyBy(notifyBy)) throw new UserError("Pick how to tell them.");
  const source = str(fd.get("source")) === "customer_page" ? "customer_page" : "ticket";
  if (notifyBy !== c.notifyBy) {
    await db.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: c.id }, data: { notifyBy } });
      await recordConsent(tx, { shopId: user.shopId, customerId: c.id, channel: "any", event: "notify_pref", source, detail: notifyBy, byUserId: user.id });
    });
  }
  refresh(c.id);
});

type ConsentText = { code?: string; text?: string };

/** Written consent for marketing texts (TCPA): signed on the counter tablet, or a signed paper form recorded by staff. */
export const recordTextConsent = safe(async function recordTextConsent(customerId: string, fd: FormData) {
  const user = await requireUser();
  const c = await ownCustomer(user.shopId, customerId);
  if (c.kind !== "RETAIL") throw new UserError("Trade accounts get no marketing texts.");
  const address = toE164(c.phone);
  if (!address) throw new UserError("Add their mobile number first.");
  if (!usMarketingNumber(address)) throw new UserError("Marketing texts go only to US numbers.");
  const stopped = await db.suppression.findUnique({ where: { shopId_channel_address: { shopId: user.shopId, channel: "sms", address } } });
  if (stopped) throw new UserError("They replied STOP. They must text START to your number first.");

  const source = str(fd.get("source"));
  if (source !== "tablet" && source !== "paper_form") throw new UserError("Say how they agreed: on the tablet or on a paper form.");
  const [shop, ms, tz] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true } }),
    messagingView(user.shopId),
    shopTimeZone(user.shopId),
  ]);
  const current = consentWording(ms, shop.name);

  let at: Date;
  let text: string;
  if (source === "tablet") {
    const name = str(fd.get("signedName")) ?? "";
    const agree = fd.get("agree");
    if (!agree || name.length < 2 || name.length > 80) throw new UserError("Tick the box and type your name.");
    at = new Date();
    text = `${current}\nSigned: ${name}`;
  } else {
    const signedOn = parseYmd(str(fd.get("signedOn")));
    if (!signedOn) throw new UserError("Enter the date on the form (YYYY-MM-DD).");
    if (signedOn > ymdOf(new Date(), tz)) throw new UserError("The date on the form can't be in the future.");
    const code = (str(fd.get("code")) ?? "").toUpperCase();
    const earlier = Array.isArray(ms.consentTexts) ? (ms.consentTexts as ConsentText[]) : [];
    let wording: string | null = null;
    if (code && code === consentCode(current)) wording = current;
    else {
      const hit = earlier.find((t) => t && typeof t.text === "string" && (t.code === code || consentCode(t.text.replace(/\{shop_name\}/g, shop.name)) === code));
      if (hit?.text) wording = hit.text.replace(/\{shop_name\}/g, shop.name);
    }
    if (!wording) throw new UserError("That code isn't on any of your consent forms. It's printed at the bottom of the form.");
    at = new Date(dayStart(signedOn, tz).getTime() + 12 * 3_600_000);
    text = `${wording}\nPaper form dated ${signedOn}, code ${code}`;
  }

  await db.$transaction(async (tx) => {
    await tx.customer.update({ where: { id: c.id }, data: { smsConsentAt: at, smsConsentPhone: address, smsConsentSource: source, smsConsentText: text } });
    await recordConsent(tx, { shopId: user.shopId, customerId: c.id, channel: "sms", address, event: "marketing_yes", source, detail: text, byUserId: user.id });
    // CTIA: confirm the opt-in to the number itself (an explicit address: only suppression is checked).
    await queueToAddress(tx, {
      shopId: user.shopId,
      kind: "consent_confirm",
      channel: "sms",
      address,
      customerId: c.id,
      dedupeKey: `consent:${c.id}:${at.getTime()}`,
      content: { body: render(templateFor(ms, "consent_confirm.sms"), { shop_name: shop.name, shop_phone: shop.phone ?? "" }) },
    });
  });
  refresh(c.id);
});

export const withdrawTextConsent = safe.whileLapsed("withdrawTextConsent")(async function withdrawTextConsent(customerId: string, fd: FormData) {
  const user = await requireUser();
  const c = await ownCustomer(user.shopId, customerId);
  if (!c.smsConsentAt) throw new UserError("They haven't agreed to marketing texts.");
  const detail = str(fd.get("detail"));
  await db.$transaction(async (tx) => {
    await tx.customer.update({ where: { id: c.id }, data: { smsConsentAt: null, smsConsentPhone: null, smsConsentSource: null, smsConsentText: null } });
    await recordConsent(tx, { shopId: user.shopId, customerId: c.id, channel: "sms", address: c.smsConsentPhone, event: "marketing_no", source: "staff", detail: detail ?? "Withdrawn by staff", byUserId: user.id });
  });
  refresh(c.id);
});

/** "They don't want our messages": any user, from any channel (a call, a letter, an email reply, a pasted unsubscribe code). */
export const recordOptOut = safe.whileLapsed("recordOptOut")(async function recordOptOut(fd: FormData) {
  const user = await requireUser();
  const shopId = user.shopId;
  let customerId = str(fd.get("customerId"));
  const customer = customerId ? await ownCustomer(shopId, customerId) : null;
  customerId = customer?.id ?? null;
  const code = str(fd.get("code"));
  const detail = str(fd.get("detail"));
  const sourceIn = str(fd.get("source")) ?? "staff";
  const source = sourceIn in CONSENT_SOURCE_LABEL ? sourceIn : "staff";
  let channel: Channel;
  let address: string | null;
  if (code) {
    const found = await addressForOptOutCode(shopId, code);
    if (!found) throw new UserError("That code isn't from one of your emails.");
    channel = found.channel;
    address = found.address;
    customerId = customerId ?? found.customerId;
  } else {
    const ch = str(fd.get("channel"));
    if (ch !== "email" && ch !== "sms") throw new UserError("Pick email or text.");
    channel = ch;
    const typed = str(fd.get("address")) ?? (channel === "email" ? customer?.email : customer?.phone) ?? null;
    address = channel === "email" ? validEmail(typed) : toE164(typed);
  }
  if (!address) throw new UserError("Enter the email address or mobile number.");
  const scopeIn = str(fd.get("scope"));
  const scope: "marketing" | "all" = channel === "sms" ? "all" : scopeIn === "all" ? "all" : "marketing";
  await db.$transaction(async (tx) => {
    await suppress(tx, { shopId, channel, address: address!, scope, source, customerId, detail, byUserId: user.id });
  });
  refresh(customerId);
});

/** An admin lifts an opt-out, with a reason for the record. Texts: only after a START, or a form signed again. */
export const removeOptOut = safe(async function removeOptOut(fd: FormData) {
  const user = await requireAdmin();
  const shopId = user.shopId;
  const ch = str(fd.get("channel"));
  if (ch !== "email" && ch !== "sms") throw new UserError("Pick email or text.");
  const channel: Channel = ch;
  const address = channel === "email" ? validEmail(str(fd.get("address"))) : toE164(str(fd.get("address")));
  if (!address) throw new UserError("Enter the email address or mobile number.");
  const detail = str(fd.get("detail"));
  if (!detail) throw new UserError("Say how they asked to get messages again (for the record).");
  const sup = await db.suppression.findUnique({ where: { shopId_channel_address: { shopId, channel, address } } });
  if (!sup) throw new UserError("That address isn't opted out.");
  if (channel === "sms") {
    const started = await db.inboundText.findFirst({ where: { shopId, fromNumber: address, keyword: "START", receivedAt: { gte: sup.at } }, select: { sid: true } });
    const signed = /\bsign(ed|s)?\b.*\bform\b|\bform\b.*\bsign(ed|s)?\b/i.test(detail);
    if (!started && !signed) throw new UserError("For texts, they must text START to your number, or sign the form again.");
  }
  // The customer it was about: the one on the opt-out record, else (email) the customer with that address.
  const optout = await db.consentEvent.findFirst({ where: { shopId, channel, address, event: "optout", customerId: { not: null } }, orderBy: { at: "desc" }, select: { customerId: true } });
  let customerId = optout?.customerId ?? null;
  if (!customerId && channel === "email") customerId = (await db.customer.findFirst({ where: { shopId, email: { equals: address, mode: "insensitive" } }, select: { id: true } }))?.id ?? null;
  await db.$transaction(async (tx) => {
    await unsuppress(tx, { shopId, channel, address, source: "staff", byUserId: user.id, detail, customerId });
  });
  refresh(customerId);
});

/** A customer's text reply has been read (and acted on by phone): marketing texts to that number may go again. */
export const markReplyHandled = safe.whileLapsed("markReplyHandled")(async function markReplyHandled(sid: string) {
  const user = await requireUser();
  const row = await db.inboundText.findUnique({ where: { shopId_sid: { shopId: user.shopId, sid: assertId(sid) } } });
  if (!row) throw new UserError("Reply not found.");
  if (!row.handledAt) await db.inboundText.update({ where: { shopId_sid: { shopId: user.shopId, sid: row.sid } }, data: { handledAt: new Date(), handledBy: user.id } });
  refresh(row.customerId);
  revalidatePath("/", "layout");
});
