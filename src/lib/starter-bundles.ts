import "server-only";
// Starter bundles (shop-features-round-2-design.md 6.1, package maker-machines): what the shop puts with a new machine of
// a kind ("Bambu starter: 2 spools PLA, build plate glue"; "AccuQuilt starter: 2 dies, cutting mat"), set up in Settings
// → Selling and added to a machine's sale in one tap at the register. The items are plain ids of the company's own
// items, checked when read. Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId, sameText } from "@/lib/input";
import { str } from "@/lib/format";
import { numberKey } from "@/lib/parts";
import { builtInKind } from "@/lib/equipment";
import { FIRST_PHOTO, viewItem, type RegisterItem } from "@/lib/register-item";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

export type BundleLine = { partId: string; qty: number };
const MAX_LINES = 30;

/** The saved lines, cleaned (a hand-edited row can't break a page). */
export function bundleLines(v: unknown): BundleLine[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is { partId: string; qty: number } => !!x && typeof x === "object" && typeof (x as BundleLine).partId === "string" && Number.isInteger((x as BundleLine).qty) && (x as BundleLine).qty > 0)
    .slice(0, MAX_LINES)
    .map((x) => ({ partId: x.partId, qty: Math.min(x.qty, 100) }));
}

export type BundleView = { id: string; kind: string; kindLabel: string; name: string; lines: { partId: string; qty: number; partNumber: string; description: string }[] };

export async function listBundles(shopId: string): Promise<BundleView[]> {
  const rows = await db.starterBundle.findMany({ where: { shopId }, orderBy: [{ kind: "asc" }, { name: "asc" }] });
  const ids = [...new Set(rows.flatMap((r) => bundleLines(r.lines).map((l) => l.partId)))];
  const parts = ids.length ? await db.part.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, partNumber: true, description: true } }) : [];
  const byId = new Map(parts.map((p) => [p.id, p]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    kindLabel: builtInKind(r.kind)?.label ?? r.kind,
    name: r.name,
    lines: bundleLines(r.lines).flatMap((l) => {
      const p = byId.get(l.partId);
      return p ? [{ ...l, partNumber: p.partNumber, description: p.description }] : [];
    }),
  }));
}

/**
 * Makes or changes a bundle: the machine kind, a name, and its items one a line ("PLA-BLK, 2" or "PLA-BLK 2" or just
 * "GLUE-1" for one). Each item by its number (any capitals) among the company's own. Owner or admin.
 */
export async function saveBundleFor(user: CurrentUser, id: string | null, fd: FormData): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can set up starter bundles.");
  const kind = str(fd.get("kind")) ?? "";
  if (!builtInKind(kind)) throw new UserError("Pick the kind of machine the bundle goes with.");
  const name = (str(fd.get("name")) ?? "").replace(/\s+/g, " ").slice(0, 80);
  if (!name) throw new UserError('Give the bundle a name, like "Bambu starter".');
  const lines: BundleLine[] = [];
  for (const raw of String(fd.get("items") ?? "").split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^(.*?)[,\s]+(\d{1,3})$/.exec(t);
    const number = (m ? m[1] : t).trim();
    const qty = m ? Number(m[2]) : 1;
    if (qty < 1) throw new UserError(`"${t}": at least 1.`);
    const part = await db.part.findFirst({ where: { shopId: user.shopId, OR: [{ partNumber: sameText(number) }, { numberKeys: { has: numberKey(number) } }] }, select: { id: true } });
    if (!part) throw new UserError(`No item numbered ${number} in inventory.`);
    const have = lines.find((l) => l.partId === part.id);
    if (have) have.qty += qty;
    else lines.push({ partId: part.id, qty });
  }
  if (!lines.length) throw new UserError("Add at least one item, one a line: its number and how many.");
  if (lines.length > MAX_LINES) throw new UserError(`${MAX_LINES} items at most in a bundle.`);
  const clash = await db.starterBundle.findFirst({ where: { shopId: user.shopId, name: { equals: name, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
  if (clash) throw new UserError(`There is already a bundle called ${name}.`);
  const data = { kind, name, lines: lines as Prisma.InputJsonValue };
  if (id) {
    const r = await db.starterBundle.updateMany({ where: { id: assertId(id), shopId: user.shopId }, data });
    if (r.count !== 1) throw new UserError("Bundle not found.");
    return `Saved ${name}.`;
  }
  await db.starterBundle.create({ data: { shopId: user.shopId, ...data } });
  return `Added ${name}.`;
}

export async function deleteBundleFor(user: CurrentUser, id: string): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can remove a starter bundle.");
  const r = await db.starterBundle.deleteMany({ where: { id: assertId(id), shopId: user.shopId } });
  if (r.count !== 1) throw new UserError("Bundle not found.");
  return "Removed the bundle.";
}

export type UnitBundles = { unitId: string; label: string; bundles: { id: string; name: string; items: { item: RegisterItem; qty: number }[] }[] };

/** For each machine for sale named: the bundles for its kind, with their items as the register sells them. */
export async function bundlesForUnits(shopId: string, unitIds: string[]): Promise<UnitBundles[]> {
  const ids = [...new Set(unitIds.filter((x) => /^[a-z0-9]{10,40}$/i.test(x)))].slice(0, 10);
  if (!ids.length) return [];
  const units = await db.stockUnit.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, machine: { select: { kind: true, brand: true, model: true } } } });
  const kinds = [...new Set(units.map((u) => u.machine.kind))];
  const bundles = await db.starterBundle.findMany({ where: { shopId, kind: { in: kinds } }, orderBy: { name: "asc" } });
  const partIds = [...new Set(bundles.flatMap((b) => bundleLines(b.lines).map((l) => l.partId)))];
  const parts = partIds.length ? await db.part.findMany({ where: { shopId, id: { in: partIds } }, include: FIRST_PHOTO }) : [];
  const byId = new Map(parts.map((p) => [p.id, viewItem(p)]));
  return units.map((u) => ({
    unitId: u.id,
    label: `${u.machine.brand} ${u.machine.model}`.trim(),
    bundles: bundles
      .filter((b) => b.kind === u.machine.kind)
      .map((b) => ({ id: b.id, name: b.name, items: bundleLines(b.lines).flatMap((l) => (byId.has(l.partId) ? [{ item: byId.get(l.partId)!, qty: l.qty }] : [])) }))
      .filter((b) => b.items.length),
  }));
}
