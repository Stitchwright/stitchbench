import "server-only";
// Customer answers (shop-features-round-2-design.md 5.6): the shop's public page answers "Is my machine ready?" (ticket
// number and the last four digits of the phone on it, both must match), hours, classes with seats and drop-off times,
// with the program's fixed wording from the shop's own records: never a price, a diagnosis or a promise. Off until the
// shop turns it on (Settings → Customer questions). Typed questions (with the Assistant) are only sorted by the model
// into one of those, or "for a person", which saves the question to the Customer questions list; at most
// customerDailyCap a day, counted against the allowance. The phone-answering service's status link reads the same
// answers with the shop's private key (src/app/api/public/v1). No session on the public side: the slug names the shop
// and every query filters by its id.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { hoursOf } from "@/lib/appointments";
import { assistantAvailable, runAssistant } from "@/lib/assistant/client";
import { namesToBlank } from "@/lib/assistant/redact";
import { baseWritable } from "@/lib/base-gate";
import { kindOf } from "@/lib/equipment/shop";
import { publicClasses, publicFreeTimes, publicShop, publicTypes, SLUG_RE } from "@/lib/online-booking";
import type { CurrentUser } from "@/lib/session";
import { startOfToday } from "@/lib/time-zone";
import { UserError } from "@/lib/user-error";
import { fmtDay, fmtTime, fmtWhen } from "@/lib/zoned";
import { buildSortQuestion, hoursWords, last4Of, NOT_FOUND_STATUS, parseSort, PASSED_ON, statusWords, ticketNumberOf, type Topic } from "@/lib/customer-answers-words";

export type AnswersShop = {
  id: string;
  name: string;
  phone: string | null;
  timeZone: string;
  slug: string;
  /** Customer answers switched on (and the program not read-only). */
  on: boolean;
  cap: number;
  openHours: unknown;
  hoursNote: string | null;
  statusKeyHash: string | null;
};

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const callUs = (s: { phone: string | null }) => (s.phone ? `Call us at ${s.phone}.` : "Please call the shop.");

/** The shop a public slug names, with its answers settings; null for none. */
export async function answersShop(slug: string): Promise<AnswersShop | null> {
  if (!SLUG_RE.test(String(slug ?? ""))) return null;
  const s = await db.shop.findUnique({ where: { bookingSlug: slug }, select: { id: true, name: true, phone: true, timeZone: true, bookingSlug: true, openHours: true, hoursNote: true, statusKeyHash: true, assistantSettings: { select: { customerOn: true, customerDailyCap: true } } } });
  if (!s) return null;
  const on = !!s.assistantSettings?.customerOn && (await baseWritable(s.id));
  return { id: s.id, name: s.name, phone: s.phone, timeZone: s.timeZone, slug: s.bookingSlug!, on, cap: s.assistantSettings?.customerDailyCap ?? 20, openHours: s.openHours, hoursNote: s.hoursNote, statusKeyHash: s.statusKeyHash };
}

/** Is my machine ready: the ticket number and the last four digits of the phone on it must both match; either wrong says the same. */
export async function statusAnswer(shop: Pick<AnswersShop, "id" | "timeZone" | "phone">, ticketIn: unknown, phoneIn: unknown): Promise<{ answer: string; found: boolean }> {
  const number = ticketNumberOf(ticketIn);
  const last4 = last4Of(String(phoneIn ?? ""));
  if (!number || !last4) return { answer: "Enter the ticket number and the last four digits of the phone number on it.", found: false };
  const t = await db.ticket.findFirst({ where: { shopId: shop.id, number }, select: { number: true, status: true, closedAt: true, customer: { select: { phone: true } }, machine: { select: { equipment: true, kind: true } } } });
  if (!t || last4Of(t.customer?.phone) !== last4) return { answer: NOT_FOUND_STATUS, found: false };
  const kind = await kindOf(shop.id, t.machine);
  return { answer: statusWords({ status: t.status, number: t.number, noun: kind.noun, closedOn: t.closedAt ? fmtDay(t.closedAt, shop.timeZone) : null }), found: true };
}

export function hoursAnswer(shop: Pick<AnswersShop, "openHours" | "hoursNote" | "phone">): string {
  const words = hoursWords(hoursOf(shop.openHours));
  const none = shop.phone ? `Call us at ${shop.phone} for our hours.` : "Please call the shop for our hours.";
  return [words ?? none, shop.hoursNote?.trim() ?? ""].filter(Boolean).join(" ");
}

export type ClassSeat = { title: string; starts: string | null; seatsLeft: number };

/** Classes taking sign-ups online with seats left: title, when, seats. Never the fee. */
export async function classesAnswer(shop: Pick<AnswersShop, "id" | "timeZone" | "phone" | "slug">): Promise<{ answer: string; classes: ClassSeat[] }> {
  const classes = (await publicClasses(shop.id)).filter((c) => c.seatsLeft > 0).slice(0, 10);
  if (!classes.length) return { answer: `No class has seats open right now. ${callUs(shop)}`, classes: [] };
  const rows = classes.map((c) => ({ title: c.title, starts: c.next ? fmtWhen(c.next, shop.timeZone) : c.firstAt ? fmtWhen(c.firstAt, shop.timeZone) : null, seatsLeft: c.seatsLeft }));
  return { answer: `Classes with seats: ${rows.map((r) => `${r.title}${r.starts ? `, ${r.starts}` : ""} (${r.seatsLeft} seat${r.seatsLeft === 1 ? "" : "s"} left)`).join("; ")}.`, classes: rows };
}

export type DropoffType = { id: string; name: string; minutes: number; times: string[] };

/** The next open times for what can be booked online (at most three kinds, six times each). */
export async function dropoffAnswer(shop: Pick<AnswersShop, "slug" | "phone" | "timeZone">): Promise<{ answer: string; types: DropoffType[]; bookingOpen: boolean }> {
  const p = await publicShop(shop.slug);
  if (!p?.open) return { answer: `${callUs(shop)} We'll find a time for you to bring it in.`, types: [], bookingOpen: false };
  const types = (await publicTypes(p.id)).slice(0, 3);
  const out: DropoffType[] = [];
  for (const t of types) {
    const days = await publicFreeTimes(p, t, null);
    out.push({ id: t.id, name: t.name, minutes: t.minutes, times: days.flatMap((d) => d.starts).slice(0, 6).map((d) => d.toISOString()) });
  }
  const open = out.filter((t) => t.times.length);
  if (!open.length) return { answer: `Nothing is open to book online in the next two weeks. ${callUs(shop)}`, types: out, bookingOpen: true };
  return {
    answer: `Next open times: ${open.map((t) => `${t.name}: ${t.times.slice(0, 3).map((x) => `${fmtDay(new Date(x), shop.timeZone)} at ${fmtTime(new Date(x), shop.timeZone)}`).join(", ")}`).join("; ")}.`,
    types: out,
    bookingOpen: true,
  };
}

/** Typed questions answered today (sorted by the model), in the shop's day. */
export async function typedToday(shop: Pick<AnswersShop, "id" | "timeZone">): Promise<number> {
  return db.assistantCall.count({ where: { shopId: shop.id, feature: "customer_question", createdAt: { gte: startOfToday(shop.timeZone) } } });
}

export type TypedResult = { topic: Topic | null; ticket: number | null; answer: string };

export const BUTTONS_ONLY = "We can't take typed questions right now. Use the buttons, or leave your question for us.";

/**
 * A typed question: the model sorts it into a topic (and a ticket number), the program answers it from the records.
 * Over the day's cap, without the Assistant, or if the hub fails: the buttons only, and no call (or one failed call).
 */
export async function typedQuestion(shop: AnswersShop, text: string): Promise<TypedResult> {
  if (!shop.on) throw new UserError("Questions aren't answered here.");
  const q = String(text ?? "").trim();
  if (q.length < 3) throw new UserError("Type your question first.");
  if (q.length > 500) throw new UserError("Keep the question short (500 characters).");
  const avail = await assistantAvailable(shop.id, { group: "customers" });
  if (!avail.ok || (await typedToday(shop)) >= shop.cap) return { topic: null, ticket: null, answer: BUTTONS_ONLY };
  const everyone = await db.customer.findMany({ where: { shopId: shop.id }, select: { name: true }, take: 5000 });
  let sorted: { topic: Topic; ticket: number | null };
  try {
    const { text: answer } = await runAssistant({ shopId: shop.id, userId: null, built: buildSortQuestion(q, { names: namesToBlank({ allCustomers: everyone.map((c) => c.name) }) }) });
    sorted = parseSort(answer);
  } catch {
    return { topic: null, ticket: null, answer: BUTTONS_ONLY };
  }
  switch (sorted.topic) {
    case "status":
      return { ...sorted, answer: sorted.ticket ? `To check ticket #${sorted.ticket}, enter the last four digits of the phone number on it.` : "Enter your ticket number and the last four digits of the phone number on it." };
    case "hours":
      return { ...sorted, answer: hoursAnswer(shop) };
    case "classes":
      return { ...sorted, answer: (await classesAnswer(shop)).answer };
    case "dropoff":
      return { ...sorted, answer: (await dropoffAnswer(shop)).answer };
    default:
      return { ...sorted, answer: "This one is for a person. Leave your name and a phone number or email, and we'll get back to you." };
  }
}

/** "For a person": the question, her name and how to reach her, on the shop's Customer questions list. */
export async function leaveQuestion(shop: AnswersShop, o: { name?: unknown; contact?: unknown; text?: unknown }): Promise<string> {
  if (!shop.on) throw new UserError("Questions aren't answered here.");
  const text = String(o.text ?? "").trim().slice(0, 1000);
  const name = String(o.name ?? "").trim().slice(0, 120) || null;
  const contact = String(o.contact ?? "").trim().slice(0, 120);
  if (text.length < 3) throw new UserError("Type your question first.");
  if (!/@/.test(contact) && contact.replace(/\D/g, "").length < 7) throw new UserError("Leave a phone number or email so we can get back to you.");
  const open = await db.customerQuestion.count({ where: { shopId: shop.id, handledAt: null } });
  if (open >= 500) throw new UserError(`We have a lot of questions waiting. ${callUs(shop)}`);
  await db.customerQuestion.create({ data: { shopId: shop.id, name, contact, text } });
  return PASSED_ON;
}

// ----- staff: the list and the settings -----

export async function questionsFor(shopId: string) {
  const [open, done] = await Promise.all([
    db.customerQuestion.findMany({ where: { shopId, handledAt: null }, orderBy: { at: "desc" }, take: 200 }),
    db.customerQuestion.findMany({ where: { shopId, handledAt: { not: null } }, orderBy: { handledAt: "desc" }, take: 30 }),
  ]);
  return { open, done };
}

/** Mark a question answered (or back to waiting: the Undo). */
export async function markQuestionFor(user: Pick<CurrentUser, "shopId" | "name">, id: string, handled: boolean): Promise<void> {
  const r = await db.customerQuestion.updateMany({ where: { id: String(id), shopId: user.shopId }, data: handled ? { handledAt: new Date(), handledBy: user.name?.slice(0, 80) ?? null } : { handledAt: null, handledBy: null } });
  if (!r.count) throw new UserError("Question not found.");
}

const admin = (user: Pick<CurrentUser, "role">) => {
  if (user.role === "TECH") throw new UserError("Only the owner or an admin can change this.");
};

export async function saveCustomerAnswersFor(user: Pick<CurrentUser, "shopId" | "role">, o: { on: boolean; cap: unknown; hours: { day: number; from: string; to: string }[]; hoursNote: unknown }): Promise<void> {
  admin(user);
  const cap = Math.round(Number(o.cap));
  if (!Number.isFinite(cap) || cap < 0 || cap > 200) throw new UserError("Typed questions a day: 0 to 200.");
  const hoursNote = String(o.hoursNote ?? "").trim().slice(0, 200) || null;
  await db.$transaction([
    db.assistantSettings.upsert({ where: { shopId: user.shopId }, create: { shopId: user.shopId, customerOn: o.on, customerDailyCap: cap }, update: { customerOn: o.on, customerDailyCap: cap } }),
    db.shop.update({ where: { id: user.shopId }, data: { openHours: o.hours, hoursNote } }),
  ]);
}

/** A new private key for the phone-answering service: shown once; the old one stops working. */
export async function makeStatusKeyFor(user: Pick<CurrentUser, "shopId" | "role">): Promise<string> {
  admin(user);
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { bookingSlug: true } });
  if (!shop.bookingSlug) throw new UserError("Set your booking page address first (Settings → Online booking): the status link uses it.");
  const key = `sbk_${crypto.randomBytes(24).toString("base64url")}`;
  await db.shop.update({ where: { id: user.shopId }, data: { statusKeyHash: sha256(key), statusKeyAt: new Date() } });
  return key;
}

export async function removeStatusKeyFor(user: Pick<CurrentUser, "shopId" | "role">): Promise<void> {
  admin(user);
  await db.shop.update({ where: { id: user.shopId }, data: { statusKeyHash: null, statusKeyAt: null } });
}

/** The shop for the status link: the slug's shop when the key matches its hash (in constant time), else null. */
export async function shopForKey(slug: string, key: string | null): Promise<AnswersShop | null> {
  const shop = await answersShop(slug);
  if (!shop?.statusKeyHash || !key || !/^sbk_[A-Za-z0-9_-]{20,60}$/.test(key)) return null;
  const a = Buffer.from(sha256(key), "hex");
  const b = Buffer.from(shop.statusKeyHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!(await baseWritable(shop.id))) return null;
  return shop;
}
