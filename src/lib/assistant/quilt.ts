import "server-only";
// "Suggest coordinates" (shop-features-round-2-design.md 5.3): the body the quilt planner's button calls. The focus
// fabric is an item on the shelf (its color tags and collection) or a photo of what she brought (tagged first, one
// tag_fabric call: only the picture goes); the candidates are this company's fabric in stock with enough yards, at most
// 80, those sharing the collection or a color first. The model picks one per part (quilt_pick); the program keeps only
// picks on the list with the yards that part needs.
import { db } from "@/lib/db";
import { requireOn } from "@/lib/module-gate";
import type { CurrentUser } from "@/lib/session";
import { UserError } from "@/lib/user-error";
import { runAssistant, type Photo } from "./client";
import { buildSwatchTags, parseTags } from "./prompts";
import { buildQuiltPick, parseQuiltPicks, type QuiltCandidate, type QuiltFocus, type QuiltPick } from "./quilt-prompt";

export const MAX_CANDIDATES = 80;

export type QuiltPickResult = { picks: QuiltPick[]; dropped: number; focusTags: string[]; sent: number; callId: string };

const cleanRoles = (roles: unknown): { role: string; yards: number }[] => {
  if (!Array.isArray(roles)) return [];
  const out: { role: string; yards: number }[] = [];
  for (const r of roles.slice(0, 20)) {
    const role = typeof r?.role === "string" ? r.role.trim().slice(0, 40) : "";
    const yards = Number(r?.yards);
    if (role && Number.isFinite(yards) && yards > 0 && yards <= 100 && !out.some((o) => o.role === role)) out.push({ role, yards });
  }
  return out;
};

/** The candidates: in stock, own, by the yard, with at least the smallest part's yards; sharing the collection or a color first. */
export async function quiltCandidates(shopId: string, focus: QuiltFocus & { id?: string | null }, minYards: number): Promise<QuiltCandidate[]> {
  const rows = await db.part.findMany({
    where: { shopId, kind: "FABRIC", unit: "yd", consignLinkId: null, qtyOnHand: { gte: minYards }, ...(focus.id ? { id: { not: focus.id } } : {}) },
    select: { id: true, description: true, colorTags: true, collection: true, qtyOnHand: true },
    take: 3000,
  });
  const tags = new Set(focus.tags.map((t) => t.toLowerCase()));
  const col = focus.collection?.toLowerCase() ?? null;
  return rows
    .map((r) => ({ r, s: (col && r.collection?.toLowerCase() === col ? 3 : 0) + r.colorTags.filter((t) => tags.has(t.toLowerCase())).length + (r.colorTags.length ? 0.5 : 0) }))
    .sort((a, b) => b.s - a.s || b.r.qtyOnHand - a.r.qtyOnHand || a.r.description.localeCompare(b.r.description))
    .slice(0, MAX_CANDIDATES)
    .map(({ r }, i) => ({ ref: `f${i + 1}`, id: r.id, name: r.description, tags: r.colorTags, collection: r.collection, yards: r.qtyOnHand }));
}

export async function quiltPick(user: Pick<CurrentUser, "id" | "shopId" | "role">, o: { focusId?: string | null; photo?: Photo | null; roles: unknown }): Promise<QuiltPickResult> {
  await requireOn(user as CurrentUser, "assistant");
  const roles = cleanRoles(o.roles);
  if (!roles.length) throw new UserError("Every part already has a fabric. Clear one to get a suggestion for it.");
  let focus: QuiltFocus & { id?: string | null };
  if (o.focusId) {
    const p = await db.part.findFirst({ where: { id: String(o.focusId), shopId: user.shopId, kind: "FABRIC" }, select: { id: true, description: true, colorTags: true, collection: true } });
    if (!p) throw new UserError("Fabric not found.");
    focus = { id: p.id, name: p.description, tags: p.colorTags, collection: p.collection };
  } else if (o.photo) {
    // What she brought: the picture is tagged first (one call, only the picture goes), then the tags are the focus.
    const t = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildSwatchTags(), photo: o.photo });
    const tags = parseTags(t.text);
    if (!tags) throw new UserError("The Assistant couldn't see the colors in that photo. Take it again in good light, or choose her focus fabric from the shelf.");
    focus = { name: null, tags, collection: null };
  } else throw new UserError("Choose her focus fabric first, or take a photo of what she brought.");
  if (!focus.tags.length && !focus.collection) throw new UserError("Her focus fabric has no color tags yet. Add them on its page (or Tag from the picture), then ask again.");
  const candidates = await quiltCandidates(user.shopId, focus, Math.min(...roles.map((r) => r.yards)));
  if (!candidates.length) throw new UserError("No fabric on the shelf has enough yards for these parts.");
  const { row, text } = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildQuiltPick(focus, roles, candidates), ...(focus.id ? { target: { partId: focus.id } } : {}) });
  const parsed = parseQuiltPicks(text, roles, candidates);
  if (!parsed) throw new UserError("The Assistant's answer couldn't be read. Try again, or pick the fabrics yourself.");
  return { ...parsed, focusTags: focus.tags, sent: candidates.length, callId: row.id };
}
