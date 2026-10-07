import "server-only";
// Sales commissions and "listed elsewhere" holds (shop-features-round-2-design.md 9.7, package commissions-listed).
// Commissions: who sold it is picked at the register (the person signed in by default) and kept on each line; each
// person's rule (a percent of machine sales, or of everything) is set by an owner or admin; the report adds it up for a
// period. Listed elsewhere: a machine or an item also listed on eBay, Etsy or Marketplace (with the link); selling it at
// the register asks "Take it down on eBay first", ticked before the sale finishes (a machine's listing is then cleared;
// an item asks only when the last one sells). Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { lineNet } from "@/lib/register-math";
import { commissionOn, placesText, readCommission, readListed, type CommissionRule, type Listed } from "@/lib/listed-math";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------------------------------------------
// Listed elsewhere

/** The places ticked on the form (and one typed), each with its link. Anyone may record a listing. */
export async function setListedFor(user: CurrentUser, what: "part" | "unit", id: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  const ticked = fd.getAll("place").map(String);
  const other = str(fd.get("otherPlace"));
  const places = [...ticked, ...(other ? [other] : [])];
  const list: Listed[] = [];
  for (const where of places) {
    const url = str(fd.get(`url:${where}`)) ?? (where === other ? str(fd.get("url:other")) : null);
    if (url && !/^https:\/\/\S{3,300}$/i.test(url)) throw new UserError(`The link for ${where}: a web address starting with https://`);
    list.push({ where, url: url ?? null });
  }
  const clean = readListed(list);
  const where = { id: assertId(id), shopId: user.shopId };
  const r = what === "part" ? await db.part.updateMany({ where, data: { listedOn: clean } }) : await db.stockUnit.updateMany({ where, data: { listedOn: clean } });
  if (!r.count) throw new UserError(what === "part" ? "Item not found." : "Machine not found.");
  return clean.length ? `Listed on ${placesText(clean)} too.` : "Not listed anywhere else.";
}

/** Before a sale: every machine or last item listed elsewhere must be ticked "taken down" on its line. Throws UserError. */
export async function checkDelisted(
  shopId: string,
  lines: { partId?: string | null; stockUnitId?: string | null; qty: number; delisted?: boolean }[],
  parts: Map<string, { partNumber: string; description: string; qtyOnHand: number; listedOn: unknown }>,
): Promise<string[]> {
  const unitIds = lines.filter((l) => l.stockUnitId && Number(l.qty) > 0).map((l) => l.stockUnitId!);
  const units = unitIds.length ? await db.stockUnit.findMany({ where: { shopId, id: { in: unitIds } }, select: { id: true, listedOn: true, machine: { select: { brand: true, model: true } } } }) : [];
  for (const l of lines) {
    if (!(Number(l.qty) > 0) || l.delisted === true) continue;
    if (l.stockUnitId) {
      const u = units.find((x) => x.id === l.stockUnitId);
      const listed = readListed(u?.listedOn);
      if (u && listed.length) throw new UserError(`The ${u.machine.brand} ${u.machine.model} is also listed on ${placesText(listed)}. Take it down there first, then tick it on the line.`);
    } else if (l.partId) {
      const p = parts.get(l.partId);
      const listed = readListed(p?.listedOn);
      if (p && listed.length && p.qtyOnHand - Number(l.qty) < 1) throw new UserError(`${p.partNumber} is the last one and it is also listed on ${placesText(listed)}. Take it down there first, then tick it on the line.`);
    }
  }
  return unitIds;
}

/** In the sale's transaction: the machines sold are no longer listed anywhere. */
export async function clearUnitListings(tx: Tx, shopId: string, unitIds: string[]) {
  if (unitIds.length) await tx.stockUnit.updateMany({ where: { shopId, id: { in: unitIds } }, data: { listedOn: [] } });
}

// ---------------------------------------------------------------------------------------------------------------
// Commissions

/** Who can be picked as the seller at the register: the company's active people. */
export async function sellers(shopId: string) {
  return db.user.findMany({ where: { shopId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

/** The seller named on a sale: one of this company's active people, else the person ringing it up. */
export async function sellerFor(user: CurrentUser, soldById: unknown): Promise<string> {
  if (typeof soldById !== "string" || !soldById || soldById === user.id) return user.id;
  const u = await db.user.findFirst({ where: { id: soldById, shopId: user.shopId, active: true }, select: { id: true } });
  if (!u) throw new UserError("The person picked as the seller isn't one of your people.");
  return u.id;
}

/** A person's rule: a percent of machine sales or of everything; blank for none. Owner or admin. */
export async function saveCommissionFor(user: CurrentUser, userId: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  if (user.role === "TECH") throw new UserError("Only an owner or admin sets commissions.");
  const who = await db.user.findFirst({ where: { id: assertId(userId), shopId: user.shopId }, select: { id: true, name: true } });
  if (!who) throw new UserError("Person not found.");
  const raw = str(fd.get("pct"))?.replace(/%$/, "");
  let rule: CommissionRule | null = null;
  if (raw) {
    const pct = Number(raw);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new UserError("The commission: a percent like 5 (blank for none).");
    rule = { pct, on: str(fd.get("on")) === "all" ? "all" : "machines" };
  }
  await db.user.updateMany({ where: { id: who.id, shopId: user.shopId }, data: { commission: rule ?? {} } });
  return rule ? `${who.name}: ${rule.pct}% of ${rule.on === "all" ? "everything sold" : "machine sales"}.` : `${who.name}: no commission.`;
}

export type CommissionRow = { userId: string; name: string; rule: CommissionRule | null; machinesCents: number; allCents: number; lines: number; commissionCents: number };

/**
 * Per person, the sales they made in [from, to) (voided sales left out; returns take off): machine sales, everything,
 * and the commission by their rule. Lines are counted at their price less their own discount (before tax).
 */
export async function commissionReport(shopId: string, from: Date, to: Date): Promise<CommissionRow[]> {
  const [users, lines] = await Promise.all([
    db.user.findMany({ where: { shopId }, select: { id: true, name: true, commission: true, active: true } }),
    db.saleLine.findMany({
      where: { soldById: { not: null }, sale: { shopId, status: "COMPLETED", createdAt: { gte: from, lt: to } }, giftCardId: null, layawayId: null, repairJobId: null },
      select: { soldById: true, qty: true, unitPriceCents: true, discountCents: true, taxable: true, kind: true, tradeInUnitId: true },
    }),
  ]);
  const by = new Map<string, { machines: number; all: number; n: number }>();
  for (const l of lines) {
    if (l.tradeInUnitId || l.kind === "TRADE_IN") continue;
    const m = by.get(l.soldById!) ?? { machines: 0, all: 0, n: 0 };
    const net = lineNet(l);
    m.all += net;
    if (l.kind === "UNIT") m.machines += net;
    m.n++;
    by.set(l.soldById!, m);
  }
  return users
    .filter((u) => u.active || by.has(u.id))
    .map((u) => {
      const s = by.get(u.id) ?? { machines: 0, all: 0, n: 0 };
      const rule = readCommission(u.commission);
      return { userId: u.id, name: u.name, rule, machinesCents: s.machines, allCents: s.all, lines: s.n, commissionCents: commissionOn(rule?.on === "all" ? s.all : s.machines, rule) };
    })
    .sort((a, b) => b.commissionCents - a.commissionCents || b.allCents - a.allCents || a.name.localeCompare(b.name));
}
