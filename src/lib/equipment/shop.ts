import "server-only";
// The kinds one company can use: the built-ins plus its own (ShopEquipmentKind), and which are usable for new work
// (sewing always; the others while their module allows new work). modules-design.md section 9.3.
import { cache } from "react";
import { db } from "@/lib/db";
import { getModules } from "@/lib/modules";
import { DEFAULT_CHECKLIST } from "@/lib/service-menu";
import { BUILT_IN_KINDS, builtInKind, genericKind, shopKind, sortKinds } from "./index";
import { SEWING_KIND } from "./sewing";
import type { EquipmentKind } from "./types";

/** sellable: what may be sold as a machine for sale now: the usable kinds and the kinds that sell with no module (6.1). */
export type ShopKinds = { all: EquipmentKind[]; usable: EquipmentKind[]; sellable: EquipmentKind[] };

const load = cache(async (shopId: string): Promise<ShopKinds> => {
  const [rows, mods] = await Promise.all([
    db.shopEquipmentKind.findMany({ where: { shopId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    getModules(shopId),
  ]);
  // A shop kind never shadows a built-in key (saveEquipmentKind refuses one), but an odd row mustn't hide a built-in.
  const own = rows.filter((r) => !builtInKind(r.key));
  const order = own.map((r) => r.key);
  const all = sortKinds([...BUILT_IN_KINDS, ...own.map(shopKind)], order);
  const activeKeys = new Set(own.filter((r) => r.active).map((r) => r.key));
  const usable = all.filter((k) => {
    if (k.key === "sewing") return true;
    if (k.module && !mods.states[k.module].active) return false;
    return k.builtIn || activeKeys.has(k.key);
  });
  const sellable = all.filter((k) => usable.includes(k) || (k.builtIn && k.sellFree));
  return { all, usable, sellable };
});

/** all = built-ins + the shop's own rows (inactive ones too, so records render); usable = what new work may use. */
export async function shopKinds(shopId: string): Promise<ShopKinds> {
  return load(shopId);
}

/** The kind of a machine; never throws (a removed shop kind or a newer version's kind gets a generic one). */
export async function kindOf(shopId: string, m: { equipment: string; kind: string }): Promise<EquipmentKind> {
  const { all } = await load(shopId);
  return all.find((k) => k.key === m.kind && k.equipment === m.equipment) ?? all.find((k) => k.key === m.kind) ?? genericKind(m.equipment, m.kind);
}

/** A known key in `all`, else sewing (a missing kind means sewing). */
export async function kindByKey(shopId: string, key: string | null | undefined): Promise<EquipmentKind> {
  if (!key) return SEWING_KIND;
  const { all } = await load(shopId);
  return all.find((k) => k.key === key) ?? SEWING_KIND;
}

/** A kind that may take new work, or null. */
export async function usableKind(shopId: string, key: string | null | undefined): Promise<EquipmentKind | null> {
  if (!key) return null;
  const { usable } = await load(shopId);
  return usable.find((k) => k.key === key) ?? null;
}

/** A kind that may be sold as a machine for sale now (usable, or one that sells with no module), or null. */
export async function sellableKind(shopId: string, key: string | null | undefined): Promise<EquipmentKind | null> {
  if (!key) return null;
  const { sellable } = await load(shopId);
  return sellable.find((k) => k.key === key) ?? null;
}

/** Whether a machine of this kind sells with no module (sewing machines, printers, cutters, lasers). */
export const sellsFree = (k: EquipmentKind | undefined | null) => !!k && (k.key === "sewing" || !!k.sellFree);

/** sewing: the shop's own checklist (or the default); other kinds: the kind's. */
export function checklistFor(kind: EquipmentKind, shop: { checklistItems: string[] }): string[] {
  if (kind.key === "sewing") return shop.checklistItems?.length ? shop.checklistItems : DEFAULT_CHECKLIST;
  return kind.checklist;
}

/** Active menu items offered for this kind: those for every kind (null) and those for the kind, by sortOrder. */
export async function servicesFor(shopId: string, kindKey: string) {
  return db.serviceItem.findMany({ where: { shopId, active: true, OR: [{ equipmentKind: null }, { equipmentKind: kindKey }] }, orderBy: { sortOrder: "asc" } });
}
