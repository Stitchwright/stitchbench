// The trade-in helper's condition note (shop-features-round-2-design.md 5.4): the model looks at the condition photos
// (up to four, put side by side in one picture in the browser, with the plate if she took one) and writes a short note
// for staff. Only what shows in the photos; never a price, a value or how it runs. Pure: no database.
import type { Built } from "./prompts";

const clip = (s: string | null | undefined, max: number) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);

export const TRADE_IN_SYSTEM = `You look at photos of a used machine a customer is trading in at a sewing and vacuum shop (several photos may be side by side in one picture) and write a condition note for the shop's staff.
Say only what the photos show: scratches, dents, yellowing, cracks, missing covers, feet, cords or accessories, rust, dirt. One or two short sentences, at most 30 words, plain words. Never give a price or value, never guess how it runs, never describe people or the room. If the photos show nothing wrong, say "No visible damage in the photos."
Answer with only the note: no preamble, no quotation marks, no markdown.`;

export function buildTradeInNote(o: { noun: string; brand: string; model: string; photos: number }): Built {
  const what = [clip(o.brand, 60), clip(o.model, 60)].filter(Boolean).join(" ") || "machine";
  return {
    feature: "trade_in_note",
    cls: "read",
    system: TRADE_IN_SYSTEM,
    messages: [{ role: "user", content: `A used ${clip(o.noun, 40) || "machine"} (${what}) traded in: ${o.photos} photo${o.photos === 1 ? "" : "s"} side by side. Write the condition note.` }],
    maxTokens: 150,
  };
}

/** The note as kept: one paragraph, at most 300 characters. */
export const cleanNote = (text: string) =>
  String(text ?? "")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']|["']$/g, "")
    .slice(0, 300);
