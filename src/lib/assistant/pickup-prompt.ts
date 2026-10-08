// "Draft the pickup sheet" (shop-features-round-2-design.md 5.5): "What we did" in plain English from the ticket's work
// and lines, and up to three care tips picked by number from the shop's own list for the kind. The model never writes
// advice of its own: a tip number not on the list is dropped. Pure: no database; the ticket goes through ticketBlock
// (no customer field, every free text redacted).
import { jsonOf, ticketBlock, type Built, type TicketFacts, type Voice } from "./prompts";
import { CUSTOMER_MARK, type Redaction } from "./redact";

const clip = (s: string | null | undefined, max: number) => String(s ?? "").trim().slice(0, max);

export function buildPickupSheet(t: TicketFacts, tips: { n: number; text: string }[], voice: Voice, r: Redaction): Built {
  const system = [
    `You write the sheet a customer takes home with their repaired machine, for the staff of ${clip(voice.shopName, 80) || "a repair shop"}.`,
    'Write "whatWeDid": two to four plain sentences in past tense saying what the shop did, from the work and lines given, for someone who isn\'t technical. Use only what the notes and lines say; never invent work, parts, prices or promises, and never name the customer (leave out the mark ' +
      CUSTOMER_MARK +
      ").",
    'Then pick up to three care tips that suit this machine and repair, by their numbers, from the shop\'s list only ("tips": []). Never write a tip of your own.',
    'Answer with JSON only: {"whatWeDid":"...","tips":[1,2]}',
    voice.sample?.trim() ? `How this shop writes (its own sample sentences):\n${clip(voice.sample, 900)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const list = tips.length ? tips.map((x) => `${x.n}. ${clip(x.text, 300)}`).join("\n") : "(the shop has no care tips for this kind: leave tips empty)";
  return {
    feature: "draft_pickup",
    cls: "draft",
    system,
    messages: [{ role: "user", content: `${ticketBlock(t, r, { include: ["diagnosis", "workDone", "lines"] })}\n\nThe shop's care tips:\n${list}` }],
    maxTokens: 500,
  };
}

/** The sheet as kept: the words (plain text) and the tip numbers that are on the list, at most three. */
export function parsePickupSheet(text: string, offered: number[]): { what: string; tips: number[] } | null {
  const j = jsonOf(text) as { whatWeDid?: unknown; tips?: unknown } | null;
  if (!j || typeof j.whatWeDid !== "string" || !j.whatWeDid.trim()) return null;
  const tips = Array.isArray(j.tips) ? [...new Set(j.tips.map((x) => Math.round(Number(x))).filter((n) => offered.includes(n)))].slice(0, 3) : [];
  return { what: j.whatWeDid.replace(/[*_#`>]/g, "").trim().slice(0, 2000), tips };
}
