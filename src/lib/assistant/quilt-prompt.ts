// "Suggest coordinates" in the quilt planner (shop-features-round-2-design.md 5.3): the model gets the focus fabric's
// color tags and collection and a numbered list of in-stock fabrics that have enough yards (name, tags, collection,
// yards), and picks one per part with a one-line reason. The program checks every pick is on the list, in stock with the
// yards that part needs, and drops any that isn't. Pure: no database; nothing about a customer is in it.
import { jsonOf, type Built } from "./prompts";

const clip = (s: string | null | undefined, max: number) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);

export type QuiltCandidate = { ref: string; id: string; name: string; tags: string[]; collection: string | null; yards: number };
export type QuiltFocus = { name: string | null; tags: string[]; collection: string | null };
export type QuiltPick = { role: string; id: string; why: string };

export const QUILT_SYSTEM = `You help a quilt shop pick fabrics from its own shelves to go with a customer's focus fabric. For each part of the quilt listed, pick one fabric from the numbered list that coordinates with the focus fabric (color, value contrast, style), each part a different fabric unless the list is short, and give a reason of at most 12 words.
Pick only references from the list, and only a fabric with at least the yards the part needs. Never invent a fabric.
Answer with JSON only: {"picks":[{"role":"<part exactly as listed>","ref":"f1","why":"..."}]}`;

export function buildQuiltPick(focus: QuiltFocus, roles: { role: string; yards: number }[], candidates: QuiltCandidate[]): Built {
  const f = [focus.name ? `Name: ${clip(focus.name, 120)}` : "", focus.tags.length ? `Colors and themes: ${focus.tags.slice(0, 8).join(", ")}` : "Colors and themes: not tagged", focus.collection ? `Collection: ${clip(focus.collection, 80)}` : ""].filter(Boolean).join("\n");
  const parts = roles.map((r) => `- ${clip(r.role, 40)}: needs ${r.yards} yd`).join("\n");
  const list = candidates.map((c) => `[${c.ref}] ${clip(c.name, 100)}${c.collection ? `; collection ${clip(c.collection, 60)}` : ""}; ${c.tags.length ? c.tags.slice(0, 6).join(", ") : "untagged"}; ${Math.floor(c.yards * 8) / 8} yd`).join("\n");
  return {
    feature: "quilt_pick",
    cls: "suggest",
    system: QUILT_SYSTEM,
    messages: [{ role: "user", content: `Focus fabric:\n${f}\n\nParts to fill:\n${parts}\n\nFabrics in stock:\n${list}` }],
    maxTokens: 700,
  };
}

/**
 * The picks the program keeps: a part that was asked for (any case), a reference on the list, a fabric with the yards
 * that part needs, each part once, and a fabric used for two parts only when the bolt covers both. The rest are dropped
 * and counted.
 */
export function parseQuiltPicks(text: string, roles: { role: string; yards: number }[], candidates: QuiltCandidate[]): { picks: QuiltPick[]; dropped: number } | null {
  const j = jsonOf(text) as { picks?: unknown } | null;
  if (!j || !Array.isArray(j.picks)) return null;
  const byRef = new Map(candidates.map((c) => [c.ref.toLowerCase(), c]));
  const used = new Map<string, number>();
  const picks: QuiltPick[] = [];
  let dropped = 0;
  for (const raw of j.picks.slice(0, 40)) {
    const o = raw as { role?: unknown; ref?: unknown; why?: unknown };
    const role = roles.find((r) => typeof o?.role === "string" && r.role.toLowerCase() === o.role.trim().toLowerCase());
    const c = typeof o?.ref === "string" ? byRef.get(o.ref.trim().toLowerCase()) : undefined;
    const need = role ? role.yards + (c ? (used.get(c.id) ?? 0) : 0) : Infinity;
    if (!role || !c || picks.some((p) => p.role === role.role) || c.yards + 1e-9 < need) {
      dropped += 1;
      continue;
    }
    used.set(c.id, need);
    picks.push({ role: role.role, id: c.id, why: typeof o.why === "string" ? clip(o.why, 120) : "" });
  }
  return { picks, dropped };
}
