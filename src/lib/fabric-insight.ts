import "server-only";
// Fabric insight (fabric-smarts-design.md, package F2): What sells, Slow fabric and the markdown ladder. Everything is
// rebuilt from the company's own rows each time the page opens (stock moves for the daily balances and the receipts,
// completed sale lines for what sold and what it cost), so there is nothing to keep in step. Each query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { yards } from "@/lib/register-math";
import { cutPrices } from "@/lib/fabric-math";
import { dateIn, todayIn } from "@/lib/time-zone";
import {
  INSIGHT_SELECT,
  abcGrades,
  blendVelocity,
  convertVsMarkdown,
  dayBalances,
  daysAgo,
  fifoAge,
  gmroi,
  gmroiBand,
  ladderView,
  priceBand,
  priorRate,
  slowStage,
  velocityOf,
  weeksOfSupply,
  yardCostTenThou,
  type Aged,
  type Convert,
  type Grade,
  type GmroiBand,
  type InsightSettings,
  type LadderRow,
  type LadderView,
  type Lot,
  type SlowStage,
} from "@/lib/fabric-insight-math";
import { ORDER_SELECT, weeklySigma, type OrderSettings } from "@/lib/fabric-orders-math";
import type { CurrentUser } from "@/lib/session";

const YEAR = 365;
export const MAX_ROWS = 200;

type Num = number | bigint | string | null;
const n = (x: Num) => (x == null ? 0 : Number(x));

/** The fabrics every figure here is about: sold by the yard, the company's own (not a partner's consigned stock). */
const FABRIC_SQL = `p."shopId" = $1 AND p."kind" = 'FABRIC' AND p."unit" = 'yd' AND p."consignLinkId" IS NULL`;

export type InsightItem = {
  id: string;
  partNumber: string;
  description: string;
  brand: string | null;
  collection: string | null;
  designer: string | null;
  colorTags: string[];
  supplier: string | null;
  qty: number;
  priceCents: number | null;
  /** Cost per yard in cents (a fraction when the supplier's price is finer than a cent), null when none is on file. */
  yardCost: number | null;
  band: string;
  photoId: string | null;
  // What sells
  daysInStock: number;
  early: boolean;
  lumpy: boolean;
  /** Yards sold in the window. */
  sold: number;
  /** Yards a week: the item's own rate, blended toward comparable fabrics while it is new. */
  perWeek: number;
  weeks: number | null;
  /** 12-month margin in cents (cost at time of sale; today's cost on lines that recorded none). */
  margin: number;
  grade: Grade;
  // Aging
  aged: Aged | null;
  sinceFirst: number;
  // Reordering (package F3)
  inPrint: "YES" | "NO" | "UNKNOWN";
  boltYards: number;
  reorderAt: number;
  /** Standard deviation of the weekly sales over the in-stock weeks. */
  sigmaWeek: number;
  /** Yards sold in the last `days` days (the Reorder now window) and the stock of that window: on hand at its start plus received since. */
  urgentSold: number;
  urgentLot: number;
};

export type GroupRow = { name: string; items: number; qty: number; perWeek: number; perItem: number; weeks: number | null; margin: number };
export type GmroiRow = { name: string; margin: number; avgInventory: number; value: number | null; band: GmroiBand | null; items: number };

export type SlowRow = {
  item: InsightItem;
  stage: SlowStage;
  ladder: LadderView;
  /** Margin a yard earns at the next markdown step; null when the ladder has nowhere left to go. */
  convert: Convert | null;
  fqPriceCents: number | null;
  /** The share of the stock tied up, for the sort: yards x cost, cents. */
  tiedUp: number | null;
};

export type Insight = {
  settings: InsightSettings & OrderSettings;
  items: InsightItem[];
  groups: { maker: GroupRow[]; collection: GroupRow[]; designer: GroupRow[]; color: GroupRow[]; band: GroupRow[] };
  gmroi: { maker: GmroiRow[]; supplier: GmroiRow[]; windowDays: number };
  slow: SlowRow[];
  /** Sale lines with no cost recorded (older sales), whose margin uses the fabric's cost today. */
  linesWithoutCost: number;
  fabrics: number;
};

type MoveRow = { partId: string; day: string; net: Num; recv: Num };
type SaleRow = { partId: string; day: string; qty: Num; rev: Num; cost: Num; nocost: Num; lines: Num };

export async function insightFor(shopId: string, now = new Date()): Promise<Insight> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true, ...INSIGHT_SELECT, ...ORDER_SELECT, fatQuarterMarkupPct: true, halfYardMarkupPct: true, remnantPricePct: true } });
  const tz = shop.timeZone;
  const s: InsightSettings & OrderSettings = shop;
  const today = dateIn(now, tz);
  const since = new Date(now.getTime() - (YEAR + 2) * 86_400_000);
  const [parts, moves, sales] = await Promise.all([
    db.part.findMany({
      where: { shopId, kind: "FABRIC", unit: "yd", consignLinkId: null },
      select: { id: true, partNumber: true, description: true, brand: true, collection: true, designer: true, colorTags: true, supplier: true, qtyOnHand: true, priceCents: true, costCents: true, costTenThou: true, createdAt: true, inPrint: true, boltYards: true, reorderAt: true },
    }),
    db.$queryRawUnsafe<MoveRow[]>(
      `SELECT m."partId", ((m."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE $2)::date::text AS day, SUM(m."qty")::float8 AS net,
              COALESCE(SUM(m."qty") FILTER (WHERE m."reason" = 'RECEIVED' AND m."qty" > 0), 0)::float8 AS recv
         FROM "StockMove" m JOIN "Part" p ON p."id" = m."partId"
        WHERE m."shopId" = $1 AND ${FABRIC_SQL} GROUP BY 1, 2`,
      shopId,
      tz,
    ),
    db.$queryRawUnsafe<SaleRow[]>(
      `SELECT l."partId", ((x."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE $2)::date::text AS day,
              SUM(l."qty")::float8 AS qty,
              SUM(ROUND(l."qty" * l."unitPriceCents") - CASE WHEN l."qty" < 0 THEN -1 ELSE 1 END * l."discountCents")::float8 AS rev,
              SUM(CASE WHEN l."costTenThou" IS NOT NULL THEN ROUND(l."qty" * l."costTenThou" / 100.0)
                       WHEN l."costCents" IS NOT NULL THEN ROUND(l."qty" * l."costCents") ELSE 0 END)::float8 AS cost,
              COALESCE(SUM(l."qty") FILTER (WHERE l."costTenThou" IS NULL AND l."costCents" IS NULL), 0)::float8 AS nocost,
              COUNT(*) FILTER (WHERE l."costTenThou" IS NULL AND l."costCents" IS NULL) AS lines
         FROM "SaleLine" l JOIN "Sale" x ON x."id" = l."saleId" JOIN "Part" p ON p."id" = l."partId"
        WHERE x."shopId" = $1 AND x."status" = 'COMPLETED' AND x."createdAt" >= $3 AND l."consignLinkId" IS NULL AND ${FABRIC_SQL}
        GROUP BY 1, 2`,
      shopId,
      tz,
      since,
    ),
  ]);

  // Per fabric: the day maps.
  type Day = { net: Map<number, number>; recv: Lot[]; netAll: number; lastMove: number };
  const moveBy = new Map<string, Day>();
  for (const m of moves) {
    const d: Day = moveBy.get(m.partId) ?? { net: new Map(), recv: [], netAll: 0, lastMove: 0 };
    const ago = daysAgo(m.day, today);
    d.net.set(ago, (d.net.get(ago) ?? 0) + n(m.net));
    d.netAll += n(m.net);
    d.lastMove = Math.max(d.lastMove, ago);
    if (n(m.recv) > 0) d.recv.push({ ago, yards: n(m.recv) });
    moveBy.set(m.partId, d);
  }
  type Sold = { qty: Map<number, number>; margin: Map<number, number> };
  const saleBy = new Map<string, Sold>();
  let linesWithoutCost = 0;
  const costOf = new Map(parts.map((p) => [p.id, (() => { const t = yardCostTenThou(p); return t == null ? null : t / 100; })()]));
  for (const r of sales) {
    const d = saleBy.get(r.partId) ?? { qty: new Map(), margin: new Map() };
    const ago = daysAgo(r.day, today);
    d.qty.set(ago, (d.qty.get(ago) ?? 0) + n(r.qty));
    // Margin: the line's net price less its cost at the time of sale; lines with no cost recorded use today's cost.
    const fallback = costOf.get(r.partId);
    const cost = n(r.cost) + (fallback != null ? n(r.nocost) * fallback : 0);
    d.margin.set(ago, (d.margin.get(ago) ?? 0) + n(r.rev) - cost);
    linesWithoutCost += n(r.lines);
    saleBy.set(r.partId, d);
  }

  const fabricAge = parts.reduce((a, p) => Math.max(a, daysAgo(dateIn(p.createdAt, tz), today)), 0);
  const windowDays = Math.min(YEAR, Math.max(28, fabricAge));

  type Work = { it: InsightItem; own: number; rateWeight: number; marginWindow: number; invCents: number };
  const work: Work[] = [];
  for (const p of parts) {
    const mv = moveBy.get(p.id);
    const sb = saleBy.get(p.id);
    const createdAgo = Math.max(0, daysAgo(dateIn(p.createdAt, tz), today));
    const existsAgo = Math.max(createdAgo, mv?.lastMove ?? 0);
    const net = mv?.net ?? new Map<number, number>();
    const v = velocityOf({ qNow: p.qtyOnHand, net, sold: sb?.qty ?? new Map(), existsAgo, weeks: s.fabVelocityWeeks });
    const lots: Lot[] = [...(mv?.recv ?? [])];
    const opening = p.qtyOnHand - (mv?.netAll ?? 0);
    if (opening > 1e-9) lots.push({ ago: createdAgo, yards: opening });
    const aged = p.qtyOnHand > 0 ? fifoAge(lots, p.qtyOnHand) : null;
    let margin = 0;
    let marginWindow = 0;
    for (const [ago, m] of sb?.margin ?? []) {
      if (ago < YEAR) margin += m;
      if (ago < windowDays) marginWindow += m;
    }
    // Average inventory at cost over the window, from the daily balances.
    const yc = costOf.get(p.id) ?? null;
    let inv = 0;
    if (yc != null && yc > 0) {
      const bal = dayBalances(p.qtyOnHand, net, windowDays);
      for (let k = 0; k < windowDays; k++) if (k <= existsAgo) inv += Math.max(0, bal[k]) * yc;
    }
    const sinceFirst = existsAgo;
    // The Reorder now window: sold in the last N days over what was on hand N days ago plus what came in since.
    let urgentSold = 0;
    for (const [ago, q] of sb?.qty ?? []) if (ago < s.fabUrgentDays) urgentSold += q;
    const urgentRecv = (mv?.recv ?? []).filter((l) => l.ago < s.fabUrgentDays).reduce((a, l) => a + l.yards, 0);
    const urgentBal = dayBalances(p.qtyOnHand, net, s.fabUrgentDays + 1)[s.fabUrgentDays];
    const it: InsightItem = {
      id: p.id,
      partNumber: p.partNumber,
      description: p.description,
      brand: p.brand,
      collection: p.collection,
      designer: p.designer,
      colorTags: p.colorTags,
      supplier: p.supplier,
      qty: p.qtyOnHand,
      priceCents: p.priceCents,
      yardCost: yc,
      band: priceBand(p.priceCents),
      photoId: null,
      daysInStock: v.daysInStock,
      early: v.daysInStock < s.fabEarlyDays,
      lumpy: v.lumpy,
      sold: v.sold,
      perWeek: v.own,
      weeks: null,
      margin: Math.round(margin),
      grade: "unrated",
      aged,
      sinceFirst,
      inPrint: p.inPrint,
      boltYards: p.boltYards,
      reorderAt: p.reorderAt,
      sigmaWeek: weeklySigma(v.weekly),
      urgentSold: Math.max(0, urgentSold),
      urgentLot: Math.max(0, urgentBal) + urgentRecv,
    };
    work.push({ it, own: v.own, rateWeight: 1, marginWindow, invCents: inv / windowDays });
  }

  // New fabric: blend toward the median rate of established fabrics (same maker, else price band, else the shop).
  const pool = work.filter((w) => w.it.daysInStock >= s.fabBlendDays).map((w) => ({ brand: w.it.brand, band: w.it.band, rate: w.own }));
  for (const w of work) {
    if (w.it.daysInStock >= s.fabBlendDays) continue;
    const b = blendVelocity(w.own, w.it.daysInStock, s.fabBlendDays, priorRate({ brand: w.it.brand, band: w.it.band }, pool));
    w.it.perWeek = b.rate;
    w.rateWeight = b.weight;
  }
  for (const w of work) w.it.weeks = weeksOfSupply(w.it.qty, w.it.perWeek);

  // A/B/C on the 12-month margin; a fabric under `fabUnratedDays` old is unrated.
  const grades = abcGrades(
    work.map((w) => ({ id: w.it.id, margin: w.it.margin, rated: w.it.sinceFirst >= s.fabUnratedDays })),
    s.fabAbcAPct,
    s.fabAbcBPct,
  );
  for (const w of work) w.it.grade = grades.get(w.it.id) ?? "unrated";

  // Only fabrics with something going on: stock on hand, or a sale or stock day in the window.
  const live = work.filter((w) => w.it.qty > 0 || w.it.sold > 0 || w.it.daysInStock > 0);
  const items = live.map((w) => w.it).sort((a, b) => b.perWeek - a.perWeek || b.sold - a.sold || a.partNumber.localeCompare(b.partNumber));

  const group = (key: (i: InsightItem) => string[]): GroupRow[] => {
    const map = new Map<string, { items: number; stocked: number; qty: number; rate: number; margin: number }>();
    for (const i of items) {
      for (const name of key(i)) {
        const g = map.get(name) ?? { items: 0, stocked: 0, qty: 0, rate: 0, margin: 0 };
        g.items += 1;
        if (i.daysInStock > 0) g.stocked += 1;
        g.qty += i.qty;
        g.rate += i.perWeek;
        g.margin += i.margin;
        map.set(name, g);
      }
    }
    return [...map]
      .map(([name, g]) => ({ name, items: g.items, qty: g.qty, perWeek: g.rate, perItem: g.stocked ? g.rate / g.stocked : 0, weeks: weeksOfSupply(g.qty, g.rate), margin: g.margin }))
      .sort((a, b) => b.perItem - a.perItem || b.margin - a.margin || a.name.localeCompare(b.name));
  };
  const groups = {
    maker: group((i) => [i.brand ?? "(no maker)"]),
    collection: group((i) => [i.collection ?? "(no collection)"]),
    designer: group((i) => [i.designer ?? "(no designer)"]),
    color: group((i) => (i.colorTags.length ? i.colorTags : ["(no color tag)"])),
    band: group((i) => [i.band]),
  };

  const gm = (key: (w: Work) => string): GmroiRow[] => {
    const map = new Map<string, { margin: number; inv: number; items: number }>();
    for (const w of work) {
      const name = key(w);
      const g = map.get(name) ?? { margin: 0, inv: 0, items: 0 };
      g.margin += w.marginWindow;
      g.inv += w.invCents;
      g.items += 1;
      map.set(name, g);
    }
    return [...map]
      .filter(([, g]) => g.inv > 0 || g.margin !== 0)
      .map(([name, g]) => {
        const value = gmroi({ marginCents: g.margin, avgInventoryCents: g.inv, windowDays });
        return { name, margin: Math.round(g.margin), avgInventory: Math.round(g.inv), value, band: value == null ? null : gmroiBand(value, s), items: g.items };
      })
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name));
  };
  const gmroiRows = { maker: gm((w) => w.it.brand ?? "(no maker)"), supplier: gm((w) => w.it.supplier ?? "(no supplier)"), windowDays };

  // Slow fabric, with the markdown ladder and the markdown-versus-fat-quarters numbers.
  const candidates = items.flatMap((i) => {
    if (!i.aged) return [];
    const stage = slowStage(i.aged, i.sinceFirst, s, i.weeks);
    return stage ? [{ i, stage }] : [];
  });
  const ladders = await ladderViewsFor(shopId, candidates.map((c) => c.i.id), { tz, today, settings: s });
  const slow: SlowRow[] = candidates
    .map(({ i, stage }) => {
      const ladder = ladders.get(i.id)!;
      const yc = i.yardCost;
      const part = parts.find((p) => p.id === i.id)!;
      const fq = i.priceCents == null ? null : cutPrices("FQ", part, shop).priceCents;
      const convert = fq == null ? null : convertVsMarkdown({ markdownPriceCents: ladder.offer?.priceCents ?? null, fqPriceCents: fq, yardCostCents: yc ?? 0, cutCostCents: s.fabCutCostCents });
      return { item: i, stage, ladder, convert, fqPriceCents: fq, tiedUp: yc == null ? null : Math.round(i.qty * yc) };
    })
    .sort((a, b) => (b.item.aged?.ageDays ?? 0) - (a.item.aged?.ageDays ?? 0));

  // Pictures for the rows the page shows.
  const shown = new Set([...items.slice(0, MAX_ROWS).map((i) => i.id), ...slow.slice(0, MAX_ROWS).map((r) => r.item.id)]);
  const photos = await db.partPhoto.findMany({ where: { shopId, partId: { in: [...shown] } }, orderBy: { sortOrder: "asc" }, select: { id: true, partId: true } });
  const first = new Map<string, string>();
  for (const p of photos) if (!first.has(p.partId)) first.set(p.partId, p.id);
  for (const i of items) i.photoId = first.get(i.id) ?? null;

  return { settings: s, items, groups, gmroi: gmroiRows, slow, linesWithoutCost, fabrics: parts.length };
}

/**
 * The markdown ladder of each fabric listed (a map by id): the step its price is on, the next offer and the latest
 * markdown if it can still be undone today. Each row looked up by shopId and id.
 */
export async function ladderViewsFor(shopId: string, ids: string[], ctx?: { tz: string; today: string; settings: InsightSettings }): Promise<Map<string, LadderView>> {
  const out = new Map<string, LadderView>();
  if (!ids.length) return out;
  const shop = ctx ? null : await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true, ...INSIGHT_SELECT } });
  const tz = ctx?.tz ?? shop!.timeZone;
  const settings: InsightSettings = ctx?.settings ?? shop!;
  const today = ctx?.today ?? todayIn(tz);
  const [parts, rows] = await Promise.all([
    db.part.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, priceCents: true, costCents: true, costTenThou: true } }),
    db.fabricMarkdown.findMany({ where: { shopId, partId: { in: ids }, undoneAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, partId: true, step: true, regularCents: true, newCents: true, oldCents: true, createdAt: true } }),
  ]);
  const by = new Map<string, LadderRow[]>();
  for (const r of rows) by.set(r.partId, [...(by.get(r.partId) ?? []), { id: r.id, step: r.step, regularCents: r.regularCents, newCents: r.newCents, oldCents: r.oldCents, day: dateIn(r.createdAt, tz) }]);
  for (const p of parts) out.set(p.id, ladderView({ priceCents: p.priceCents, yardTenThou: yardCostTenThou(p), rows: by.get(p.id) ?? [], today }, settings));
  return out;
}

/** One fabric's age for the markdown's "why": days and share sold, from its own receipts. */
async function agedFor(shopId: string, partId: string, qNow: number, createdAt: Date, tz: string): Promise<Aged | null> {
  const today = todayIn(tz);
  const [recv, all] = await Promise.all([
    db.stockMove.findMany({ where: { shopId, partId, reason: "RECEIVED", qty: { gt: 0 } }, select: { qty: true, createdAt: true } }),
    db.stockMove.aggregate({ where: { shopId, partId }, _sum: { qty: true } }),
  ]);
  const lots: Lot[] = recv.map((m) => ({ ago: daysAgo(dateIn(m.createdAt, tz), today), yards: m.qty }));
  const opening = qNow - (all._sum.qty ?? 0);
  if (opening > 1e-9) lots.push({ ago: Math.max(0, daysAgo(dateIn(createdAt, tz), today)), yards: opening });
  return fifoAge(lots, qNow);
}

export type MarkdownSource = "slow" | "bolt";

/**
 * Marks the fabric down to the ladder's next step: the price changes and a row records the old and new price, when, why
 * and by whom. Refused when the price changed since the page was drawn (the update only goes through from the old price).
 */
export async function markDownFor(user: CurrentUser, partId: string, source: MarkdownSource): Promise<string> {
  assertId(partId);
  // A markdown is a price change: an owner's or admin's (as in updatePart).
  if (user.role === "TECH") throw new UserError("Only an owner or admin can mark fabric down.");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true, ...INSIGHT_SELECT } });
  const tz = shop.timeZone;
  const part = await db.part.findFirst({ where: { id: partId, shopId: user.shopId }, select: { id: true, partNumber: true, kind: true, unit: true, consignLinkId: true, priceCents: true, qtyOnHand: true, createdAt: true } });
  if (!part) throw new UserError("Fabric not found.");
  if (part.consignLinkId) throw new UserError(`${part.partNumber} is a partner's consigned stock: its price isn't yours to change.`);
  if (part.kind !== "FABRIC" || part.unit !== "yd") throw new UserError(`${part.partNumber} isn't fabric sold by the yard.`);
  const view = (await ladderViewsFor(user.shopId, [partId], { tz, today: todayIn(tz), settings: shop })).get(partId)!;
  if (!view.offer) {
    if (view.stopped === "noprice") throw new UserError(`Give ${part.partNumber} a price per yard first.`);
    if (view.stopped === "last") throw new UserError(`${part.partNumber} is already at the last markdown step (${shop.fabStep3Pct}% off).`);
    throw new UserError(`${part.partNumber} is already at the lowest price the ladder allows (cost + ${shop.fabFloorPct - 100}%). Lower it by hand in the item if you mean to take a loss.`);
  }
  const offer = view.offer;
  let why: string;
  if (source === "slow") {
    const a = await agedFor(user.shopId, partId, part.qtyOnHand, part.createdAt, tz);
    why = a ? `Slow fabric: ${Math.round(a.ageDays)} days on the shelf, ${Math.round(a.soldShare * 100)}% sold` : "Slow fabric";
  } else {
    why = `Bolt end: ${yards(part.qtyOnHand)} yd left`;
  }
  await db.$transaction(async (tx) => {
    const took = await tx.part.updateMany({ where: { id: partId, shopId: user.shopId, priceCents: offer.fromCents }, data: { priceCents: offer.priceCents } });
    if (took.count !== 1) throw new UserError(`${part.partNumber}'s price changed while you were looking. Reload and try again.`);
    await tx.fabricMarkdown.create({
      data: { shopId: user.shopId, partId, step: offer.step, pct: offer.pct, regularCents: offer.regularCents, oldCents: offer.fromCents, newCents: offer.priceCents, reason: why, userId: user.id, userName: user.name ?? null },
    });
  });
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  return `${part.partNumber}: ${dollars(offer.fromCents)} to ${dollars(offer.priceCents)} a yard (${offer.pct}% off${offer.held ? ", held at the floor" : ""}).`;
}

/** Takes back the latest markdown of a fabric, the day it was made and while its price is still the marked-down price. */
export async function undoMarkdownFor(user: CurrentUser, markdownId: string): Promise<string> {
  assertId(markdownId);
  if (user.role === "TECH") throw new UserError("Only an owner or admin can undo a markdown.");
  const tz = (await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true } })).timeZone;
  const row = await db.fabricMarkdown.findFirst({ where: { id: markdownId, shopId: user.shopId }, include: { part: { select: { partNumber: true } } } });
  if (!row) throw new UserError("Markdown not found.");
  if (row.undoneAt) throw new UserError("That markdown was already undone.");
  if (dateIn(row.createdAt, tz) !== todayIn(tz)) throw new UserError("A markdown can be undone only on the day it was made. Change the price in the item instead.");
  const later = await db.fabricMarkdown.findFirst({ where: { shopId: user.shopId, partId: row.partId, undoneAt: null, createdAt: { gt: row.createdAt } }, select: { id: true } });
  if (later) throw new UserError("A later markdown is on top of this one: undo that one first.");
  await db.$transaction(async (tx) => {
    const back = await tx.part.updateMany({ where: { id: row.partId, shopId: user.shopId, priceCents: row.newCents }, data: { priceCents: row.oldCents } });
    if (back.count !== 1) throw new UserError(`${row.part.partNumber}'s price was changed since the markdown, so it isn't undone. Set the price in the item.`);
    await tx.fabricMarkdown.update({ where: { id: row.id }, data: { undoneAt: new Date() } });
  });
  return `${row.part.partNumber} is back to $${(row.oldCents / 100).toFixed(2)} a yard.`;
}
