// Message wording and merge fields (scheduling-messaging-design.md section 5). Pure.
import { UserError } from "@/lib/user-error";
import type { Channel } from "./types";

export const COMMON_FIELDS = ["first_name", "name", "shop_name", "shop_phone"] as const;

export const FIELDS: Record<string, string[]> = {
  ready: [...COMMON_FIELDS, "machine", "ref", "amount_line"],
  reminder: [...COMMON_FIELDS, "what", "when", "location_line", "supplies_line"],
  class_signup: [...COMMON_FIELDS, "what", "when", "location_line", "supplies_line", "fee_line"],
  booking: [...COMMON_FIELDS, "what", "when", "location_line", "fee_line"],
  estimate: [...COMMON_FIELDS, "machine", "ref", "total", "estimate_link", "estimate_lines", "note_line"],
  estimate_nolink: [...COMMON_FIELDS, "machine", "ref", "total", "estimate_lines", "note_line"],
  abandon: [...COMMON_FIELDS, "machine", "ref", "ready_date", "abandon_date", "storage_fee"],
  abandon_final: [...COMMON_FIELDS, "machine", "ref", "ready_date", "abandon_date", "storage_fee"],
  service_due: [...COMMON_FIELDS, "machine", "months"],
  review: [...COMMON_FIELDS, "review_link"],
  bags_due: [...COMMON_FIELDS, "machine", "months", "bag_line"],
  parts_in: [...COMMON_FIELDS, "machine", "ref", "parts", "eta_line"],
  order_paid: [...COMMON_FIELDS, "order", "items", "total", "short_line", "fulfil_line", "order_link"],
  order_ready: [...COMMON_FIELDS, "order", "items", "pickup_line", "order_link"],
  order_shipped: [...COMMON_FIELDS, "order", "items", "tracking_line", "order_link"],
  order_cancelled: [...COMMON_FIELDS, "order", "refund_line", "order_link"],
  pay_link: [...COMMON_FIELDS, "items", "total", "order_link", "until", "note_line"],
  order_delay: [...COMMON_FIELDS, "what", "until"],
  event_balance: [...COMMON_FIELDS, "what", "total", "until"],
  consent_confirm: ["shop_name", "shop_phone"],
  help_reply: ["shop_name", "shop_phone"],
  campaign: [...COMMON_FIELDS, "machine", "upcoming_classes"],
  class_notice: [...COMMON_FIELDS, "class_title"],
};

/** Values that may carry links or come from the shop's own settings: not cleaned. Everything else is cleanText()'d. */
export const TRUSTED_FIELDS = ["shop_name", "shop_phone", "estimate_link", "review_link", "upcoming_classes", "total", "storage_fee", "order_link", "items"];

const FULL_KEYS = ["ready", "reminder", "class_signup", "booking", "estimate", "estimate_nolink", "abandon", "abandon_final", "service_due", "review", "bags_due", "parts_in", "order_paid", "order_ready", "order_shipped", "order_cancelled", "pay_link", "order_delay", "event_balance"];
export const TEMPLATE_KEYS: string[] = [...FULL_KEYS.flatMap((k) => [`${k}.sms`, `${k}.email`, `${k}.subject`]), "consent_confirm.sms", "help_reply.sms"];

export const DEFAULT_TEMPLATES: Record<string, string> = {
  "ready.sms": "Hi {first_name}, your {machine} is ready to pick up.{amount_line} Questions? Call {shop_phone}.",
  "ready.subject": "Your {machine} is ready",
  "ready.email": "Hi {first_name},\n\nYour {machine} ({ref}) is ready to pick up.{amount_line}\n\nQuestions? Call us at {shop_phone}.",
  "reminder.sms": "Reminder: {what} on {when}.{location_line} Can't make it? Call {shop_phone}.",
  "reminder.subject": "Reminder: {what} on {when}",
  "reminder.email": "Hi {first_name},\n\nA reminder: {what} on {when}.{location_line}{supplies_line}\n\nCan't make it? Please call us at {shop_phone}.",
  "class_signup.sms": "You're signed up: {what}, starting {when}.{location_line}{fee_line} Questions? Call {shop_phone}.",
  "class_signup.subject": "You're signed up: {what}",
  "class_signup.email": "Hi {first_name},\n\nYou're signed up for {what}, starting {when}.{location_line}{fee_line}{supplies_line}\n\nQuestions? Call us at {shop_phone}.",
  "booking.sms": "Booked: {what} on {when}.{location_line} Can't make it? Call {shop_phone}.",
  "booking.subject": "Booked: {what} on {when}",
  "booking.email": "Hi {first_name},\n\nYou're booked: {what} on {when}.{location_line}{fee_line}\n\nCan't make it? Please call us at {shop_phone}.",
  "estimate.sms": "Hi {first_name}, the estimate for your {machine} is {total}. See it and approve or decline here: {estimate_link}",
  "estimate.subject": "Estimate for your {machine}: {total}",
  "estimate.email": "Hi {first_name},\n\nWe've looked at your {machine} ({ref}). The estimate is {total}:\n\n{estimate_lines}\n\n{note_line}See it and approve or decline here: {estimate_link}\n\nOr call us at {shop_phone}.",
  "estimate_nolink.sms": "Hi {first_name}, the estimate for your {machine} is {total}. Call {shop_phone} or reply to this text to approve or decline.",
  "estimate_nolink.subject": "Estimate for your {machine}: {total}",
  "estimate_nolink.email": "Hi {first_name},\n\nWe've looked at your {machine} ({ref}). The estimate is {total}:\n\n{estimate_lines}\n\n{note_line}Call us at {shop_phone} or reply to this email to approve or decline.",
  "abandon.sms": "Hi {first_name}, your {machine} has been ready since {ready_date}. Please pick it up by {abandon_date}; after that a storage fee of {storage_fee} applies. Call {shop_phone}.",
  "abandon.subject": "Please pick up your {machine}",
  "abandon.email": "Hi {first_name},\n\nYour {machine} ({ref}) has been ready to pick up since {ready_date}.\n\nPlease pick it up by {abandon_date}. After that a storage fee of {storage_fee} applies and the machine may be treated as abandoned under our policy.\n\nNeed more time? Call us at {shop_phone}.",
  "abandon_final.sms": "FINAL NOTICE: {first_name}, your {machine} has been ready since {ready_date}. If it isn't picked up by {abandon_date} it will be treated as abandoned. Call {shop_phone}.",
  "abandon_final.subject": "Final notice: your {machine}",
  "abandon_final.email": "Hi {first_name},\n\nThis is our final notice. Your {machine} ({ref}) has been ready since {ready_date}.\n\nIf it isn't picked up by {abandon_date}, it will be treated as abandoned under our policy and the storage fee of {storage_fee} applies.\n\nPlease call us at {shop_phone}.",
  "service_due.sms": "Hi {first_name}, it's been about {months} months since your {machine} was serviced. Time for a tune-up? Call {shop_phone}.",
  "service_due.subject": "Time for a tune-up on your {machine}?",
  "service_due.email": "Hi {first_name},\n\nIt's been about {months} months since we serviced your {machine}. A yearly cleaning and tune-up keeps it running smoothly.\n\nCall us at {shop_phone} to bring it in.",
  "review.sms": "Thanks for coming in, {first_name}! If you have a minute, a review helps a small shop a lot: {review_link}",
  "review.subject": "How did we do?",
  "review.email": "Hi {first_name},\n\nThanks for coming in. If you have a minute, a short review helps a small shop a lot:\n\n{review_link}\n\nThank you!",
  // modules-design.md 12.4 #1: right after a vacuum sale too, so no "since you got bags".
  "bags_due.sms": "Hi {first_name}, time for new bags for your {machine}?{bag_line} Call {shop_phone} or stop by.",
  "bags_due.subject": "Time for new bags for your {machine}?",
  "bags_due.email": "Hi {first_name},\n\nIt's about time for new bags for your {machine}.{bag_line}\n\nCall us at {shop_phone} or stop by.",
  // online-and-parts-design.md section 1: the part the shop had to order came in.
  "parts_in.sms": "Hi {first_name}, the part for your {machine} ({ref}) came in: {parts}.{eta_line} We'll be in touch when it's ready.",
  "parts_in.subject": "The part for your {machine} is in",
  "order_paid.sms": "Thanks, {first_name}! We have your order {order} ({total}).{short_line}{fulfil_line} Details: {order_link}",
  "order_paid.subject": "Your order {order}",
  "order_paid.email": "Hi {first_name},\n\nThanks for your order {order}:\n\n{items}\n\nTotal: {total}.{short_line}{fulfil_line}\n\nDetails: {order_link}\n\nQuestions? Call us at {shop_phone}.",
  "order_ready.sms": "Hi {first_name}, your order {order} is ready to pick up.{pickup_line} Details: {order_link}",
  "order_ready.subject": "Your order {order} is ready to pick up",
  "order_ready.email": "Hi {first_name},\n\nYour order {order} is ready to pick up:\n\n{items}\n\n{pickup_line}\n\nDetails: {order_link}\n\nQuestions? Call us at {shop_phone}.",
  "order_shipped.sms": "Hi {first_name}, your order {order} has shipped.{tracking_line} Details: {order_link}",
  "order_shipped.subject": "Your order {order} has shipped",
  "order_shipped.email": "Hi {first_name},\n\nYour order {order} is on its way:\n\n{items}\n\n{tracking_line}\n\nDetails: {order_link}\n\nQuestions? Call us at {shop_phone}.",
  "order_cancelled.sms": "Hi {first_name}, your order {order} was cancelled.{refund_line} Questions? Call {shop_phone}.",
  "order_cancelled.subject": "Your order {order} was cancelled",
  "pay_link.sms": "Hi {first_name}, here is your link to pay {total}: {order_link} (until {until}).{note_line} Questions? Call {shop_phone}.",
  "pay_link.subject": "Your link to pay {total}",
  "order_delay.sms": "Hi {first_name}, the {what} you're waiting for is delayed: the supplier now expects it about {until}. We'll let you know when it's here. Questions? Call {shop_phone}.",
  "order_delay.subject": "Your {what} is delayed",
  "event_balance.sms": "Hi {first_name}, a reminder: the balance of {total} for {what} is due by {until}. Pay at the shop or call {shop_phone}.",
  "event_balance.subject": "{what}: your balance of {total} is due by {until}",
  "event_balance.email": "Hi {first_name},\n\nA reminder: the balance of {total} for {what} is due by {until}.\n\nYou can pay at the shop, or call us at {shop_phone} and we'll send you a link to pay by card.",
  "order_delay.email": "Hi {first_name},\n\nThe {what} you're waiting for is delayed: the supplier now expects it about {until}.\n\nWe'll let you know as soon as it's here. Questions? Call us at {shop_phone}.",
  "pay_link.email": "Hi {first_name},\n\nHere is your link to pay {total} by card:\n\n{items}\n\n{order_link}\n\nThe link works until {until}.{note_line}\n\nQuestions? Call us at {shop_phone}.",
  "order_cancelled.email": "Hi {first_name},\n\nYour order {order} was cancelled.{refund_line}\n\nDetails: {order_link}\n\nQuestions? Call us at {shop_phone}.",
  "parts_in.email": "Hi {first_name},\n\nThe part we ordered for your {machine} ({ref}) came in: {parts}.{eta_line}\n\nWe'll let you know when it's ready to pick up.",
  "consent_confirm.sms": "You're signed up for texts from {shop_name}. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel.",
  "help_reply.sms": "{shop_name}: for help call {shop_phone}. Msg & data rates may apply. Reply STOP to opt out.",
};

/** Sample values for previews and "Send me a sample". */
export const SAMPLE_VARS: Record<string, string> = {
  first_name: "Mary",
  name: "Mary Smith",
  shop_name: "Your Shop",
  shop_phone: "(555) 123-4567",
  machine: "Janome MC6700P",
  ref: "ticket 0123",
  amount_line: " Balance: $145.00.",
  what: "Beginning Quilting (meeting 2 of 4)",
  when: "Tue, Oct 7 at 6:00 pm",
  location_line: " At the shop classroom.",
  supplies_line: "\n\nBring: fabric scissors and a rotary cutter",
  fee_line: " Fee: $45.00, paid at the counter.",
  total: "$145.00",
  estimate_link: "https://example.com/e/sample",
  estimate_lines: "Clean, oil and adjust  $129.00\nBobbin case  $16.00",
  note_line: "The hook timing was off and the bobbin case is cracked.\n\n",
  ready_date: "Sep 30, 2026",
  abandon_date: "Nov 29, 2026",
  storage_fee: "$45.00",
  months: "12",
  review_link: "https://g.page/r/your-shop/review",
  bag_line: " We have Hoover Type Y bags in stock.",
  upcoming_classes: "Beginning Quilting · Tue, Oct 7 at 6:00 pm · 3 seats left · $45.00",
  class_title: "Beginning Quilting",
  parts: "a bobbin case and a feed dog assembly",
  eta_line: " We expect to have it done by Oct 9.",
  order: "#1001",
  items: "Bobbin case (Janome 102261103) x 1  $16.00\nSchmetz 90/14 needles x 2  $11.90",
  fulfil_line: " We'll let you know when it's ready to pick up.",
  pickup_line: "Come to the counter with your order number.",
  tracking_line: " Tracking: 9400 1000 0000 0000 0000 00.",
  refund_line: " $27.90 goes back to your card in a few days.",
  short_line: " One item was out of stock; $11.90 goes back to your card in a few days.",
  order_link: "https://example.com/shop/o/sample",
  until: "Oct 21",
};

/** The saved wording for a key, or the default. */
export function templateFor(ms: { templates: unknown }, key: string): string {
  const t = ms.templates;
  if (t && typeof t === "object" && !Array.isArray(t)) {
    const v = (t as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return DEFAULT_TEMPLATES[key] ?? "";
}

/**
 * Merge values that came from customers, staff or partners: control characters, CR/LF and tabs become spaces, runs of
 * spaces collapse, links are replaced by "[link removed]", cut to `max`.
 */
export function cleanText(v: string | null | undefined, max = 500): string {
  if (v == null) return "";
  return String(v)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removed]")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, max);
}

/** ONE pass over the template: a value is never re-scanned, so "{estimate_link}" typed into a name stays literal. */
export function render(tpl: string, vars: Record<string, string>): string {
  const out = tpl.replace(/\{([a-z_]+)\}/g, (_, k: string) => {
    if (!Object.hasOwn(vars, k)) return "";
    const v = vars[k] ?? "";
    if (TRUSTED_FIELDS.includes(k)) return v;
    // The "_line" fields our code builds start with their own separator (a space, or a blank line): keep it, the
    // cleaning (which trims) is for what follows.
    const lead = /^[ \n]{0,2}/.exec(v)?.[0] ?? "";
    return lead + cleanText(v, 2000);
  });
  return out.replace(/\n{3,}/g, "\n\n");
}

/** UserError("Unknown field {x}. You can use: {a}, {b}.") for a field the kind doesn't have. */
export function checkTemplate(tpl: string, allowedFields: readonly string[]): void {
  const used = [...tpl.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
  const bad = used.find((k) => !allowedFields.includes(k));
  if (bad) throw new UserError(`Unknown field {${bad}}. You can use: ${allowedFields.map((f) => `{${f}}`).join(", ")}.`);
}

export type Content = { subject?: string | null; body: string };

/** A kind's wording for one channel, rendered (without the prefix or footer finalize adds). */
export function renderKind(ms: { templates: unknown }, key: string, channel: Channel, vars: Record<string, string>): Content {
  if (channel === "sms") return { body: render(templateFor(ms, `${key}.sms`), vars) };
  return { subject: cleanSubject(render(templateFor(ms, `${key}.subject`), vars)), body: render(templateFor(ms, `${key}.email`), vars) };
}

/** After merge fields are filled: one line, no control characters, at most 150 characters (CAN-SPAM honest subject). */
export function cleanSubject(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 150);
}

// GSM-7 basic set plus its extension characters (which count double).
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

/** How many text parts a body takes: GSM-7 160 (153 each when split), UCS-2 70 (67 each). */
export function smsParts(text: string): { parts: number; unicode: boolean } {
  let unicode = false;
  let units = 0;
  for (const ch of text) {
    if (GSM.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else {
      unicode = true;
      break;
    }
  }
  if (unicode) {
    // UTF-16 code units (an emoji is two).
    const n = text.length;
    return { parts: n <= 70 ? (n ? 1 : 0) : Math.ceil(n / 67), unicode: true };
  }
  return { parts: units <= 160 ? (units ? 1 : 0) : Math.ceil(units / 153), unicode: false };
}

const PLAIN: [RegExp, string][] = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[–—―−]/g, "-"],
  [/…/g, "..."],
  [/[   ]/g, " "],
  [/•/g, "*"],
];

/** Curly quotes, dashes, ellipses and hard spaces as plain characters, so texts stay one part. */
export function plainText(s: string): { text: string; changed: boolean } {
  let text = s;
  for (const [re, to] of PLAIN) text = text.replace(re, to);
  return { text, changed: text !== s };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Plain text as a simple HTML email: everything escaped, paragraphs on blank lines, http(s) URLs linked (every URL left
 * in the text came from the shop's own templates and trusted fields), a "--" footer in small grey.
 */
export function textToHtml(text: string): string {
  const [main, ...footer] = text.split(/\n--\n/);
  const para = (block: string) =>
    block
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => `<p>${esc(p).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}">${u}</a>`)}</p>`)
      .join("\n");
  const body = para(main);
  const foot = footer.length ? `<div style="margin-top:24px;font-size:12px;color:#777">${para(footer.join("\n--\n"))}</div>` : "";
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">${body}${foot}</body></html>`;
}

const TITLES = /^(mr|mrs|ms|miss|dr|mx)\.?$/i;

/** "SMITH, MARY" -> "Mary"; skips Mr / Mrs / Ms / Miss / Dr / Mx; capitalises an all-caps name; "" -> "there". */
export function firstName(name: string): string {
  const raw = String(name ?? "").trim();
  if (!raw) return "there";
  let words: string[];
  if (raw.includes(",")) {
    // "Last, First Middle": the first word after the comma.
    words = raw.split(",")[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (!words.length) words = raw.split(",")[0].trim().split(/\s+/);
  } else words = raw.split(/\s+/).filter(Boolean);
  while (words.length > 1 && TITLES.test(words[0])) words.shift();
  const w = words[0] ?? "";
  if (!w) return "there";
  const clean = w.replace(/[^\p{L}\p{M}'-]/gu, "");
  if (!clean) return "there";
  return clean === clean.toUpperCase() && clean.length > 1 ? clean[0] + clean.slice(1).toLowerCase() : clean;
}
