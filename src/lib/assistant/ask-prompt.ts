// Ask your shop (shop-features-round-2-design.md 5.1): the two requests. The first gives the model the question and the
// list of the program's own reports and asks it to pick one and its settings; the program runs that report; the second
// gives it the report's numbers and asks for two sentences from those numbers only. Pure: no database. The question is
// redacted like any typed text (emails, phones, customers' names), and the rows carry item names and counts only.
import { ASK_KINDS, REPORT_DEFS, checkChoice, type AskChoice } from "@/lib/reports/registry-defs";
import { jsonOf, type Built } from "./prompts";
import { redact, type Redaction } from "./redact";

const clip = (s: string | null | undefined, max: number) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);

export const ASK_CHOOSE_SYSTEM = `You pick which of a shop's own reports answers the owner's question, and its settings. You never answer the question yourself and never invent a report.
Answer with JSON only: {"report":"<report id or none>","from":"YYYY-MM-DD","to":"YYYY-MM-DD","kind":"","collection":"","top":10}.
Rules: use a report id exactly as listed; "none" when no report covers the question. Dates are days in the shop's time zone; "to" is never after today. Read seasons as: spring from March 20, summer from June 21, fall from September 22, winter from December 21. With no dates in the question, use this year so far. "kind" is one of the listed kinds or empty. "collection" is one of the listed collections or empty (precuts, charm packs and jelly rolls are kinds of fabric: leave collection empty unless the question names one). "top" is how many rows (1 to 50).`;

export function buildAskChoose(question: string, today: string, collections: readonly string[], r: Redaction): Built {
  const list = REPORT_DEFS.map((d) => `- ${d.id}: ${d.blurb}${d.params.length ? ` (settings: ${d.params.join(", ")})` : " (no settings)"}`).join("\n");
  const body = [
    `Today is ${today}.`,
    `Reports:\n${list}`,
    `Kinds: ${ASK_KINDS.join(", ")}`,
    collections.length ? `Collections: ${collections.slice(0, 60).map((c) => clip(c, 60)).join("; ")}` : "Collections: none",
    `Question: ${redact(clip(question, 300), r)}`,
  ].join("\n\n");
  return { feature: "ask_shop", cls: "suggest", system: ASK_CHOOSE_SYSTEM, messages: [{ role: "user", content: body }], maxTokens: 200 };
}

/** The pick, checked against the list (registry-defs.checkChoice); null when the answer isn't JSON. */
export function parseAskChoice(text: string, today: string, collections: readonly string[]): AskChoice | null {
  return checkChoice(jsonOf(text), today, collections);
}

export const ASK_WORD_SYSTEM = `You answer a shop owner's question in one or two short plain sentences, using only the numbers in the report given. Never add a number, item, date or reason the report doesn't show; if the report has no rows, say plainly that nothing matched. No preamble, no lists, no markdown.`;

export function buildAskWord(question: string, report: { title: string; facts: string[] }, r: Redaction): Built {
  const facts = report.facts.slice(0, 20).map((f) => clip(f, 200));
  const body = [`Question: ${redact(clip(question, 300), r)}`, `Report: ${clip(report.title, 160)}`, facts.length ? facts.join("\n") : "(no rows)"].join("\n\n");
  return { feature: "ask_shop", cls: "suggest", system: ASK_WORD_SYSTEM, messages: [{ role: "user", content: body }], maxTokens: 220 };
}

/** The answer as shown: plain text, at most about two sentences' worth. */
export function cleanAnswer(text: string): string {
  return String(text ?? "")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
