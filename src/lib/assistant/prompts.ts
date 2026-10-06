// What each Assistant feature asks the model, and how its answer is read (ai-assistant-scope.md section 1). Pure: no
// "server-only", no database. Every text field goes through the redactor the caller passes, so nothing built here can
// carry a customer: the builders take no customer field at all. scripts/checks/assistant.check.ts holds the request
// shapes and the parsing.
import { type FeatureId, type ModelClass } from "./features";
import { CUSTOMER_MARK, redact, type Redaction } from "./redact";

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type Built = { feature: FeatureId; cls: ModelClass; system: string; messages: ChatMessage[]; maxTokens: number; sources?: Source[] };
export type SourceKind = "manual" | "ticket" | "gotcha" | "hubpost" | "spec" | "setting" | "servicemode" | "general";
/** `href` is where a person opens the source (never sent to the model). */
export type Source = { kind: SourceKind; ref: string; label: string; href?: string; page?: number };

export type TicketFacts = {
  number: number;
  noun: string; // "sewing machine", "vacuum", "stand mixer": the kind's noun
  brand: string;
  model: string;
  machineType: string | null;
  serviceRequested: string | null;
  problem: string | null;
  diagnosis: string | null;
  workDone: string | null;
  notes: string | null;
  accessories: string[];
  lines: { kind: string; description: string; qty: number; unitPriceCents: number }[];
};

export type Voice = { shopName: string; sample: string | null };

const cents = (c: number) => `$${(c / 100).toFixed(2)}`;
const clip = (s: string | null | undefined, max: number) => String(s ?? "").trim().slice(0, max);

/** The one-line instruction a tech may add to "Try again" ("shorter", "mention the belt"): short, plain text, redacted like the rest. */
export function cleanInstruction(s: string | null | undefined, r: Redaction): string {
  return redact(clip(s, 160).replace(/\s+/g, " "), r);
}

function systemFor(voice: Voice, task: string): string {
  // The stable part first, the shop's own words last: the hub caches the whole block, so a shop's calls share it.
  return [
    `You help the staff of ${clip(voice.shopName, 80) || "a repair shop"} write clearly, in the shop's own voice.`,
    task,
    "Use only what the notes and lines say. Never invent work, parts, prices, dates or promises. Never write a customer's name, phone number or email; the notes may contain the mark " +
      CUSTOMER_MARK +
      ": leave it out.",
    "Answer with only the requested text: no preamble, no quotation marks, no markdown.",
    voice.sample?.trim() ? `How this shop writes (its own sample sentences):\n${clip(voice.sample, 900)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The ticket as the model sees it: facts and the typed shorthand, with no customer field and every free text redacted. */
export function ticketBlock(t: TicketFacts, r: Redaction, o: { include?: ("problem" | "diagnosis" | "workDone" | "notes" | "lines" | "accessories")[] } = {}): string {
  const want = (k: NonNullable<typeof o.include>[number]) => !o.include || o.include.includes(k);
  const out = [`Ticket #${t.number}: a ${redact(t.noun, r)} (${redact([t.brand, t.model, t.machineType].filter(Boolean).join(" "), r)}).`];
  if (t.serviceRequested) out.push(`Service requested: ${redact(clip(t.serviceRequested, 300), r)}`);
  if (want("problem") && t.problem) out.push(`Problem reported: ${redact(clip(t.problem, 1200), r)}`);
  if (want("diagnosis") && t.diagnosis) out.push(`What we found: ${redact(clip(t.diagnosis, 1500), r)}`);
  if (want("workDone") && t.workDone) out.push(`Work done (tech's notes): ${redact(clip(t.workDone, 1500), r)}`);
  if (want("notes") && t.notes) out.push(`Internal notes: ${redact(clip(t.notes, 1200), r)}`);
  if (want("accessories") && t.accessories.length) out.push(`Came in with: ${redact(t.accessories.slice(0, 20).join(", "), r)}`);
  if (want("lines") && t.lines.length) {
    out.push("Lines on the bill:");
    for (const l of t.lines.slice(0, 40)) out.push(`- ${l.kind.toLowerCase()}: ${redact(clip(l.description, 200), r)}${l.qty !== 1 ? ` x${l.qty}` : ""} ${cents(Math.round(l.qty * l.unitPriceCents))}`);
  }
  return out.join("\n");
}

type DraftOpts = { shorthand?: string | null; instruction?: string | null; firstName?: string | null; totalCents?: number | null };

/** "Draft it" for Work done and What we found: the tech's shorthand as 2-6 plain sentences for the invoice. */
export function buildWriteUp(kind: "work_done" | "diagnosis", t: TicketFacts, voice: Voice, r: Redaction, o: DraftOpts = {}): Built {
  const work = kind === "work_done";
  const shorthand = redact(clip(o.shorthand ?? (work ? t.workDone : t.diagnosis), 2000), r);
  const task = work
    ? "Rewrite the technician's shorthand as 2 to 6 plain sentences describing the work done, for the customer's invoice. Past tense."
    : "Rewrite the technician's shorthand as 2 to 5 plain sentences saying what was found wrong with the machine, for the customer's invoice. Past tense, no blame.";
  const lines = [
    ticketBlock(t, r, { include: work ? ["problem", "diagnosis", "lines", "accessories"] : ["problem", "lines", "accessories"] }),
    `Technician's shorthand to rewrite:\n${shorthand || "(nothing typed yet: write from the other notes)"}`,
  ];
  const extra = cleanInstruction(o.instruction, r);
  if (extra) lines.push(`Also: ${extra}`);
  return { feature: work ? "draft_work_done" : "draft_diagnosis", cls: "draft", system: systemFor(voice, task), messages: [{ role: "user", content: lines.join("\n\n") }], maxTokens: 450 };
}

/** A repair job's note to the sewing shop's counter: what it needs, what it will cost, when it is back. */
export function buildPartnerNote(t: TicketFacts, partnerName: string | null, voice: Voice, r: Redaction, o: DraftOpts = {}): Built {
  const task = `Write a short note (1 to 4 sentences) to ${redact(clip(partnerName, 80), r) || "the sewing shop"}'s counter about this repair: what the machine needs, what it will cost if the lines say, and when it will be back if the notes say.`;
  const lines = [ticketBlock(t, r), o.shorthand ? `The tech's own words:\n${redact(clip(o.shorthand, 800), r)}` : ""];
  const extra = cleanInstruction(o.instruction, r);
  if (extra) lines.push(`Also: ${extra}`);
  return { feature: "draft_partner_note", cls: "draft", system: systemFor(voice, task), messages: [{ role: "user", content: lines.filter(Boolean).join("\n\n") }], maxTokens: 350 };
}

/**
 * The body of an estimate or ready message. The text keeps {first_name} (filled in on this PC when the message is
 * rendered) unless the company offered first names, in which case the name is given and used.
 */
export function buildCustomerMessage(kind: "estimate" | "ready", t: TicketFacts, voice: Voice, r: Redaction, o: DraftOpts = {}): Built {
  const greet = o.firstName ? `The customer's first name is ${redact(clip(o.firstName, 40), { serials: r.serials })}; greet them by it.` : "Greet the customer with the placeholder {first_name} exactly as written; it is filled in later.";
  const task =
    (kind === "estimate"
      ? `Write the text of a message (email or text) telling the customer what the repair needs and what it will cost, and asking them to reply to approve it. ${o.totalCents != null ? `The total on the bill is ${cents(o.totalCents)}.` : "Do not state a price the lines don't give."}`
      : "Write the text of a short message telling the customer their machine is ready for pickup.") +
    ` ${greet} Sign off with the placeholder {shop}. Keep it under 90 words.`;
  const extra = cleanInstruction(o.instruction, r);
  const body = [ticketBlock(t, r, { include: kind === "estimate" ? ["problem", "diagnosis", "workDone", "lines"] : ["workDone"] }), extra ? `Also: ${extra}` : ""].filter(Boolean).join("\n\n");
  return { feature: kind === "estimate" ? "draft_estimate" : "draft_ready", cls: "draft", system: systemFor(voice, task), messages: [{ role: "user", content: body }], maxTokens: 350 };
}

// ----- what's likely wrong -----

export type CauseSource = Source & { text: string };

const CAUSES_SYSTEM = `You are a bench assistant for a repair technician. Given a machine, the problem reported and what has been found so far, list up to five likely causes, most likely first, each with two to four short checks the technician can make at the bench.
You are given numbered sources (this shop's past tickets, gotcha notes, community notes, factory specs, service-mode procedures). When a cause or check rests on a source, cite its reference exactly as written (for example ticket:0123). Cite only references from the list; when a cause is from general knowledge, cite nothing. Never invent a spec value: quote only values that appear in a source.
Answer with JSON only, in this shape: {"causes":[{"cause":"...","checks":["...","..."],"sources":["ticket:0123"]}]}`;

export function buildLikelyCauses(t: TicketFacts, sources: CauseSource[], r: Redaction, o: { instruction?: string | null } = {}): Built {
  const list = sources.map((s) => `[${s.ref}] ${s.label}: ${redact(clip(s.text, 700), r)}`).join("\n");
  const extra = cleanInstruction(o.instruction, r);
  const body = [ticketBlock(t, r, { include: ["problem", "diagnosis", "workDone", "notes", "accessories"] }), list ? `Sources:\n${list}` : "Sources: none for this model.", extra ? `Also: ${extra}` : ""].filter(Boolean).join("\n\n");
  return {
    feature: "likely_causes",
    cls: "suggest",
    system: CAUSES_SYSTEM,
    messages: [{ role: "user", content: body }],
    maxTokens: 1400,
    sources: sources.map(({ kind, ref, label, href }) => ({ kind, ref, label, ...(href ? { href } : {}) })),
  };
}

export type Cause = { cause: string; checks: string[]; sources: Source[]; general: boolean };

/** The first JSON object in a model's answer (it may sit in a code fence or follow a sentence), or null. */
export function jsonOf(text: string): unknown {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * The causes from the model's JSON, each source checked against what was actually offered: a reference that wasn't
 * in the list is dropped, and a cause left with none shows "general knowledge". Null when the answer isn't usable.
 */
export function parseCauses(text: string, offered: readonly Source[]): Cause[] | null {
  const j = jsonOf(text) as { causes?: unknown } | null;
  if (!j || !Array.isArray(j.causes)) return null;
  const byRef = new Map(offered.map((s) => [s.ref, s]));
  const out: Cause[] = [];
  for (const c of j.causes.slice(0, 5)) {
    const o = c as { cause?: unknown; checks?: unknown; sources?: unknown };
    const cause = typeof o?.cause === "string" ? o.cause.trim().slice(0, 400) : "";
    if (!cause) continue;
    const checks = Array.isArray(o.checks) ? o.checks.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, 5) : [];
    const refs = Array.isArray(o.sources) ? o.sources.filter((x): x is string => typeof x === "string") : [];
    const sources = [...new Set(refs)].map((r) => byRef.get(r)).filter((s): s is Source => !!s);
    out.push({ cause, checks, sources, general: sources.length === 0 });
  }
  return out.length ? out : null;
}

// ----- the plate -----

export const PLATE_SYSTEM = `You read the rating plate or label of a machine (sewing machine, serger, vacuum, mixer, printer) from a photo and return what is printed on it.
Answer with JSON only: {"brand":"","model":"","serial":"","machineType":"","confidence":"sure"}. Use an empty string for anything you cannot read. Copy the model and serial exactly as printed, keeping letters and digits. Set confidence to "sure" only when brand, model and any serial are clearly legible; otherwise "guess". Never describe the photo and never add fields.`;

export function buildPlateRead(brands: readonly string[], retry = false): Built {
  const hint = brands.length ? ` The shop's usual brands: ${brands.slice(0, 60).join(", ")}.` : "";
  return {
    feature: "read_plate",
    cls: retry ? "suggest" : "read",
    system: PLATE_SYSTEM,
    messages: [{ role: "user", content: `Read this plate.${hint}` }],
    maxTokens: 300,
  };
}

export type Plate = { brand: string | null; model: string | null; serial: string | null; machineType: string | null; sure: boolean };

const field = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);

export function parsePlate(text: string): Plate | null {
  const j = jsonOf(text) as Record<string, unknown> | null;
  if (!j || typeof j !== "object") return null;
  const p: Plate = { brand: field(j.brand, 60), model: field(j.model, 60), serial: field(j.serial, 60), machineType: field(j.machineType, 60), sure: j.confidence === "sure" };
  if (!p.brand && !p.model && !p.serial) return null;
  // "Sure" with no model is not sure: the model is what the spec and manual matching run on.
  if (!p.model) p.sure = false;
  return p;
}
