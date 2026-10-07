import "server-only";
// Accessories that fit a machine (shop-features-round-2-design.md 2.4, package fits-machines): the models an item fits
// (Part.fitsModels as the shop picked them, Part.fitsKeys their model keys) and the fit groups it belongs to (FitGroup,
// Part.fitGroupIds), and the lookups that read them: what fits one machine, what fits each of a customer's machines (her
// page and the register's quiet line), what goes with a machine being sold, and the online shop's "Fits your machine".
// Matching is on model keys, like everything else. Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { modelKey, str } from "@/lib/format";
import { FIRST_PHOTO, viewItem, type RegisterItem } from "@/lib/register-item";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

export const MAX_FIT_MODELS = 200;
const MAX_LABEL = 80;

/** "Brother, PE800" or "Brother PE800" -> { brand Brother, model PE800 }; a single word is a model with no brand. */
export function parseModelLine(line: string): { brand: string; model: string } | null {
  const t = line.trim().replace(/\s+/g, " ");
  if (!t) return null;
  const comma = t.indexOf(",");
  if (comma > 0) {
    const brand = t.slice(0, comma).trim();
    const model = t.slice(comma + 1).trim();
    return model ? { brand, model } : null;
  }
  const sp = t.indexOf(" ");
  return sp > 0 ? { brand: t.slice(0, sp), model: t.slice(sp + 1) } : { brand: "", model: t };
}

/** A model as it is shown ("Brother PE800") and the key it matches on ("PE800"). */
export function fitOf(brand: string, model: string): { label: string; key: string } {
  const label = [brand.trim(), model.trim()].filter(Boolean).join(" ").slice(0, MAX_LABEL);
  return { label, key: modelKey(model) };
}

/** Lines of "Brand, Model" (or "Brand Model") as labels and keys, each model once. A line with no letters or digits in its model is refused by name. */
export function parseModelLines(text: string): { labels: string[]; keys: string[] } {
  const labels: string[] = [];
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = parseModelLine(raw);
    if (!m) continue;
    const f = fitOf(m.brand, m.model);
    if (!f.key) throw new UserError(`"${raw.trim().slice(0, 40)}": write the model, like Brother, PE800.`);
    if (labels.some((l) => l.toLowerCase() === f.label.toLowerCase())) continue;
    labels.push(f.label);
    keys.push(f.key);
  }
  if (labels.length > MAX_FIT_MODELS) throw new UserError(`${MAX_FIT_MODELS} models at most.`);
  return { labels, keys };
}

/** The shop's models (its customers' machines and its machines for sale), for the pickers: brand and model, each once. */
export async function shopModels(shopId: string, take = 600): Promise<{ brand: string; model: string }[]> {
  const rows = await db.machine.findMany({ where: { shopId }, distinct: ["brand", "modelKey"], select: { brand: true, model: true }, orderBy: [{ brand: "asc" }, { model: "asc" }], take });
  return rows.filter((r) => r.model.trim());
}

// ---------------------------------------------------------------------------------------------------------------
// Fit groups
// ---------------------------------------------------------------------------------------------------------------

export async function fitGroupsFor(shopId: string) {
  return db.fitGroup.findMany({ where: { shopId }, orderBy: { name: "asc" } });
}

/** Makes or changes a fit group: its name and its models, one a line ("Brother, PE800"). The name is the shop's own, once. */
export async function saveFitGroupFor(user: CurrentUser, id: string | null, fd: FormData): Promise<string> {
  const name = (str(fd.get("name")) ?? "").replace(/\s+/g, " ").slice(0, 80);
  if (!name) throw new UserError('Give the group a name, like "Brother 7 mm low shank".');
  const { labels, keys } = parseModelLines(String(fd.get("models") ?? ""));
  if (!labels.length) throw new UserError("Add at least one model, one a line: Brother, PE800.");
  const clash = await db.fitGroup.findFirst({ where: { shopId: user.shopId, name: { equals: name, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
  if (clash) throw new UserError(`There is already a group called ${name}.`);
  if (id) {
    const r = await db.fitGroup.updateMany({ where: { id: assertId(id), shopId: user.shopId }, data: { name, models: labels, modelKeys: keys } });
    if (r.count !== 1) throw new UserError("Fit group not found.");
    return `Saved ${name}: ${labels.length} ${labels.length === 1 ? "model" : "models"}.`;
  }
  await db.fitGroup.create({ data: { shopId: user.shopId, name, models: labels, modelKeys: keys } });
  return `Added ${name}: ${labels.length} ${labels.length === 1 ? "model" : "models"}.`;
}

/** Removes a group; the items in it keep their own models, and lose the group. */
export async function deleteFitGroupFor(user: CurrentUser, id: string): Promise<string> {
  const g = await db.fitGroup.findFirst({ where: { id: assertId(id), shopId: user.shopId } });
  if (!g) throw new UserError("Fit group not found.");
  await db.$transaction(async (tx) => {
    const parts = await tx.part.findMany({ where: { shopId: user.shopId, fitGroupIds: { has: g.id } }, select: { id: true, fitGroupIds: true } });
    for (const p of parts) await tx.part.update({ where: { id: p.id }, data: { fitGroupIds: { set: p.fitGroupIds.filter((x) => x !== g.id) } } });
    await tx.fitGroup.deleteMany({ where: { id: g.id, shopId: user.shopId } });
  });
  return `Removed the group ${g.name}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// An item's fits
// ---------------------------------------------------------------------------------------------------------------

async function ownPart(shopId: string, id: string) {
  const p = await db.part.findFirst({ where: { id: assertId(id), shopId }, select: { id: true, partNumber: true, fitsModels: true, fitsKeys: true, fitGroupIds: true } });
  if (!p) throw new UserError("Item not found.");
  return p;
}

/** Adds a model the item fits ("Brother" and "PE800", or one box "Brother PE800"). */
export async function addFitModelFor(user: CurrentUser, partId: string, brand: string | null, model: string | null): Promise<string> {
  const p = await ownPart(user.shopId, partId);
  // Two boxes (brand, model); a caller with one box passes the whole line as the brand and no model.
  const m = model != null ? (model.trim() ? { brand: (brand ?? "").trim(), model: model.trim() } : null) : parseModelLine(brand ?? "");
  if (!m || !m.model) throw new UserError("Enter the machine's model, like PE800.");
  const f = fitOf(m.brand, m.model);
  if (!f.key) throw new UserError("Enter the machine's model, like PE800.");
  if (p.fitsModels.some((l) => l.toLowerCase() === f.label.toLowerCase())) throw new UserError(`${p.partNumber} already fits ${f.label}.`);
  if (p.fitsModels.length >= MAX_FIT_MODELS) throw new UserError(`${MAX_FIT_MODELS} models at most on one item: use a fit group.`);
  // fitsModels and fitsKeys are kept side by side (the same position is the same model), so a brand of two words
  // ("Baby Lock Altair") keeps the key of its model alone.
  const pairs = pairsOf(p);
  pairs.push({ label: f.label, key: f.key });
  await db.part.updateMany({ where: { id: p.id, shopId: user.shopId }, data: { fitsModels: { set: pairs.map((x) => x.label) }, fitsKeys: { set: pairs.map((x) => x.key) } } });
  return `${p.partNumber} fits ${f.label}.`;
}

/** An item's models with their keys (a row whose lists drifted apart reads each label's key afresh). */
function pairsOf(p: { fitsModels: string[]; fitsKeys: string[] }): { label: string; key: string }[] {
  const aligned = p.fitsModels.length === p.fitsKeys.length;
  return p.fitsModels.map((label, i) => {
    const m = parseModelLine(label);
    return { label, key: aligned ? p.fitsKeys[i] : fitOf(m?.brand ?? "", m?.model ?? label).key };
  });
}

export async function removeFitModelFor(user: CurrentUser, partId: string, label: string): Promise<string> {
  const p = await ownPart(user.shopId, partId);
  const pairs = pairsOf(p).filter((x) => x.label !== label);
  await db.part.updateMany({ where: { id: p.id, shopId: user.shopId }, data: { fitsModels: { set: pairs.map((x) => x.label) }, fitsKeys: { set: pairs.map((x) => x.key) } } });
  return `${p.partNumber} no longer lists ${label}.`;
}

/** The fit groups the item belongs to: the ids ticked (only the shop's own groups are kept). */
export async function setFitGroupsFor(user: CurrentUser, partId: string, groupIds: string[]): Promise<string> {
  const p = await ownPart(user.shopId, partId);
  const ids = [...new Set(groupIds.filter((x) => /^[a-z0-9]{10,40}$/i.test(x)))];
  const own = ids.length ? await db.fitGroup.findMany({ where: { shopId: user.shopId, id: { in: ids } }, select: { id: true } }) : [];
  await db.part.updateMany({ where: { id: p.id, shopId: user.shopId }, data: { fitGroupIds: { set: own.map((g) => g.id) } } });
  return own.length ? `${p.partNumber} is in ${own.length} fit ${own.length === 1 ? "group" : "groups"}.` : `${p.partNumber} is in no fit group.`;
}

// ---------------------------------------------------------------------------------------------------------------
// What fits a machine
// ---------------------------------------------------------------------------------------------------------------

type PartRow = Prisma.PartGetPayload<{ include: typeof FIRST_PHOTO }>;

/** The shop's items that fit a model (its own models or a fit group with it), in stock first; `inStock`: only what is on the shelf. */
export async function partsFitting(shopId: string, model: string, o: { inStock?: boolean; take?: number; onlineOnly?: boolean } = {}): Promise<PartRow[]> {
  const key = modelKey(model);
  if (!key) return [];
  const groups = await db.fitGroup.findMany({ where: { shopId, modelKeys: { has: key } }, select: { id: true } });
  return db.part.findMany({
    where: {
      shopId,
      OR: [{ fitsKeys: { has: key } }, ...(groups.length ? [{ fitGroupIds: { hasSome: groups.map((g) => g.id) } }] : [])],
      ...(o.inStock ? { qtyOnHand: { gt: 0 } } : {}),
      ...(o.onlineOnly ? { online: true, priceCents: { not: null } } : {}),
    },
    include: FIRST_PHOTO,
    orderBy: [{ qtyOnHand: "desc" }, { description: "asc" }],
    take: o.take ?? 60,
  });
}

export type MachineFits = { machineId: string; label: string; items: RegisterItem[] };

/** What is on the shelf that fits each of a customer's machines (each model once), machines with nothing left out. */
export async function fitsForCustomer(shopId: string, customerId: string, take = 20): Promise<MachineFits[]> {
  if (!/^[a-z0-9]{10,40}$/i.test(customerId)) return [];
  const machines = await db.machine.findMany({ where: { shopId, customerId }, select: { id: true, brand: true, model: true, modelKey: true }, orderBy: { createdAt: "desc" }, take: 20 });
  const out: MachineFits[] = [];
  const seen = new Set<string>();
  for (const m of machines) {
    const key = modelKey(m.model);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const items = await partsFitting(shopId, m.model, { inStock: true, take });
    if (items.length) out.push({ machineId: m.id, label: `${m.brand} ${m.model}`.trim(), items: items.map(viewItem) });
  }
  return out;
}

/** "Goes with this machine": what is on the shelf that fits each machine for sale named (the register's machine sale). */
export async function fitsForUnits(shopId: string, unitIds: string[], take = 20): Promise<(MachineFits & { unitId: string })[]> {
  const ids = [...new Set(unitIds.filter((x) => /^[a-z0-9]{10,40}$/i.test(x)))].slice(0, 10);
  if (!ids.length) return [];
  const units = await db.stockUnit.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, machine: { select: { id: true, brand: true, model: true } } } });
  const out: (MachineFits & { unitId: string })[] = [];
  for (const u of units) {
    const items = await partsFitting(shopId, u.machine.model, { inStock: true, take });
    out.push({ unitId: u.id, machineId: u.machine.id, label: `${u.machine.brand} ${u.machine.model}`.trim(), items: items.map(viewItem) });
  }
  return out;
}
