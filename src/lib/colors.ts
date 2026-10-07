import "server-only";
// Color lookup at the counter (shop-features-round-2-design.md 2.2 and 6.2, package color-lookup): the register's search
// and its "Find a color" panel, "Colors she bought" on the customer's page, and the shop's own matches between items
// ("same as Madeira 1147", Part.sameAs, kept both ways). The program never guesses one maker's color for another's:
// only matches the shop linked itself are shown. Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId, sameText } from "@/lib/input";
import { numberKey } from "@/lib/parts";
import { FIRST_PHOTO, viewItem, type RegisterItem } from "@/lib/register-item";
import { colorScore, colorTokens } from "@/lib/color-match";
import type { CurrentUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import type { Prisma } from "@/generated/prisma/client";

/** Items that carry details: a color number or name, a type, or a thread saved before types. */
const HAS_DETAILS: Prisma.PartWhereInput = { OR: [{ colorNumber: { not: null } }, { colorName: { not: null } }, { itemType: { not: null } }, { kind: "THREAD" }] };

/** The most items a lookup scores (a shop's whole thread wall is a few thousand). */
const MAX_CANDIDATES = 6000;

export type SameAsItem = { id: string; label: string; colorHex: string | null; qtyOnHand: number; location: string | null; item: RegisterItem };

export type ColorHit = RegisterItem & {
  location: string | null;
  /** The shop's own matches for it, with their stock. */
  sameAs: SameAsItem[];
  /** "Colors she bought": when she last bought it, and that day in the shop's time zone ("Oct 7, 2026"). */
  boughtAt?: Date | null;
  boughtText?: string;
};

type PartRow = Prisma.PartGetPayload<{ include: typeof FIRST_PHOTO }>;

/** "Madeira 1147 Navy", or the item's number and description when it has no color number. */
const labelOf = (p: { brand: string | null; colorNumber: string | null; colorName: string | null; partNumber: string; description: string }) =>
  p.colorNumber ? [p.brand, p.colorNumber, p.colorName].filter(Boolean).join(" ") : `${p.partNumber} ${p.description}`;

/** The shop's own matches of these items (only its own items, whatever the ids say). */
async function withSameAs(shopId: string, rows: PartRow[]): Promise<Map<string, SameAsItem[]>> {
  const ids = [...new Set(rows.flatMap((r) => r.sameAs))].filter((id) => /^[a-z0-9]{10,40}$/i.test(id));
  const others = ids.length ? await db.part.findMany({ where: { shopId, id: { in: ids } }, include: FIRST_PHOTO }) : [];
  const byId = new Map(others.map((o) => [o.id, o]));
  const out = new Map<string, SameAsItem[]>();
  for (const r of rows) {
    out.set(
      r.id,
      r.sameAs
        .map((id) => byId.get(id))
        .filter((o): o is PartRow => !!o && o.id !== r.id)
        .map((o) => ({ id: o.id, label: labelOf(o), colorHex: o.colorHex, qtyOnHand: o.qtyOnHand, location: o.location, item: viewItem(o) })),
    );
  }
  return out;
}

const hitOf = (p: PartRow, same: Map<string, SameAsItem[]>, bought?: { at: Date; tz: string }): ColorHit => ({
  ...viewItem(p),
  location: p.location,
  sameAs: same.get(p.id) ?? [],
  ...(bought ? { boughtAt: bought.at, boughtText: fmtDate(bought.at, bought.tz) } : {}),
});

/**
 * The items whose details match what was typed (every word has to match something), best first: an exact color number
 * before a near one, in stock before none, the shop's own stock before a partner's consigned stock. At most `take`.
 */
export async function findColorsFor(shopId: string, q: string, take = 40): Promise<ColorHit[]> {
  const tokens = colorTokens(String(q ?? "").slice(0, 80));
  if (!tokens.length) return [];
  const rows = await db.part.findMany({ where: { shopId, ...HAS_DETAILS }, include: FIRST_PHOTO, take: MAX_CANDIDATES, orderBy: { partNumber: "asc" } });
  const scored = rows
    .map((p) => ({ p, s: colorScore(p, tokens) }))
    .filter((x): x is { p: PartRow; s: number } => x.s != null)
    .sort((a, b) => b.s - a.s || Number(b.p.qtyOnHand > 0) - Number(a.p.qtyOnHand > 0) || Number(!!a.p.consignLinkId) - Number(!!b.p.consignLinkId) || a.p.partNumber.localeCompare(b.p.partNumber))
    .slice(0, take)
    .map((x) => x.p);
  const same = await withSameAs(shopId, scored);
  return scored.map((p) => hitOf(p, same));
}

/**
 * "Colors she bought": the items with details (thread, filament...) on a customer's sales that stand, newest first, each
 * once, with today's stock, for "the same as last time". Returns are left out.
 */
export async function colorsBoughtBy(shopId: string, customerId: string, take = 30): Promise<ColorHit[]> {
  if (!/^[a-z0-9]{10,40}$/i.test(customerId)) return [];
  const lines = await db.saleLine.findMany({
    where: { qty: { gt: 0 }, partId: { not: null }, sale: { shopId, customerId, status: "COMPLETED" }, part: { shopId, ...HAS_DETAILS } },
    select: { partId: true, sale: { select: { createdAt: true } } },
    orderBy: { sale: { createdAt: "desc" } },
    take: 500,
  });
  const last = new Map<string, Date>();
  for (const l of lines) if (l.partId && !last.has(l.partId)) last.set(l.partId, l.sale.createdAt);
  const ids = [...last.keys()].slice(0, take);
  if (!ids.length) return [];
  const rows = await db.part.findMany({ where: { shopId, id: { in: ids } }, include: FIRST_PHOTO });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is PartRow => !!r);
  const [same, tz] = await Promise.all([withSameAs(shopId, ordered), shopTimeZone(shopId)]);
  return ordered.map((p) => hitOf(p, same, { at: last.get(p.id)!, tz }));
}

/** An item's own matches, for its page. */
export async function sameAsOf(shopId: string, partId: string): Promise<SameAsItem[]> {
  const p = await db.part.findFirst({ where: { id: partId, shopId }, include: FIRST_PHOTO });
  if (!p) return [];
  return (await withSameAs(shopId, [p])).get(p.id) ?? [];
}

async function ownPart(shopId: string, id: string) {
  const p = await db.part.findFirst({ where: { id: assertId(id), shopId }, select: { id: true, partNumber: true, sameAs: true } });
  if (!p) throw new UserError("Item not found.");
  return p;
}

/**
 * Links two of the shop's items as the same color, both ways: the other is found by its number (any capitals) or another
 * number it goes by. Linking an item to itself, or to one it is already linked to, is refused in words.
 */
export async function linkSameAsFor(user: CurrentUser, partId: string, typed: string): Promise<string> {
  const p = await ownPart(user.shopId, partId);
  const number = String(typed ?? "").split(" | ")[0].trim();
  if (!number) throw new UserError("Enter the other item's number, like MAD-1147.");
  const other = await db.part.findFirst({
    where: { shopId: user.shopId, id: { not: p.id }, OR: [{ partNumber: sameText(number) }, { numberKeys: { has: numberKey(number) } }] },
    select: { id: true, partNumber: true, sameAs: true },
    orderBy: { partNumber: "asc" },
  });
  if (!other) throw new UserError(`No other item numbered ${number} in inventory.`);
  if (p.sameAs.includes(other.id)) throw new UserError(`${p.partNumber} is already marked the same color as ${other.partNumber}.`);
  await db.$transaction([
    db.part.updateMany({ where: { id: p.id, shopId: user.shopId }, data: { sameAs: { set: [...new Set([...p.sameAs, other.id])].slice(0, 50) } } }),
    db.part.updateMany({ where: { id: other.id, shopId: user.shopId }, data: { sameAs: { set: [...new Set([...other.sameAs, p.id])].slice(0, 50) } } }),
  ]);
  return `${p.partNumber} and ${other.partNumber} are marked the same color.`;
}

/** Takes a match off, both ways. */
export async function unlinkSameAsFor(user: CurrentUser, partId: string, otherId: string): Promise<string> {
  const p = await ownPart(user.shopId, partId);
  const other = await db.part.findFirst({ where: { id: assertId(otherId), shopId: user.shopId }, select: { id: true, partNumber: true, sameAs: true } });
  await db.$transaction([
    db.part.updateMany({ where: { id: p.id, shopId: user.shopId }, data: { sameAs: { set: p.sameAs.filter((x) => x !== otherId) } } }),
    ...(other ? [db.part.updateMany({ where: { id: other.id, shopId: user.shopId }, data: { sameAs: { set: other.sameAs.filter((x) => x !== p.id) } } })] : []),
  ]);
  return other ? `${p.partNumber} and ${other.partNumber} are no longer marked the same color.` : "Taken off.";
}
