import "server-only";
// Kits (fabric-smarts-design.md section 4, package F4): the kit builder, "Make N kits" and "Unmake 1", the Kits tab's
// numbers and Block of the Month series with their rosters. Each query filters by shopId; each id from the page is looked
// up with the signed-in company's shopId before anything is touched.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str, lineCostCents } from "@/lib/format";
import { MAX_CENTS, centsField, numberKey, partKeys, partNumberClash } from "@/lib/parts";
import { yards } from "@/lib/register-math";
import {
  KIT_SELECT,
  kitMarginPct,
  kitQtyProblem,
  makeableKits,
  partsCost,
  partsRetail,
  shortages,
  suggestKitPrice,
  type KitPart,
  type KitPrice,
  type KitSettings,
} from "@/lib/kits-math";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

export const MAX_KIT_LINES = 60;
export const MAX_KITS_AT_ONCE = 500;

const isFabricYards = (p: { kind: string; unit: string | null }) => p.kind === "FABRIC" && p.unit === "yd";
const amountText = (qty: number, unit: string | null) => (unit === "yd" ? `${yards(qty)} yd` : `${qty}`);

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

export type KitLineView = {
  partId: string;
  partNumber: string;
  description: string;
  kind: string;
  unit: string | null;
  qty: number;
  onHand: number;
  costCents: number | null;
  costTenThou: number | null;
  priceCents: number | null;
  /** This line's cost and shelf price for one kit, in cents. */
  lineCost: number;
  lineRetail: number;
  photoId: string | null;
};

export type KitView = {
  id: string;
  name: string;
  note: string | null;
  priceCents: number | null;
  patternNote: string | null;
  patternCostCents: number;
  pattern: { id: string; partNumber: string; description: string; onHand: number; costCents: number | null; priceCents: number | null } | null;
  /** The pattern's cost for one kit: the item's cost, else the typed cost. */
  patternCost: number;
  lines: KitLineView[];
  stock: { partId: string; partNumber: string; onHand: number } | null;
  cost: number;
  retail: number;
  suggestion: KitPrice;
  makeable: number | null;
  series: { id: string; name: string } | null;
  seriesMonth: number | null;
  handoutDoneAt: Date | null;
  settings: KitSettings;
};

/** The shop's kit settings. */
async function kitSettings(shopId: string): Promise<KitSettings> {
  return db.shop.findUniqueOrThrow({ where: { id: shopId }, select: KIT_SELECT });
}

/** One kit with its lines, costs, price suggestion and what the stock allows (by shopId and id), or null. */
export async function kitFor(shopId: string, id: string): Promise<KitView | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const [kit, settings] = await Promise.all([
    db.kit.findFirst({
      where: { id, shopId },
      include: {
        series: { select: { id: true, name: true } },
        part: { select: { id: true, partNumber: true, qtyOnHand: true } },
        lines: { include: { part: { select: { partNumber: true, description: true, kind: true, unit: true, qtyOnHand: true, costCents: true, costTenThou: true, priceCents: true, photos: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true } } } } } },
      },
    }),
    kitSettings(shopId),
  ]);
  if (!kit) return null;
  const pattern = kit.patternPartId ? await db.part.findFirst({ where: { id: kit.patternPartId, shopId }, select: { id: true, partNumber: true, description: true, qtyOnHand: true, costCents: true, costTenThou: true, priceCents: true } }) : null;
  const lines: KitLineView[] = kit.lines
    .map((l) => ({
      partId: l.partId,
      partNumber: l.part.partNumber,
      description: l.part.description,
      kind: l.part.kind,
      unit: l.part.unit,
      qty: l.qty,
      onHand: l.part.qtyOnHand,
      costCents: l.part.costCents,
      costTenThou: l.part.costTenThou,
      priceCents: l.part.priceCents,
      lineCost: l.part.costCents == null ? 0 : lineCostCents(l.qty, l.part.costCents, l.part.costTenThou),
      lineRetail: l.part.priceCents == null ? 0 : Math.round(l.qty * l.part.priceCents),
      photoId: l.part.photos[0]?.id ?? null,
    }))
    .sort((a, b) => a.partNumber.localeCompare(b.partNumber));
  const patternCost = pattern?.costCents != null ? lineCostCents(1, pattern.costCents, pattern.costTenThou) : kit.patternCostCents;
  const parts: KitPart[] = [...lines.map((l) => ({ qty: l.qty, costCents: l.costCents, costTenThou: l.costTenThou, priceCents: l.priceCents })), ...(pattern ? [{ qty: 1, costCents: pattern.costCents, costTenThou: pattern.costTenThou, priceCents: pattern.priceCents }] : [])];
  const cost = partsCost(parts) + (pattern?.costCents != null ? 0 : kit.patternCostCents);
  const retail = partsRetail(parts);
  return {
    id: kit.id,
    name: kit.name,
    note: kit.note,
    priceCents: kit.priceCents,
    patternNote: kit.patternNote,
    patternCostCents: kit.patternCostCents,
    pattern: pattern ? { id: pattern.id, partNumber: pattern.partNumber, description: pattern.description, onHand: pattern.qtyOnHand, costCents: pattern.costCents, priceCents: pattern.priceCents } : null,
    patternCost,
    lines,
    stock: kit.part ? { partId: kit.part.id, partNumber: kit.part.partNumber, onHand: kit.part.qtyOnHand } : null,
    cost,
    retail,
    suggestion: suggestKitPrice({ costCents: cost, retailCents: retail, marginPct: settings.fabKitMarginPct, bundlePct: settings.fabBundleDiscountPct }),
    makeable: makeableKits([...lines.map((l) => ({ qty: l.qty, onHand: l.onHand })), ...(pattern ? [{ qty: 1, onHand: pattern.qtyOnHand }] : [])]),
    series: kit.series,
    seriesMonth: kit.seriesMonth,
    handoutDoneAt: kit.handoutDoneAt,
    settings,
  };
}

export type KitRow = {
  id: string;
  name: string;
  stock: number;
  cost: number;
  priceCents: number | null;
  marginPct: number | null;
  sold30: number;
  sold90: number;
  makeable: number | null;
  series: string | null;
  seriesMonth: number | null;
  /** The kit's own item has a photo to show. */
  photoId: string | null;
};

/** The Kits tab: each kit with its stock, cost, price, margin and kits sold in the last 30 and 90 days (completed sales). */
export async function kitsFor(shopId: string, now = new Date()): Promise<KitRow[]> {
  const kits = await db.kit.findMany({ where: { shopId }, orderBy: { name: "asc" }, select: { id: true } });
  const views = (await Promise.all(kits.map((k) => kitFor(shopId, k.id)))).filter((k): k is KitView => k != null);
  const partIds = views.map((v) => v.stock?.partId).filter((x): x is string => !!x);
  const d90 = new Date(now.getTime() - 90 * 86_400_000);
  const d30 = now.getTime() - 30 * 86_400_000;
  const sold = partIds.length ? await db.saleLine.findMany({ where: { partId: { in: partIds }, sale: { shopId, status: "COMPLETED", createdAt: { gte: d90 } } }, select: { partId: true, qty: true, sale: { select: { createdAt: true } } } }) : [];
  const photos = partIds.length ? await db.partPhoto.findMany({ where: { shopId, partId: { in: partIds } }, orderBy: { sortOrder: "asc" }, select: { id: true, partId: true } }) : [];
  const photoOf = new Map<string, string>();
  for (const p of photos) if (!photoOf.has(p.partId)) photoOf.set(p.partId, p.id);
  return views.map((v) => {
    const mine = sold.filter((s) => s.partId === v.stock?.partId);
    return {
      id: v.id,
      name: v.name,
      stock: v.stock?.onHand ?? 0,
      cost: v.cost,
      priceCents: v.priceCents,
      marginPct: kitMarginPct(v.priceCents, v.cost),
      sold30: mine.filter((s) => s.sale.createdAt.getTime() >= d30).reduce((a, s) => a + s.qty, 0),
      sold90: mine.reduce((a, s) => a + s.qty, 0),
      makeable: v.makeable,
      series: v.series?.name ?? null,
      seriesMonth: v.seriesMonth,
      photoId: v.lines.find((l) => l.photoId)?.photoId ?? (v.stock ? (photoOf.get(v.stock.partId) ?? null) : null),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------------------------

/** A company's own item by the number typed ("number | words" from the suggestions works), or a not-found error. */
async function itemByNumber(tx: Prisma.TransactionClient, shopId: string, typed: string) {
  const number = typed.split(" | ")[0].trim();
  if (!number) throw new UserError("Enter an item number.");
  const part = await tx.part.findFirst({ where: { shopId, consignLinkId: null, OR: [{ partNumber: { equals: number, mode: "insensitive" } }, { numberKeys: { has: numberKey(number) } }] } });
  if (!part) throw new UserError(`No item numbered ${number} in inventory.`);
  return part;
}

type LineInput = { item: string; qty: number };

/** Reads the builder's rows: item.i and qty.i; blank rows are skipped. */
export function kitLineRows(fd: FormData): LineInput[] {
  const rows: LineInput[] = [];
  for (let i = 0; i < MAX_KIT_LINES + 20; i++) {
    const item = str(fd.get(`item.${i}`));
    const q = str(fd.get(`qty.${i}`));
    if (!item && !q) continue;
    if (!item) throw new UserError(`Line ${rows.length + 1}: enter the item number.`);
    const qty = q ? Number(q) : NaN;
    if (!Number.isFinite(qty)) throw new UserError(`${item.split(" | ")[0]}: enter how much goes in one kit.`);
    rows.push({ item, qty });
  }
  if (rows.length > MAX_KIT_LINES) throw new UserError(`${MAX_KIT_LINES} lines at most in a kit.`);
  return rows;
}

function kitPartNumber(name: string): string {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  return `KIT-${slug || "KIT"}`;
}

/**
 * Saves a kit (new when `kitId` is null): the name, note, pattern (a PATTERN item, or a note and a cost), the lines, and the
 * price (blank: the suggestion). The kit's own stock item is made on the first save and kept in step with the kit's name,
 * price and cost after that. Returns the kit's id and a sentence.
 */
export async function saveKitFor(user: CurrentUser, kitId: string | null, fd: FormData): Promise<{ id: string; text: string }> {
  if (kitId) assertId(kitId);
  const name = str(fd.get("name"));
  if (!name) throw new UserError("Give the kit a name.");
  if (name.length > 80) throw new UserError("The kit's name is 80 characters at most.");
  const note = str(fd.get("note"));
  const patternNote = str(fd.get("patternNote"));
  const patternCost = centsField(str(fd.get("patternCost")), "Pattern cost") ?? 0;
  if (patternCost < 0 || patternCost > MAX_CENTS) throw new UserError("Pattern cost: enter an amount in dollars.");
  const typedPrice = centsField(str(fd.get("price")), "Kit price");
  if (typedPrice != null && (typedPrice < 0 || typedPrice > MAX_CENTS)) throw new UserError("Kit price: enter an amount in dollars.");
  const rows = kitLineRows(fd);
  const settings = await kitSettings(user.shopId);
  const patternTyped = str(fd.get("pattern"));
  const out = await db
    .$transaction(async (tx) => {
      const dup = await tx.kit.findFirst({ where: { shopId: user.shopId, name: { equals: name, mode: "insensitive" }, ...(kitId ? { id: { not: kitId } } : {}) }, select: { name: true } });
      if (dup) throw new UserError(`A kit named ${dup.name} already exists.`);
      const existing = kitId ? await tx.kit.findFirst({ where: { id: kitId, shopId: user.shopId } }) : null;
      if (kitId && !existing) throw new UserError("Kit not found.");
      const pattern = patternTyped ? await itemByNumber(tx, user.shopId, patternTyped) : null;
      if (pattern && pattern.kind !== "PATTERN") throw new UserError(`${pattern.partNumber} isn't a pattern item (its kind is ${pattern.kind.toLowerCase()}). Change the kind in the item, or give the pattern as a note.`);
      const lines = new Map<string, { part: Awaited<ReturnType<typeof itemByNumber>>; qty: number }>();
      for (const r of rows) {
        const part = await itemByNumber(tx, user.shopId, r.item);
        const problem = kitQtyProblem(part.unit, r.qty);
        if (problem) throw new UserError(`${part.partNumber}: ${problem}.`);
        if (part.id === existing?.partId) throw new UserError(`${part.partNumber} is this kit's own stock item: it can't be one of its parts.`);
        if (lines.has(part.id)) throw new UserError(`${part.partNumber} is in the kit twice. Put the whole amount on one line.`);
        lines.set(part.id, { part, qty: r.qty });
      }
      if (!lines.size) throw new UserError("Add at least one fabric or notion to the kit.");
      const parts: KitPart[] = [...lines.values()].map(({ part, qty }) => ({ qty, costCents: part.costCents, costTenThou: part.costTenThou, priceCents: part.priceCents }));
      if (pattern) parts.push({ qty: 1, costCents: pattern.costCents, costTenThou: pattern.costTenThou, priceCents: pattern.priceCents });
      // A tech can't set prices or costs (as in updatePart): a pattern cost they type is ignored (the kit's own kept, none
      // on a new kit), so it moves neither the suggestion nor the stock item's cost.
      const tech = user.role === "TECH";
      const patternCostCents = tech ? (existing?.patternCostCents ?? 0) : patternCost;
      const cost = partsCost(parts) + (pattern?.costCents != null ? 0 : patternCostCents);
      const suggestion = suggestKitPrice({ costCents: cost, retailCents: partsRetail(parts), marginPct: settings.fabKitMarginPct, bundlePct: settings.fabBundleDiscountPct });
      // A tech's save keeps the kit's price, or takes the suggestion for a new kit.
      const price = tech ? (existing?.priceCents ?? suggestion.priceCents) : (typedPrice ?? suggestion.priceCents);
      const data = { name, note, patternPartId: pattern?.id ?? null, patternNote, patternCostCents, priceCents: price };
      const kit = existing ? await tx.kit.update({ where: { id: existing.id }, data }) : await tx.kit.create({ data: { shopId: user.shopId, ...data } });
      await tx.kitLine.deleteMany({ where: { kitId: kit.id, shopId: user.shopId } });
      await tx.kitLine.createMany({ data: [...lines.values()].map(({ part, qty }) => ({ shopId: user.shopId, kitId: kit.id, partId: part.id, qty })) });
      // The kit's own stock item: made now, then kept in step.
      const stockData = { description: `${name} (kit)`, priceCents: price, costCents: cost, costTenThou: null };
      if (existing?.partId && (await tx.part.findFirst({ where: { id: existing.partId, shopId: user.shopId }, select: { id: true } }))) {
        // A tech's save leaves the stock item's cost as it is (updatePart does the same).
        await tx.part.update({ where: { id: existing.partId }, data: tech ? { description: stockData.description, priceCents: price } : stockData });
      } else {
        let partNumber = kitPartNumber(name);
        for (let n = 2; await tx.part.findFirst({ where: { shopId: user.shopId, partNumber: { equals: partNumber, mode: "insensitive" } }, select: { id: true } }); n++) partNumber = `${kitPartNumber(name)}-${n}`;
        const stock = await tx.part.create({ data: { shopId: user.shopId, partNumber, numberKeys: partKeys(partNumber, []), ownNumber: true, kind: "ACCESSORY", qtyOnHand: 0, ...stockData } });
        await tx.kit.update({ where: { id: kit.id }, data: { partId: stock.id } });
      }
      return { id: kit.id, text: `${existing ? "Saved" : "Made"} ${name}: cost ${dollars(cost)}, price ${dollars(price)}${typedPrice == null ? " (suggested)" : ""}.` };
    })
    .catch(async (e: unknown) => {
      throw await partNumberClash(e, user.shopId, kitPartNumber(name));
    });
  return out;
}

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Deletes a kit that has none made (the kit's stock item stays in inventory, with its history). */
export async function deleteKitFor(user: CurrentUser, kitId: string): Promise<string> {
  assertId(kitId);
  return db.$transaction(async (tx) => {
    const kit = await tx.kit.findFirst({ where: { id: kitId, shopId: user.shopId }, include: { part: { select: { qtyOnHand: true } } } });
    if (!kit) throw new UserError("Kit not found.");
    if (kit.part && kit.part.qtyOnHand > 0) throw new UserError(`${kit.name} has ${kit.part.qtyOnHand} made kits in stock. Sell them, or unmake them, first.`);
    await tx.kit.delete({ where: { id: kit.id } });
    return `Deleted ${kit.name}.`;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Make and unmake
// ---------------------------------------------------------------------------------------------------------------

type Take = { part: { id: string; partNumber: string; kind: string; unit: string | null; qtyOnHand: number }; qty: number };

async function takes(tx: Prisma.TransactionClient, shopId: string, kit: { patternPartId: string | null; lines: { partId: string; qty: number }[] }): Promise<Take[]> {
  const out: Take[] = [];
  for (const l of kit.lines) {
    const part = await tx.part.findFirst({ where: { id: l.partId, shopId }, select: { id: true, partNumber: true, kind: true, unit: true, qtyOnHand: true } });
    if (!part) throw new UserError("One of the kit's items is no longer in inventory. Open the kit and fix its lines.");
    out.push({ part, qty: l.qty });
  }
  if (kit.patternPartId) {
    const part = await tx.part.findFirst({ where: { id: kit.patternPartId, shopId }, select: { id: true, partNumber: true, kind: true, unit: true, qtyOnHand: true } });
    if (!part) throw new UserError("The kit's pattern is no longer in inventory. Open the kit and fix it.");
    out.push({ part, qty: 1 });
  }
  return out;
}

/** The cost of one kit from the items as they are now (also what the kit's stock item is told to cost). */
async function costNow(tx: Prisma.TransactionClient, shopId: string, kit: { patternPartId: string | null; patternCostCents: number; lines: { partId: string; qty: number }[] }): Promise<number> {
  const ids = [...kit.lines.map((l) => l.partId), ...(kit.patternPartId ? [kit.patternPartId] : [])];
  const found = await tx.part.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, costCents: true, costTenThou: true } });
  const by = new Map(found.map((p) => [p.id, p]));
  const parts: KitPart[] = kit.lines.map((l) => ({ qty: l.qty, costCents: by.get(l.partId)?.costCents ?? null, costTenThou: by.get(l.partId)?.costTenThou ?? null, priceCents: null }));
  const pat = kit.patternPartId ? by.get(kit.patternPartId) : null;
  if (pat) parts.push({ qty: 1, costCents: pat.costCents, costTenThou: pat.costTenThou, priceCents: null });
  return partsCost(parts) + (pat?.costCents != null ? 0 : kit.patternCostCents);
}

/**
 * Makes `n` kits in one transaction: checks every line is on the shelf (naming what is short), takes the yards off (a CUT
 * move for fabric) and the items (USED, the pattern too), each move naming the kit's stock item, and adds n to that item
 * (a RECEIVED move). All or none.
 */
export async function makeKitsFor(user: CurrentUser, kitId: string, n: number): Promise<string> {
  assertId(kitId);
  if (!Number.isInteger(n) || n < 1) throw new UserError("How many kits? Enter a whole number, 1 or more.");
  if (n > MAX_KITS_AT_ONCE) throw new UserError(`${MAX_KITS_AT_ONCE} kits at most at a time.`);
  return db.$transaction(async (tx) => {
    const kit = await tx.kit.findFirst({ where: { id: kitId, shopId: user.shopId }, include: { lines: true } });
    if (!kit) throw new UserError("Kit not found.");
    if (!kit.partId) throw new UserError(`${kit.name} has no stock item yet. Save the kit first.`);
    const stock = await tx.part.findFirst({ where: { id: kit.partId, shopId: user.shopId }, select: { id: true, partNumber: true } });
    if (!stock) throw new UserError(`${kit.name}'s stock item is gone from inventory. Save the kit again to make a new one.`);
    if (!kit.lines.length) throw new UserError(`${kit.name} has no lines yet.`);
    const list = await takes(tx, user.shopId, kit);
    const short = shortages(list.map((t) => ({ partNumber: t.part.partNumber, qty: t.qty, onHand: t.part.qtyOnHand, unit: t.part.unit })), n);
    if (short.length) {
      throw new UserError(`Not enough for ${n} ${n === 1 ? "kit" : "kits"}: ${short.slice(0, 4).map((s) => `${s.partNumber} needs ${amountText(s.need, s.unit)}, has ${amountText(s.have, s.unit)}`).join("; ")}${short.length > 4 ? `; and ${short.length - 4} more` : ""}.`);
    }
    const why = `Made ${n} ${n === 1 ? "kit" : "kits"}: ${kit.name}`;
    let fabricYards = 0;
    for (const t of list) {
      const need = t.qty * n;
      // Only while the stock is all still there (two makes at once can't take the same yards).
      const took = await tx.part.updateMany({ where: { id: t.part.id, shopId: user.shopId, qtyOnHand: { gte: need } }, data: { qtyOnHand: { decrement: need } } });
      if (took.count !== 1) throw new UserError(`${t.part.partNumber} changed while the kits were being made. Look at the stock and try again.`);
      const cut = isFabricYards(t.part);
      if (cut) fabricYards += need;
      await tx.stockMove.create({ data: { shopId: user.shopId, partId: t.part.id, qty: -need, reason: cut ? "CUT" : "USED", userId: user.id, note: why, otherPartId: stock.id } });
    }
    await tx.part.update({ where: { id: stock.id }, data: { qtyOnHand: { increment: n }, costCents: await costNow(tx, user.shopId, kit), costTenThou: null } });
    await tx.stockMove.create({ data: { shopId: user.shopId, partId: stock.id, qty: n, reason: "RECEIVED", userId: user.id, note: why } });
    const now = await tx.part.findUniqueOrThrow({ where: { id: stock.id }, select: { qtyOnHand: true } });
    return `Made ${n} ${n === 1 ? "kit" : "kits"} of ${kit.name}${fabricYards > 0 ? `, ${yards(fabricYards)} yd of fabric cut` : ""}. ${now.qtyOnHand} in stock.`;
  });
}

/**
 * Unmakes one kit: takes one off the kit's stock and puts the kit's lines back (a CUT move for fabric, RETURNED for the
 * rest). It returns what the recipe says now; refused when no made kit is in stock (they were sold).
 */
export async function unmakeKitFor(user: CurrentUser, kitId: string): Promise<string> {
  assertId(kitId);
  return db.$transaction(async (tx) => {
    const kit = await tx.kit.findFirst({ where: { id: kitId, shopId: user.shopId }, include: { lines: true } });
    if (!kit) throw new UserError("Kit not found.");
    if (!kit.partId) throw new UserError(`${kit.name} has no stock item.`);
    const stock = await tx.part.findFirst({ where: { id: kit.partId, shopId: user.shopId }, select: { id: true } });
    if (!stock) throw new UserError(`${kit.name}'s stock item is gone from inventory.`);
    const list = await takes(tx, user.shopId, kit);
    const took = await tx.part.updateMany({ where: { id: stock.id, shopId: user.shopId, qtyOnHand: { gte: 1 } }, data: { qtyOnHand: { decrement: 1 } } });
    if (took.count !== 1) throw new UserError(`No made ${kit.name} is in stock to unmake (the rest were sold).`);
    const why = `Unmade 1 kit: ${kit.name}`;
    await tx.stockMove.create({ data: { shopId: user.shopId, partId: stock.id, qty: -1, reason: "ADJUSTED", userId: user.id, note: why } });
    for (const t of list) {
      await tx.part.update({ where: { id: t.part.id }, data: { qtyOnHand: { increment: t.qty } } });
      await tx.stockMove.create({ data: { shopId: user.shopId, partId: t.part.id, qty: t.qty, reason: isFabricYards(t.part) ? "CUT" : "RETURNED", userId: user.id, note: why, otherPartId: stock.id } });
    }
    const now = await tx.part.findUniqueOrThrow({ where: { id: stock.id }, select: { qtyOnHand: true } });
    return `Unmade 1 ${kit.name}: its parts are back on the shelf. ${now.qtyOnHand} left in stock.`;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Block of the Month
// ---------------------------------------------------------------------------------------------------------------

export type SeriesRow = { id: string; name: string; months: number; kits: number; members: number; done: number };

export async function seriesListFor(shopId: string): Promise<SeriesRow[]> {
  const rows = await db.kitSeries.findMany({ where: { shopId }, orderBy: { name: "asc" }, include: { kits: { select: { handoutDoneAt: true } }, _count: { select: { members: true } } } });
  return rows.map((s) => ({ id: s.id, name: s.name, months: s.months, kits: s.kits.length, members: s._count.members, done: s.kits.filter((k) => k.handoutDoneAt).length }));
}

export type SeriesView = {
  id: string;
  name: string;
  months: number;
  note: string | null;
  slots: { month: number; kit: { id: string; name: string; handoutDoneAt: Date | null } | null }[];
  members: { id: string; customerId: string; name: string; phone: string | null; email: string | null; signedUpAt: Date; note: string | null }[];
  /** The company's kits that could go in a month: not in this series yet. */
  free: { id: string; name: string; series: string | null }[];
  timeZone: string;
};

export async function seriesFor(shopId: string, id: string): Promise<SeriesView | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const [s, kits, shop] = await Promise.all([
    db.kitSeries.findFirst({ where: { id, shopId }, include: { kits: { select: { id: true, name: true, seriesMonth: true, handoutDoneAt: true } }, members: { orderBy: { signedUpAt: "asc" }, include: { customer: { select: { name: true, phone: true, email: true } } } } } }),
    db.kit.findMany({ where: { shopId }, orderBy: { name: "asc" }, select: { id: true, name: true, seriesId: true, series: { select: { name: true } } } }),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } }),
  ]);
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    months: s.months,
    note: s.note,
    slots: Array.from({ length: s.months }, (_, i) => {
      const kit = s.kits.find((k) => k.seriesMonth === i + 1);
      return { month: i + 1, kit: kit ? { id: kit.id, name: kit.name, handoutDoneAt: kit.handoutDoneAt } : null };
    }),
    members: s.members.map((m) => ({ id: m.id, customerId: m.customerId, name: m.customer.name, phone: m.customer.phone, email: m.customer.email, signedUpAt: m.signedUpAt, note: m.note })),
    free: kits.filter((k) => k.seriesId !== s.id).map((k) => ({ id: k.id, name: k.name, series: k.series?.name ?? null })),
    timeZone: shop.timeZone,
  };
}

export async function createSeriesFor(user: CurrentUser, fd: FormData): Promise<string> {
  const name = str(fd.get("name"));
  if (!name) throw new UserError("Name the Block of the Month.");
  if (name.length > 80) throw new UserError("The name is 80 characters at most.");
  const months = Number(str(fd.get("months")) ?? "12");
  if (!Number.isInteger(months) || months < 2 || months > 12) throw new UserError("Months: a whole number from 2 to 12.");
  const dup = await db.kitSeries.findFirst({ where: { shopId: user.shopId, name: { equals: name, mode: "insensitive" } }, select: { name: true } });
  if (dup) throw new UserError(`A series named ${dup.name} already exists.`);
  const s = await db.kitSeries.create({ data: { shopId: user.shopId, name, months, note: str(fd.get("note")) } });
  return s.id;
}

/** Puts a kit in a month of the series (the kit that was there leaves it), or empties the month when `kitId` is blank. */
export async function linkKitFor(user: CurrentUser, seriesId: string, month: number, kitId: string | null): Promise<string> {
  assertId(seriesId);
  return db.$transaction(async (tx) => {
    const s = await tx.kitSeries.findFirst({ where: { id: seriesId, shopId: user.shopId } });
    if (!s) throw new UserError("Series not found.");
    if (!Number.isInteger(month) || month < 1 || month > s.months) throw new UserError(`Month: 1 to ${s.months}.`);
    await tx.kit.updateMany({ where: { shopId: user.shopId, seriesId: s.id, seriesMonth: month }, data: { seriesId: null, seriesMonth: null, handoutDoneAt: null } });
    if (!kitId) return `Month ${month} is empty.`;
    assertId(kitId);
    const kit = await tx.kit.findFirst({ where: { id: kitId, shopId: user.shopId } });
    if (!kit) throw new UserError("Kit not found.");
    await tx.kit.update({ where: { id: kit.id }, data: { seriesId: s.id, seriesMonth: month, handoutDoneAt: null } });
    return `${kit.name} is month ${month} of ${s.name}.`;
  });
}

/** Marks a month's handout (the printed instructions) done, or takes the mark back. */
export async function setHandoutFor(user: CurrentUser, kitId: string, done: boolean): Promise<string> {
  assertId(kitId);
  const kit = await db.kit.findFirst({ where: { id: kitId, shopId: user.shopId }, select: { id: true, name: true, seriesId: true } });
  if (!kit) throw new UserError("Kit not found.");
  if (!kit.seriesId) throw new UserError(`${kit.name} isn't a month of a series.`);
  await db.kit.update({ where: { id: kit.id }, data: { handoutDoneAt: done ? new Date() : null } });
  return done ? `Handout for ${kit.name} marked done.` : `Handout for ${kit.name} is not done.`;
}

export async function addMemberFor(user: CurrentUser, seriesId: string, customerId: string, note: string | null): Promise<string> {
  assertId(seriesId);
  if (!customerId) throw new UserError("Search for the customer, then pick them.");
  assertId(customerId);
  const [s, c] = await Promise.all([db.kitSeries.findFirst({ where: { id: seriesId, shopId: user.shopId }, select: { id: true, name: true } }), db.customer.findFirst({ where: { id: customerId, shopId: user.shopId }, select: { id: true, name: true } })]);
  if (!s) throw new UserError("Series not found.");
  if (!c) throw new UserError("Customer not found.");
  try {
    await db.kitSeriesMember.create({ data: { shopId: user.shopId, seriesId: s.id, customerId: c.id, note: note ? note.slice(0, 200) : null } });
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") throw new UserError(`${c.name} is already signed up for ${s.name}.`);
    throw e;
  }
  return `${c.name} is signed up for ${s.name}.`;
}

export async function removeMemberFor(user: CurrentUser, memberId: string): Promise<string> {
  assertId(memberId);
  const m = await db.kitSeriesMember.findFirst({ where: { id: memberId, shopId: user.shopId }, include: { customer: { select: { name: true } } } });
  if (!m) throw new UserError("Sign-up not found.");
  await db.kitSeriesMember.delete({ where: { id: m.id } });
  return `${m.customer.name} is off the roster.`;
}

/** Deletes a series (its kits stay, out of any month); the roster goes with it. */
export async function deleteSeriesFor(user: CurrentUser, seriesId: string): Promise<string> {
  assertId(seriesId);
  const s = await db.kitSeries.findFirst({ where: { id: seriesId, shopId: user.shopId } });
  if (!s) throw new UserError("Series not found.");
  await db.$transaction([db.kit.updateMany({ where: { shopId: user.shopId, seriesId: s.id }, data: { seriesId: null, seriesMonth: null, handoutDoneAt: null } }), db.kitSeries.delete({ where: { id: s.id } })]);
  return `Deleted ${s.name}.`;
}
