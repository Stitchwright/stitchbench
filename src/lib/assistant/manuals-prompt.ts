// Ask the manuals (ai-assistant-scope.md 1.4), the pure half: the words of a search from a question, the request the hub
// receives (the question and a few numbered pages, nothing else), the page links, and how the answer is read. No
// "server-only" and no database: scripts/checks/assistant-manuals.check.ts holds the shapes and the parsing.
import { jsonOf, type Built, type Source } from "./prompts";
import { redact, type Redaction } from "./redact";

/** How many pages go to the model with a question, and the most characters of each (about 900 tokens a page). */
export const PASSAGES = 12;
export const PASSAGE_CHARS = 3500;
export const QUESTION_CHARS = 400;

export const NOT_FOUND_MESSAGE = "Not found in your manuals.";

export type ManualPassage = { ref: string; docId: string; page: number; label: string; text: string; href: string };

/** The shop's own PDF viewer at a page: the library file route, opened with the PDF's #page= address (as openLocal does). */
export function manualPageHref(path: string, page: number): string {
  return `/api/library/file?path=${encodeURIComponent(path.split("\\").join("/"))}#page=${Math.max(1, Math.floor(page))}`;
}

const WORD = /[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu;

/**
 * The words to look for, for a to_tsquery OR search: letters and digits only (nothing a tsquery would read as syntax),
 * lower case, each once, without the words already true of every page (the model's own name and brand).
 */
export function queryTerms(question: string, drop: readonly string[] = []): string[] {
  const skip = new Set(drop.flatMap((d) => (d.toLowerCase().match(WORD) ?? []).map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))));
  const out: string[] = [];
  for (const raw of question.toLowerCase().match(WORD) ?? []) {
    // "hook-timing" is searched as its parts, which is how the index holds it too.
    for (const w of raw.split(/[-']/)) {
      const t = w.replace(/[^\p{L}\p{N}]/gu, "");
      if (t.length < 2 || skip.has(t) || out.includes(t)) continue;
      out.push(t);
      if (out.length >= 24) return out;
    }
  }
  return out;
}

const SYSTEM = `You answer a repair technician's question from numbered pages of the machine's own manuals, and from nothing else.
Each page starts with a reference like [m3] and the manual's name and page. Use only what those pages say: never add knowledge from anywhere else, never invent a value, a step or a page number. A table, a note and a figure caption may each hold part of the answer: use all of them.
If the pages do not contain the answer, reply {"found":false}.
Otherwise reply with JSON only: {"found":true,"answer":"...","sources":["m3","m7"]}. The answer is short plain sentences or numbered steps, and each fact is followed by the reference of the page it came from, written exactly like [m3]. "sources" lists the references you used. Cite only references from the list.`;

/** The request: the question (redacted like any free text), the machine's make and model, and the matching pages. */
export function buildAskManuals(o: { brand: string; model: string; question: string; passages: readonly ManualPassage[]; r: Redaction }): Built {
  const q = redact(o.question.replace(/\s+/g, " ").trim().slice(0, QUESTION_CHARS), o.r);
  const pages = o.passages.map((p) => `[${p.ref}] ${p.label}, page ${p.page}\n${p.text.slice(0, PASSAGE_CHARS)}`).join("\n\n");
  return {
    feature: "ask_manuals",
    cls: "manuals",
    system: SYSTEM,
    messages: [{ role: "user", content: `Machine: ${o.brand} ${o.model}\nQuestion: ${q}\n\nPages from the manuals:\n${pages}` }],
    maxTokens: 700,
    sources: o.passages.map((p): Source => ({ kind: "manual", ref: p.ref, label: `${p.label}, p. ${p.page}`, href: p.href, page: p.page })),
  };
}

export type Citation = { ref: string; label: string; page: number; href: string };
export type ManualAnswer = { found: boolean; answer: string; citations: Citation[] };

/**
 * The model's answer, checked against the pages that were offered: a reference that wasn't offered is dropped from the
 * list and from the text, and an answer left with no page behind it is "not found" (the model must not answer beyond
 * the passages, so an unsupported answer is not shown at all).
 */
export function parseManualAnswer(text: string, offered: readonly Source[]): ManualAnswer {
  const none: ManualAnswer = { found: false, answer: "", citations: [] };
  const j = jsonOf(text) as { found?: unknown; answer?: unknown; sources?: unknown } | null;
  if (!j || j.found !== true || typeof j.answer !== "string" || !j.answer.trim()) return none;
  const byRef = new Map(offered.map((s) => [s.ref, s]));
  const listed = Array.isArray(j.sources) ? j.sources.filter((x): x is string => typeof x === "string") : [];
  const inText = [...j.answer.matchAll(/\[(m\d+)\]/g)].map((m) => m[1]);
  const refs = [...new Set([...inText, ...listed])].filter((r) => byRef.has(r));
  if (!refs.length) return none;
  const answer = j.answer
    .replace(/\[(m\d+)\]/g, (whole, r: string) => (byRef.has(r) ? whole : ""))
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim()
    .slice(0, 2500);
  const citations = refs.map((r) => byRef.get(r)!).map((s) => ({ ref: s.ref, label: s.label, page: s.page ?? 0, href: s.href ?? "" }));
  return { found: true, answer, citations };
}

/** Text of a page as extracted from pdf.js items: lines kept, spaces tidied, no NUL, clipped. */
export function cleanPageText(items: readonly { str?: string; hasEOL?: boolean }[]): string {
  let s = "";
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    s += it.str + (it.hasEOL ? "\n" : " ");
  }
  return s
    .replace(/\0/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 30_000);
}

/** A page with no real text (a scan, a picture page): fewer than this many letters and digits is not searchable. */
export const MIN_PAGE_CHARS = 25;
export const hasText = (text: string) => (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= MIN_PAGE_CHARS;
