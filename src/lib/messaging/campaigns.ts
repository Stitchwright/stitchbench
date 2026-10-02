import "server-only";
// The work behind src/actions/campaigns.ts and src/actions/customer-import.ts (scheduling-messaging-design.md 11.2),
// callable with a user so the check scripts can drive it. The actions check who is asking and the module.
import type { Campaign } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { isDesktop } from "@/lib/modules";
import { allow } from "@/lib/rate-limit";
import type { CurrentUser } from "@/lib/session";
import { toE164, validEmail } from "@/lib/phone";
import { dayStart, wall, ymdOf } from "@/lib/zoned";
import { audienceMembers, audienceOf, campaignSample, campaignShop, parseAudience, previewCampaign } from "@/lib/messaging/audiences";
import { suppress } from "@/lib/messaging/consent";
import { kickMessages } from "@/lib/messaging/kick";
import { queueToAddress } from "@/lib/messaging/queue";
import { messagingView } from "@/lib/messaging/settings";
import { checkTemplate, FIELDS, plainText, smsParts } from "@/lib/messaging/templates";
import { sendOneNow } from "@/lib/messaging/worker";
import type { Channel } from "@/lib/messaging/types";

export const MAX_CAMPAIGN_MEMBERS = 5000;
export const MAX_CAMPAIGNS_PER_DAY = 3;
export const MAX_CAMPAIGN_DAYS = 7;
export const MAX_SMS_PARTS = 4;

const text = (fd: FormData, name: string): string => {
  const v = fd.get(name);
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "";
};

const hm12 = (m: number) => {
  const h = Math.floor(m / 60) % 24;
  const mm = String(m % 60).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "am" : "pm"}`;
};

async function ownCampaign(shopId: string, id: string): Promise<Campaign> {
  const c = await db.campaign.findFirst({ where: { id, shopId } });
  if (!c) throw new UserError("Campaign not found.");
  return c;
}

/** A draft's fields checked (design 11.2 saveCampaign). The channel is fixed after the first save. */
export async function saveCampaignAs(user: CurrentUser, id: string | null, fd: FormData): Promise<string> {
  const shopId = user.shopId;
  const existing = id ? await ownCampaign(shopId, id) : null;
  if (existing && existing.status !== "DRAFT") throw new UserError("This campaign has already gone out. Copy it to send again.");
  const name = text(fd, "name");
  if (!name || name.length > 120) throw new UserError("Give the campaign a name (up to 120 characters).");
  const channelRaw = existing?.channel ?? text(fd, "channel");
  if (channelRaw !== "email" && channelRaw !== "sms") throw new UserError("Pick email or text.");
  const channel: Channel = channelRaw;
  let subject: string | null = null;
  let body = text(fd, "body");
  if (channel === "email") {
    subject = text(fd, "subject");
    if (!subject || subject.length > 150) throw new UserError("Give the email a subject (up to 150 characters).");
    if (/[\r\n]/.test(subject)) throw new UserError("The subject can't have line breaks.");
    if (/^(re|fw|fwd)\s*:/i.test(subject)) throw new UserError("Don't start the subject with RE: or FW: unless it's a real reply.");
    if (!body || body.length > 5000) throw new UserError("Write the email (up to 5000 characters).");
  } else {
    body = plainText(body).text;
    if (!body || body.length > 480) throw new UserError("Write the text (up to 480 characters).");
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true } });
    const parts = smsParts(`${shop.name}: ${body} Reply STOP to opt out.`).parts;
    if (parts > MAX_SMS_PARTS) throw new UserError(`That's more than ${MAX_SMS_PARTS} text parts. Shorten it.`);
  }
  checkTemplate(body, FIELDS.campaign);
  if (subject) checkTemplate(subject, FIELDS.campaign);
  const audience = parseAudience(fd);
  if (audience.kind === "class") {
    const cls = await db.shopClass.findFirst({ where: { id: audience.classId, shopId }, select: { id: true } });
    if (!cls) throw new UserError("Pick the class.");
  }
  if (existing) {
    await db.campaign.updateMany({ where: { id: existing.id, shopId, status: "DRAFT" }, data: { name, subject, body, audience } });
    return existing.id;
  }
  const made = await db.campaign.create({ data: { shopId, name, channel, subject, body, audience, createdById: user.id }, select: { id: true } });
  return made.id;
}

/** "Send me a test": to the admin's own address only, rendered with the sample values, sent now. */
export async function sendCampaignTestAs(user: CurrentUser, id: string, fd: FormData): Promise<string> {
  const shopId = user.shopId;
  const c = await ownCampaign(shopId, id);
  const channel = c.channel as Channel;
  const ms = await messagingView(shopId);
  const shop = await campaignShop(shopId, ms);
  let address: string;
  if (channel === "email") {
    const to = validEmail(text(fd, "to"));
    const own = [validEmail(user.email), ms.fromEmail, ms.replyTo].filter((a): a is string => !!a);
    if (!to || !own.includes(to)) throw new UserError("Test emails go only to your own login address, the From address or the Reply-to address.");
    address = to;
  } else {
    const to = toE164(text(fd, "to"));
    if (!to || !ms.testPhones.includes(to)) throw new UserError("Add your mobile number as a test number first (Settings -> Messages).");
    const w = wall(new Date(), shop.tz);
    const m = w.hour * 60 + w.minute;
    if (m < ms.quietStart || m >= ms.quietEnd) throw new UserError(`Texts can only go out between ${hm12(ms.quietStart)} and ${hm12(ms.quietEnd)}.`);
    address = to;
  }
  if (!allow(`test:${shopId}`, 10, 3_600_000)) throw new UserError("That's a lot of tests. Try again in an hour.");
  // The sample as a recipient sees it (the real footer; the unsubscribe wording without a live link).
  const sample = campaignSample(c, shop, null);
  const content = channel === "email" ? { subject: `[Test] ${sample.subject ?? ""}`.trim(), body: sample.body } : { body: `[Test] ${sample.body}` };
  const q = await queueToAddress(db, { shopId, kind: "test", channel, address, content, status: "SENDING", byUserId: user.id, campaignId: c.id });
  if (!q.id) throw new UserError(q.reason === "opted_out" ? "That address opted out of messages, so a test can't go there." : "The test couldn't be queued. Try again.");
  const r = await sendOneNow(q.id);
  if ("error" in r) throw new UserError(r.error);
  return r.detail || `Sent to ${address}.`;
}

/** "Send now" after the two-tap confirm: the checks of design 11.2, then the campaign starts building. */
export async function queueCampaignAs(user: CurrentUser, id: string, fd: FormData, now = new Date()): Promise<void> {
  const shopId = user.shopId;
  const c = await ownCampaign(shopId, id);
  if (c.status !== "DRAFT") throw new UserError("This campaign has already gone out. Copy it to send again.");
  const channel = c.channel as Channel;
  const ms = await messagingView(shopId);
  const shop = await campaignShop(shopId, ms);
  if (ms.marketingHoldAt) throw new UserError("Marketing is on hold since the backup was restored. Resume it on Messages first.");
  if (channel === "email") {
    if (!shop.postal) throw new UserError("Add the shop's postal address in Settings -> Messages. Marketing email must show it.");
    if (!ms.emailReady) throw new UserError("Email isn't set up yet (Settings -> Messages).");
    if ((isDesktop() || !ms.publicUrl) && !ms.replyWatched) throw new UserError("Marketing email needs a reply-to address someone reads every week (unsubscribes arrive there). Set it in Settings -> Messages.");
  } else {
    if (!ms.smsReady) throw new UserError("Texts aren't set up yet.");
    if (ms.textHoldAt) throw new UserError(`Marketing texts are on hold: ${ms.textHoldWhy ?? "see Messages"}. Release them on Messages first.`);
  }
  const started = await db.campaign.count({ where: { shopId, queuedAt: { gte: dayStart(ymdOf(now, shop.tz), shop.tz) } } });
  if (started >= MAX_CAMPAIGNS_PER_DAY) throw new UserError(`You've sent ${MAX_CAMPAIGNS_PER_DAY} campaigns today. Try again tomorrow.`);
  const members = await audienceMembers(shopId, audienceOf(c.audience), now);
  if (members.length > MAX_CAMPAIGN_MEMBERS) throw new UserError(`That's more than ${MAX_CAMPAIGN_MEMBERS} people. Narrow it down.`);
  const preview = await previewCampaign(shopId, c, now);
  const cap = channel === "email" ? ms.emailDailyCap : ms.smsDailyCap;
  if (preview.days > MAX_CAMPAIGN_DAYS) throw new UserError(`That would take more than a week at your limit of ${cap} a day. Narrow it down, or raise the limit in Settings -> Messages -> Rules.`);
  if (!preview.allowed) throw new UserError("Nobody in that group can get it (see why above).");
  const confirm = Number(text(fd, "confirm"));
  if (confirm !== preview.allowed) throw new UserError(`The list changed: it's now ${preview.allowed} ${preview.allowed === 1 ? "person" : "people"}. Check and tap again.`);
  const r = await db.campaign.updateMany({
    where: { id: c.id, shopId, status: "DRAFT" },
    data: { members: members.map((m) => m.customerId), built: 0, recipients: 0, skipped: {}, status: "QUEUING", queuedAt: now, queuedById: user.id },
  });
  if (!r.count) throw new UserError("This campaign has already gone out. Copy it to send again.");
  kickMessages();
}

/** "Cancel what hasn't gone out": the campaign and its waiting rows. */
export async function cancelCampaignAs(user: CurrentUser, id: string, now = new Date()): Promise<void> {
  const shopId = user.shopId;
  const c = await ownCampaign(shopId, id);
  if (c.status !== "QUEUING" && c.status !== "SENDING") throw new UserError("Only a campaign that is going out can be cancelled.");
  await db.$transaction([
    db.campaign.updateMany({ where: { id: c.id, shopId, status: { in: ["QUEUING", "SENDING"] } }, data: { status: "CANCELLED", finishedAt: now } }),
    db.outMessage.updateMany({ where: { shopId, campaignId: c.id, status: "QUEUED" }, data: { status: "CANCELLED", error: "Campaign cancelled", cancelledById: user.id } }),
  ]);
}

/** A new draft with the same wording and audience. Returns the new id. */
export async function copyCampaignAs(user: CurrentUser, id: string): Promise<string> {
  const shopId = user.shopId;
  const c = await ownCampaign(shopId, id);
  const made = await db.campaign.create({
    data: { shopId, name: `${c.name} (copy)`.slice(0, 120), channel: c.channel, subject: c.subject, body: c.body, audience: c.audience ?? {}, createdById: user.id },
    select: { id: true },
  });
  return made.id;
}

export async function deleteCampaignAs(user: CurrentUser, id: string): Promise<void> {
  const shopId = user.shopId;
  const c = await ownCampaign(shopId, id);
  if (c.status !== "DRAFT") throw new UserError("Only drafts can be deleted. Sent campaigns stay as your record.");
  await db.campaign.deleteMany({ where: { id: c.id, shopId, status: "DRAFT" } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Customer import

export type ImportRow = { name?: string; email?: string; phone?: string; unsubscribed?: string };
export type ImportResult = { added: number; matched: number; unsubscribed: number; problems: string[] };

const YES = /^(yes|y|true|1|x)$/i;

/**
 * A pasted or uploaded list of customers (design 11.2): matched to this shop's customers by email or phone (a missing
 * email / phone is filled in, nothing is overwritten), the rest made as RETAIL customers; "unsubscribed" rows get an
 * email marketing suppression. Text consent is never recorded by an import.
 */
export async function importCustomersAs(user: CurrentUser, rows: ImportRow[]): Promise<ImportResult> {
  const shopId = user.shopId;
  if (!Array.isArray(rows)) throw new UserError("Nothing to import.");
  if (rows.length > 5000) throw new UserError("Import at most 5000 at a time.");
  const existing = await db.customer.findMany({ where: { shopId }, select: { id: true, email: true, phone: true } });
  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();
  for (const c of existing) {
    const e = validEmail(c.email);
    const p = toE164(c.phone);
    if (e && !byEmail.has(e)) byEmail.set(e, c.id);
    if (p && !byPhone.has(p)) byPhone.set(p, c.id);
  }
  const out: ImportResult = { added: 0, matched: 0, unsubscribed: 0, problems: [] };
  let n = 0;
  for (const raw of rows) {
    n += 1;
    const name = String(raw?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const email = validEmail(String(raw?.email ?? ""));
    const phone = toE164(String(raw?.phone ?? ""));
    if (!name || (!email && !phone)) {
      out.problems.push(`Row ${n}: needs a name and an email or phone.`);
      continue;
    }
    let customerId = (email && byEmail.get(email)) || (phone && byPhone.get(phone)) || null;
    if (customerId) {
      const cur = existing.find((c) => c.id === customerId);
      const fill: { email?: string; phone?: string } = {};
      if (email && cur && !validEmail(cur.email)) fill.email = email;
      if (phone && cur && !toE164(cur.phone)) fill.phone = phone;
      if (Object.keys(fill).length) {
        await db.customer.updateMany({ where: { id: customerId, shopId }, data: fill });
        if (cur) Object.assign(cur, fill);
      }
      out.matched += 1;
    } else {
      const made = await db.customer.create({ data: { shopId, kind: "RETAIL", name, email, phone, notifyBy: "" }, select: { id: true } });
      customerId = made.id;
      existing.push({ id: made.id, email, phone });
      out.added += 1;
    }
    if (email) byEmail.set(email, customerId);
    if (phone) byPhone.set(phone, customerId);
    if (email && YES.test(String(raw?.unsubscribed ?? "").trim())) {
      await db.$transaction((tx) => suppress(tx, { shopId, channel: "email", address: email, scope: "marketing", source: "import", customerId, byUserId: user.id }));
      out.unsubscribed += 1;
    }
  }
  return out;
}
