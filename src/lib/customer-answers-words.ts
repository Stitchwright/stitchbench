// Customer answers (shop-features-round-2-design.md 5.6): the program's fixed wording for each answer, and the typed
// question's sorting request. Pure: no database. Answers come only from the shop's own records and never carry a price,
// a diagnosis or a promise; the model never writes an answer, it only sorts a question into one of the topics.
import type { TicketStatus } from "@/generated/prisma/enums";
import { jsonOf, type Built } from "@/lib/assistant/prompts";
import { redact, type Redaction } from "@/lib/assistant/redact";

export const TOPICS = ["status", "hours", "classes", "dropoff", "person"] as const;
export type Topic = (typeof TOPICS)[number];

export const NOT_FOUND_STATUS = "We couldn't find a ticket with that number and phone number. Check both, or call us.";
export const PASSED_ON = "Thanks. We'll get back to you.";

/** The last four digits typed, or null: "1234", "(555) 123-1234" -> "1234". */
export function last4Of(s: string | null | undefined): string | null {
  const d = String(s ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}

/** A ticket number as typed ("#0051", "51", "ticket 51") or null. */
export function ticketNumberOf(s: unknown): number | null {
  const m = /(\d{1,7})/.exec(String(s ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Where a machine is, in a sentence: no price, no diagnosis, no promise of a date. */
export function statusWords(o: { status: TicketStatus; number: number; noun: string; closedOn: string | null }): string {
  const it = `Your ${o.noun} (ticket #${o.number})`;
  switch (o.status) {
    case "READY_FOR_PICKUP":
      return `${it} is ready for pickup.`;
    case "READY_IN_TRUCK":
      return `${it} is ready. We'll be in touch about bringing it back to you.`;
    case "WAITING_PARTS":
      return `${it} is waiting for a part. We'll let you know when it's ready.`;
    case "WAITING_CUSTOMER_OK":
      return `${it} is waiting for your OK on our estimate. Please call us.`;
    case "IN_TRUCK":
      return `${it} is on its way to our shop.`;
    case "ON_BENCH":
    case "AT_SHOP_AWAITING_PICKUP":
      return `${it} is with us and being worked on. We'll let you know when it's ready.`;
    case "COLLECTED":
      return `${it} was picked up${o.closedOn ? ` on ${o.closedOn}` : ""}.`;
    case "RETURNED_UNREPAIRED":
      return `${it} was returned${o.closedOn ? ` on ${o.closedOn}` : ""}.`;
    default:
      return `Please call us about your ${o.noun} (ticket #${o.number}).`;
  }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const time12 = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${ap}` : `${h12} ${ap}`;
};

/** "Tuesday to Saturday, 10 am to 5 pm; Sunday, noon"-style words for the opening hours, or null when none are set. */
export function hoursWords(hours: { day: number; from: string; to: string }[]): string | null {
  if (!hours.length) return null;
  const byWindow = new Map<string, number[]>();
  for (const w of [...hours].sort((a, b) => a.day - b.day)) byWindow.set(`${w.from}-${w.to}`, [...(byWindow.get(`${w.from}-${w.to}`) ?? []), w.day]);
  const parts: string[] = [];
  for (const [win, days] of byWindow) {
    const runs: string[] = [];
    for (let i = 0; i < days.length; ) {
      let j = i;
      while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++;
      runs.push(j - i >= 2 ? `${DAY_NAMES[days[i]]} to ${DAY_NAMES[days[j]]}` : days.slice(i, j + 1).map((d) => DAY_NAMES[d]).join(" and "));
      i = j + 1;
    }
    const [from, to] = win.split("-");
    parts.push(`${runs.join(", ")}, ${time12(from)} to ${time12(to)}`);
  }
  return `We're open ${parts.join("; ")}.`;
}

export const SORT_SYSTEM = `You sort a customer's question to a sewing and vacuum shop into one topic. You never answer it.
Topics: "status" (is my machine or repair ready, where is it), "hours" (when are you open), "classes" (classes, seats, sign-ups), "dropoff" (booking a time to drop off or bring in a machine), "person" (anything else, including prices, what is wrong with a machine, advice, complaints).
If the customer gives a ticket or repair number, copy it as digits.
Answer with JSON only: {"topic":"status","ticket":null}`;

export function buildSortQuestion(text: string, r: Redaction): Built {
  return {
    feature: "customer_question",
    cls: "suggest",
    system: SORT_SYSTEM,
    messages: [{ role: "user", content: `Question: ${redact(String(text ?? "").trim().replace(/\s+/g, " ").slice(0, 500), r)}` }],
    maxTokens: 60,
  };
}

/** The topic (anything unclear goes to a person) and a ticket number when one was given. */
export function parseSort(text: string): { topic: Topic; ticket: number | null } {
  const j = jsonOf(text) as { topic?: unknown; ticket?: unknown } | null;
  const topic = j && typeof j.topic === "string" && (TOPICS as readonly string[]).includes(j.topic) ? (j.topic as Topic) : "person";
  return { topic, ticket: j ? ticketNumberOf(j.ticket) : null };
}
