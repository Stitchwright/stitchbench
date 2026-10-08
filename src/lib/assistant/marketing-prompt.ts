// Marketing and web-store drafts (shop-features-round-2-design.md 5.2): what each "Draft it" asks the model. Pure: no
// database. Every fact comes from the shop's own records (items received, a class's fields, an item's fields); never a
// customer. The draft lands in a field for staff to change; nothing is sent by itself.
import type { Built, Voice } from "./prompts";
import { cleanInstruction } from "./prompts";
import { redact, type Redaction } from "./redact";

const clip = (s: string | null | undefined, max: number) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const cents = (c: number) => `$${(c / 100).toFixed(2)}`;

export type ArrivalFact = { name: string; brand: string | null; collection: string | null; details: string | null; tags: string[]; priceCents: number | null; unit: string | null };
export type ClassFacts = { title: string; teacher: string | null; location: string | null; when: string | null; meetings: number | null; feeCents: number | null; supplies: string | null; notes: string | null };
export type ItemFacts = { name: string; brand: string | null; kind: string; collection: string | null; designer: string | null; details: string | null; tags: string[]; content: string | null; priceCents: number | null; unit: string | null };
export type PostAbout = { kind: "arrivals"; items: ArrivalFact[]; days: number } | { kind: "class"; facts: ClassFacts } | { kind: "item"; facts: ItemFacts };

function systemFor(voice: Voice, task: string): string {
  return [
    `You write marketing words for ${clip(voice.shopName, 80) || "a sewing and quilt shop"}, in the shop's own voice: warm, plain and short.`,
    task,
    "Use only the facts given. Never invent a price, a discount, a date, a stock level or a promise, and never name a customer.",
    "Answer with only the requested text: no preamble, no quotation marks, no markdown.",
    voice.sample?.trim() ? `How this shop writes (its own sample sentences):\n${clip(voice.sample, 900)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const price = (c: number | null, unit: string | null) => (c == null ? "" : ` ${cents(c)}${unit === "yd" ? " a yard" : ""}`);
const arrivalLine = (a: ArrivalFact, r: Redaction) =>
  `- ${redact(clip(a.name, 120), r)}${a.brand ? ` by ${clip(a.brand, 60)}` : ""}${a.collection ? `, ${clip(a.collection, 60)} collection` : ""}${a.details ? ` (${clip(a.details, 100)})` : ""}${a.tags.length ? ` [${a.tags.slice(0, 5).join(", ")}]` : ""}${price(a.priceCents, a.unit)}`;
const classBlock = (c: ClassFacts, r: Redaction) =>
  [
    `Class: ${redact(clip(c.title, 120), r)}`,
    c.teacher ? `Teacher: ${redact(clip(c.teacher, 80), r)}` : "",
    c.location ? `Where: ${clip(c.location, 120)}` : "",
    c.when ? `When: ${clip(c.when, 160)}` : "",
    c.meetings && c.meetings > 1 ? `Meetings: ${c.meetings}` : "",
    c.feeCents != null ? `Fee: ${c.feeCents ? cents(c.feeCents) : "free"}` : "",
    c.supplies ? `What to bring: ${redact(clip(c.supplies, 600), r)}` : "",
    c.notes ? `The shop's notes: ${redact(clip(c.notes, 600), r)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
const itemBlock = (i: ItemFacts, r: Redaction) =>
  [
    `Item: ${redact(clip(i.name, 160), r)}`,
    `Kind: ${i.kind.toLowerCase()}`,
    i.brand ? `Maker: ${clip(i.brand, 60)}` : "",
    i.collection ? `Collection: ${clip(i.collection, 80)}` : "",
    i.designer ? `Designer: ${clip(i.designer, 80)}` : "",
    i.details ? `Details: ${clip(i.details, 200)}` : "",
    i.content ? `Content: ${clip(i.content, 120)}` : "",
    i.tags.length ? `Color and theme: ${i.tags.slice(0, 8).join(", ")}` : "",
    i.priceCents != null ? `Price:${price(i.priceCents, i.unit)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

/** A new arrivals email: "Subject: ..." on the first line, then the body (it may greet with {first_name}). */
export function buildArrivals(items: ArrivalFact[], days: number, voice: Voice, r: Redaction, instruction?: string | null): Built {
  const task = `Write a short email to the shop's customers about what arrived in the last ${days} days. First line: "Subject: " and a subject of at most 8 words. Then a blank line and the body: a greeting with the placeholder {first_name} exactly as written, two to four short paragraphs or a short list naming the items, and a closing that invites them in. Under 180 words. Sign off with the placeholder {shop_name}.`;
  const extra = cleanInstruction(instruction, r);
  const body = [`Arrived in the last ${days} days:\n${items.slice(0, 30).map((a) => arrivalLine(a, r)).join("\n")}`, extra ? `Also: ${extra}` : ""].filter(Boolean).join("\n\n");
  return { feature: "draft_arrivals", cls: "draft", system: systemFor(voice, task), messages: [{ role: "user", content: body }], maxTokens: 600 };
}

/** "About the class": two to four sentences for the roster, the newsletter and the booking page. */
export function buildClassBlurb(c: ClassFacts, voice: Voice, r: Redaction, instruction?: string | null): Built {
  const task = "Write two to four sentences describing this class for the shop's class list and booking page: what they will make or learn and who it suits. Mention the fee and what to bring only as given.";
  const extra = cleanInstruction(instruction, r);
  return { feature: "draft_class", cls: "draft", system: systemFor(voice, task), messages: [{ role: "user", content: [classBlock(c, r), extra ? `Also: ${extra}` : ""].filter(Boolean).join("\n\n") }], maxTokens: 350 };
}

/** An item's online description: two to four sentences for the online shop. */
export function buildProductText(i: ItemFacts, voice: Voice, r: Redaction, instruction?: string | null): Built {
  const task = "Write the description customers see for this item in the shop's online store: two to four sentences on what it is and what it's good for. Use only the details given; don't repeat the price.";
  const extra = cleanInstruction(instruction, r);
  return { feature: "draft_product", cls: "draft", system: systemFor(voice, task), messages: [{ role: "user", content: [itemBlock(i, r), extra ? `Also: ${extra}` : ""].filter(Boolean).join("\n\n") }], maxTokens: 350 };
}

/** A social post (Facebook or Instagram) to copy and paste: a few lines and at most four hashtags. */
export function buildPost(about: PostAbout, voice: Voice, r: Redaction, instruction?: string | null): Built {
  const task = "Write one social media post (Facebook or Instagram) of at most 60 words, friendly and plain, ending with at most four relevant hashtags. Invite people into the shop.";
  const what =
    about.kind === "arrivals"
      ? `New in the last ${about.days} days:\n${about.items.slice(0, 12).map((a) => arrivalLine(a, r)).join("\n")}`
      : about.kind === "class"
        ? classBlock(about.facts, r)
        : itemBlock(about.facts, r);
  const extra = cleanInstruction(instruction, r);
  return { feature: "draft_post", cls: "draft", system: systemFor(voice, task), messages: [{ role: "user", content: [what, extra ? `Also: ${extra}` : ""].filter(Boolean).join("\n\n") }], maxTokens: 250 };
}

/** The email's subject and body from "Subject: ...\n\nbody" (no subject line: the first line is the subject). */
export function splitSubject(text: string): { subject: string; body: string } {
  const t = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const m = /^\s*subject\s*:\s*(.+)\n+([\s\S]*)$/i.exec(t);
  if (m) return { subject: m[1].trim().replace(/^["']|["']$/g, "").slice(0, 150), body: m[2].trim().slice(0, 5000) };
  const [first, ...rest] = t.split("\n");
  return rest.join("\n").trim() ? { subject: first.trim().slice(0, 150), body: rest.join("\n").trim().slice(0, 5000) } : { subject: "New this week", body: t.slice(0, 5000) };
}
