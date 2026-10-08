import "server-only";
// Birthdays and per-yard price breaks (shop-features-round-2-design.md 1.6). A customer's birthday is a month and day,
// only if she'd like to tell. The shop's birthday offer (Settings → Prices and members) is a percent off one sale or a
// store credit, during her birthday month, once a year: the register shows "Happy birthday month: 15% off today" and one
// tap uses it. The per-yard breaks ("10 yards or more of one fabric: 10% off", one or more steps) and an item's own break
// are priced by src/lib/price-rules.ts. Every query by shopId; bodies take the user so the check script can drive them.
import { Prisma as P, type Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { money, str, toCents } from "@/lib/format";
import { actorOf } from "@/lib/audit";
import { giveCredit } from "@/lib/gift-cards";
import { RULE_KINDS, type YardBreak } from "@/lib/price-rules";

export type BirthdayOffer = { kind: "pct" | "credit"; value: number };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (m: number) => MONTHS[m - 1] ?? "";

export function readOffer(raw: unknown): BirthdayOffer | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!o || (o.kind !== "pct" && o.kind !== "credit")) return null;
  const v = Number(o.value);
  return Number.isInteger(v) && v > 0 ? { kind: o.kind, value: v } : null;
}

/** "15% off one sale" / "a $10.00 store credit". */
export const offerWords = (o: BirthdayOffer) => (o.kind === "pct" ? `${o.value}% off one sale` : `a ${money(o.value)} store credit`);

export async function birthdayOfferOf(shopId: string): Promise<BirthdayOffer | null> {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { birthdayOffer: true } });
  return readOffer(s.birthdayOffer);
}

/** Settings: the birthday offer (none, a percent off one sale, or a store credit). Owner or admin. */
export async function saveBirthdayOfferFor(user: CurrentUser, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  await requireBaseWritable(user);
  const kind = str(fd.get("kind"));
  let offer: BirthdayOffer | null = null;
  if (kind === "pct") {
    const v = Number(str(fd.get("pct"))?.replace(/%$/, "") ?? "");
    if (!Number.isInteger(v) || v < 1 || v > 50) throw new UserError("Birthday percent: a whole number from 1 to 50.");
    offer = { kind, value: v };
  } else if (kind === "credit") {
    const v = toCents(str(fd.get("credit"))) ?? 0;
    if (v < 100 || v > 10_000) throw new UserError("Birthday credit: $1 to $100.");
    offer = { kind, value: v };
  }
  await db.shop.update({ where: { id: user.shopId }, data: { birthdayOffer: offer ? (offer as Prisma.InputJsonValue) : P.DbNull } });
}

/** A customer's birthday on her page ("only if she'd like to tell you"): month and day, or cleared. */
export async function saveBirthdayFor(user: CurrentUser, customerId: string, fd: FormData): Promise<void> {
  await requireBaseWritable(user);
  const c = await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId }, select: { id: true } });
  if (!c) throw new UserError("Customer not found.");
  const m = Number(str(fd.get("month")) ?? "");
  const d = Number(str(fd.get("day")) ?? "");
  if (!str(fd.get("month"))) {
    await db.customer.update({ where: { id: c.id }, data: { birthMonth: null, birthDay: null } });
    return;
  }
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new UserError("Pick the month.");
  if (!Number.isInteger(d) || d < 1 || d > days[m - 1]) throw new UserError(`${monthName(m)} has days 1 to ${days[m - 1]}.`);
  await db.customer.update({ where: { id: c.id }, data: { birthMonth: m, birthDay: d } });
}

/** The offer she can use today (her birthday month, not used this year), or null. `today` is YYYY-MM-DD in the shop's zone. */
export async function birthdayFor(shopId: string, customerId: string | null, today: string): Promise<(BirthdayOffer & { day: number }) | null> {
  if (!customerId) return null;
  const [offer, c] = await Promise.all([birthdayOfferOf(shopId), db.customer.findFirst({ where: { id: customerId, shopId }, select: { birthMonth: true, birthDay: true, birthdayUsedYear: true } })]);
  if (!offer || !c?.birthMonth || !c.birthDay) return null;
  const year = Number(today.slice(0, 4));
  if (c.birthMonth !== Number(today.slice(5, 7)) || c.birthdayUsedYear === year) return null;
  return { ...offer, day: c.birthDay };
}

type Tx = Prisma.TransactionClient;

/** Inside a sale that used the birthday percent: once a year (another register may have just used it). */
export async function markBirthdayUsed(tx: Tx, shopId: string, customerId: string, year: number): Promise<void> {
  const r = await tx.customer.updateMany({ where: { id: customerId, shopId, OR: [{ birthdayUsedYear: null }, { birthdayUsedYear: { not: year } }] }, data: { birthdayUsedYear: year } });
  if (!r.count) throw new UserError("Her birthday offer was just used. Take the birthday off and complete the sale.");
}

/** Voiding a sale that used it: she can use it again this year. */
export async function unuseBirthday(tx: Tx, shopId: string, customerId: string | null, year: number): Promise<void> {
  if (customerId) await tx.customer.updateMany({ where: { id: customerId, shopId, birthdayUsedYear: year }, data: { birthdayUsedYear: null } });
}

/** The credit kind: "Give her the birthday credit" puts it on her store credit (any staff; it's the shop's own offer). */
export async function giveBirthdayCreditAs(user: CurrentUser, customerId: string, today: string): Promise<string> {
  await requireBaseWritable(user);
  const b = await birthdayFor(user.shopId, customerId, today);
  if (!b || b.kind !== "credit") throw new UserError("No birthday credit for her today (not her birthday month, or used this year).");
  const c = await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId }, select: { id: true, name: true } });
  if (!c) throw new UserError("Customer not found.");
  await db.$transaction(async (tx) => {
    await markBirthdayUsed(tx, user.shopId, c.id, Number(today.slice(0, 4)));
    await giveCredit(tx, actorOf(user), { card: null, customerId: c.id, amountCents: b.value, reason: "LOADED", cause: { userId: user.id }, label: c.name, why: "Birthday credit" });
  });
  return `Happy birthday! ${money(b.value)} is on her store credit.`;
}

/** This month's birthdays (the dashboard's list, for a card or a campaign). */
export async function birthdaysIn(shopId: string, month: number): Promise<{ id: string; name: string; day: number; phone: string | null; email: string | null }[]> {
  const rows = await db.customer.findMany({ where: { shopId, birthMonth: month }, select: { id: true, name: true, birthDay: true, phone: true, email: true }, orderBy: [{ birthDay: "asc" }, { name: "asc" }], take: 500 });
  return rows.map((r) => ({ id: r.id, name: r.name, day: r.birthDay ?? 1, phone: r.phone, email: r.email }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-yard breaks

export async function yardBreaksFor(shopId: string): Promise<(YardBreak & { id: string })[]> {
  return (await db.yardBreak.findMany({ where: { shopId }, orderBy: { minYards: "asc" } })).map((b) => ({ id: b.id, minYards: b.minYards, pctOff: b.pctOff, kinds: b.kinds }));
}

/** Add a step ("10 yards or more: 10% off"). Owner or admin. */
export async function addYardBreakFor(user: CurrentUser, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  const min = Number(str(fd.get("minYards")) ?? "");
  const pct = Number(str(fd.get("pctOff"))?.replace(/%$/, "") ?? "");
  if (!Number.isFinite(min) || min < 1 || min > 1000) throw new UserError("From how many yards: 1 to 1,000.");
  if (!Number.isInteger(pct) || pct < 1 || pct > 50) throw new UserError("Percent off: a whole number from 1 to 50.");
  const keys = RULE_KINDS.map((k) => k.key);
  const kinds = fd.getAll("kinds").map(String).filter((k) => keys.includes(k));
  if ((await db.yardBreak.count({ where: { shopId: user.shopId } })) >= 10) throw new UserError("Ten steps at most.");
  await db.yardBreak.create({ data: { shopId: user.shopId, minYards: Math.round(min * 8) / 8, pctOff: pct, kinds } });
}

export async function removeYardBreakFor(user: CurrentUser, id: string): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
  const r = await db.yardBreak.deleteMany({ where: { id, shopId: user.shopId } });
  if (!r.count) throw new UserError("Yard break not found.");
}

/** An item's own break ("$18 a yard from 3 yards"); blank clears it. Owner or admin. */
export async function saveItemBreakFor(user: CurrentUser, partId: string, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change prices.");
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId }, select: { id: true, unit: true, priceCents: true } });
  if (!p) throw new UserError("Item not found.");
  const minRaw = str(fd.get("breakMinQty"));
  if (!minRaw) {
    await db.part.update({ where: { id: p.id }, data: { breakMinQty: null, breakPriceCents: null } });
    return;
  }
  if (p.unit !== "yd") throw new UserError("A yard break is for items sold by the yard.");
  const min = Number(minRaw);
  const price = toCents(str(fd.get("breakPrice")));
  if (!Number.isFinite(min) || min < 0.125 || min > 1000) throw new UserError("From how many yards: 1/8 to 1,000.");
  if (price == null || price <= 0) throw new UserError("Type the price a yard, like 18.00.");
  if (p.priceCents != null && price >= p.priceCents) throw new UserError("The break price should be lower than the item's price.");
  await db.part.update({ where: { id: p.id }, data: { breakMinQty: Math.round(min * 8) / 8, breakPriceCents: price } });
}
