import "server-only";
// Promotions (tax-machine-sales-layaway-design.md section 2): scheduled sales the register applies by date, percent or
// amount off as the line's own discount, or the price including the tax (off until the owner turns it on past the
// state-law warning, owner's answer 5). Settings → Selling lists them. Every query by shopId.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { numberKey } from "@/lib/parts";
import { str } from "@/lib/format";
import { parseYmd } from "@/lib/zoned";
import { HOLIDAY_KINDS } from "@/lib/tax-holiday-math";
import { isEffect, readScope, type Promo, type PromoEffect } from "@/lib/promo-math";

export type PromoRow = Promo & { firstDay: string; lastDay: string; active: boolean; partNumbers: string[] };

function toPromo(r: { id: string; name: string; effect: string; value: number; scope: Prisma.JsonValue }): Promo {
  return { id: r.id, name: r.name, effect: (isEffect(r.effect) ? r.effect : "PERCENT") as PromoEffect, value: r.value, scope: readScope(r.scope) };
}

export async function listPromotions(shopId: string): Promise<PromoRow[]> {
  const rows = await db.promotion.findMany({ where: { shopId }, orderBy: { firstDay: "desc" } });
  const ids = [...new Set(rows.flatMap((r) => readScope(r.scope).partIds))];
  const nums = new Map(ids.length ? (await db.part.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, partNumber: true } })).map((p) => [p.id, p.partNumber]) : []);
  return rows.map((r) => {
    const p = toPromo(r);
    return { ...p, firstDay: r.firstDay, lastDay: r.lastDay, active: r.active, partNumbers: p.scope.partIds.map((id) => nums.get(id) ?? "?") };
  });
}

/** The promotions in force on a day; a tax-included one only while the shop allows them. */
export async function promotionsOn(shopId: string, ymd: string): Promise<Promo[]> {
  const [rows, shop] = await Promise.all([
    db.promotion.findMany({ where: { shopId, active: true, firstDay: { lte: ymd }, lastDay: { gte: ymd } }, orderBy: { createdAt: "asc" } }),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxIncludedOn: true } }),
  ]);
  return rows.map(toPromo).filter((p) => p.effect !== "TAX_INCLUDED" || shop.taxIncludedOn);
}

/** Adds (id null) or changes a promotion; owner or admin. Items are typed by their numbers. */
export async function savePromotionFor(user: CurrentUser, id: string | null, fd: FormData): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const shopId = user.shopId;
  const name = str(fd.get("name"))?.slice(0, 80);
  if (!name) throw new UserError("Name the sale, e.g. Fall machine sale.");
  const firstDay = parseYmd(str(fd.get("firstDay")));
  const lastDay = parseYmd(str(fd.get("lastDay"))) ?? firstDay;
  if (!firstDay || !lastDay) throw new UserError("Enter the first and last day.");
  if (lastDay < firstDay) throw new UserError("The last day is before the first.");
  const effect = str(fd.get("effect"));
  if (!isEffect(effect)) throw new UserError("Pick what the sale does.");
  if (effect === "TAX_INCLUDED") {
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxIncludedOn: true } });
    if (!shop.taxIncludedOn) throw new UserError('Turn on "price includes the tax" first (More options), after reading the warning.');
  }
  let value = 0;
  if (effect === "PERCENT") {
    value = Number(str(fd.get("value"))?.replace(/%$/, ""));
    if (!Number.isInteger(value) || value < 1 || value > 90) throw new UserError("Percent off: a whole number from 1 to 90.");
  } else if (effect === "AMOUNT") {
    const v = str(fd.get("value"));
    value = v == null ? NaN : Math.round(Number(v.replace(/[$,\s]/g, "")) * 100);
    if (!Number.isFinite(value) || value < 1 || value > 10_000_000) throw new UserError("Amount off each: enter dollars and cents, like 50.00.");
  }
  const known = new Set(HOLIDAY_KINDS.map((k) => k.key));
  const kinds = fd.getAll("kinds").map(String).filter((k) => known.has(k));
  const brands = [...new Set((str(fd.get("brands")) ?? "").split(/[,;\n]+/).map((b) => b.trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
  const typed = [...new Set((str(fd.get("items")) ?? "").split(/[,;\s]+/).map((n) => n.trim()).filter(Boolean))].slice(0, 100);
  const partIds: string[] = [];
  for (const n of typed) {
    const p = await db.part.findFirst({ where: { shopId, OR: [{ partNumber: { equals: n, mode: "insensitive" } }, { numberKeys: { has: numberKey(n) } }] }, select: { id: true } });
    if (!p) throw new UserError(`${n} isn't in your inventory.`);
    partIds.push(p.id);
  }
  if (!kinds.length && !brands.length && !partIds.length) throw new UserError("Say what the sale covers: tick kinds, type brands, or type item numbers.");
  const data = { name, firstDay, lastDay, effect, value, scope: { kinds, brands, partIds }, active: id ? fd.get("active") === "on" : true };
  if (!id) return (await db.promotion.create({ data: { shopId, ...data }, select: { id: true } })).id;
  const r = await db.promotion.updateMany({ where: { id, shopId }, data });
  if (!r.count) throw new UserError("Promotion not found.");
  return id;
}

/** Removes one; a promotion sales were made under is switched off instead (receipts name it). */
export async function deletePromotionFor(user: CurrentUser, id: string): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const used = await db.saleLine.count({ where: { promotionId: id, sale: { shopId: user.shopId } } });
  if (used) await db.promotion.updateMany({ where: { id, shopId: user.shopId }, data: { active: false } });
  else await db.promotion.deleteMany({ where: { id, shopId: user.shopId } });
}

/** The owner turns "price includes the tax" promotions on (having read the warning) or off. */
export async function setTaxIncludedFor(user: CurrentUser, on: boolean): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  await db.shop.update({ where: { id: user.shopId }, data: { taxIncludedOn: on } });
}

/** Promotion names by id, for receipts. */
export async function promotionNames(shopId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  return new Map((await db.promotion.findMany({ where: { shopId, id: { in: list } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
}
