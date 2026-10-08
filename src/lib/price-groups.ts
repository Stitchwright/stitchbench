import "server-only";
// Customer price groups, memberships and the lifetime discount (shop-features-round-2-design.md 1.5). Settings → Prices
// keeps the groups ("Guild", "Teachers", "Club card", "Wholesale"); a customer joins one on her page (with an end day for
// a paid membership), or buys a membership item at the register ("Club card, $25, 12 months"), which puts her in its
// group from today (a renewal adds the months to the day it ends). At the register her group's discount goes on every
// line it covers (src/lib/price-rules.ts), labelled. A machine sold here may carry a lifetime discount on its supplies.
// Every query by shopId; bodies take the user so the check script can drive them.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { str } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, addMonths, parseYmd, ymdOf } from "@/lib/zoned";
import { actorOf, audit } from "@/lib/audit";
import { groupInForce, RULE_KINDS, type GroupRule, type RuleCtx } from "@/lib/price-rules";

const admin = (user: CurrentUser) => {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
};

// ---------------------------------------------------------------------------------------------------------------------
// The groups

export type GroupView = GroupRule & { active: boolean; members: number; membershipItems: { id: string; partNumber: string; description: string; priceCents: number | null; months: number | null }[] };

export async function priceGroupsFor(shopId: string, o: { activeOnly?: boolean } = {}): Promise<GroupView[]> {
  const rows = await db.priceGroup.findMany({ where: { shopId, ...(o.activeOnly ? { active: true } : {}) }, orderBy: { name: "asc" }, include: { _count: { select: { customers: true } } } });
  const items = rows.length ? await db.part.findMany({ where: { shopId, membershipGroupId: { in: rows.map((r) => r.id) } }, select: { id: true, partNumber: true, description: true, priceCents: true, membershipGroupId: true, membershipMonths: true } }) : [];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    pctOff: r.pctOff,
    useWholesale: r.useWholesale,
    kinds: r.kinds,
    onSaleItems: r.onSaleItems,
    active: r.active,
    members: r._count.customers,
    membershipItems: items.filter((i) => i.membershipGroupId === r.id).map((i) => ({ id: i.id, partNumber: i.partNumber, description: i.description, priceCents: i.priceCents, months: i.membershipMonths })),
  }));
}

/** Add or change a group (owner or admin): the name, percent off or the wholesale price, the kinds, items on sale. */
export async function saveGroupFor(user: CurrentUser, fd: FormData, id?: string | null): Promise<string> {
  admin(user);
  await requireBaseWritable(user);
  const name = str(fd.get("name"))?.slice(0, 60);
  if (!name) throw new UserError("Give the group a name, like Guild or Teachers.");
  const useWholesale = str(fd.get("gives")) === "wholesale";
  const pct = useWholesale ? 0 : Number(str(fd.get("pctOff"))?.replace(/%$/, "") ?? "");
  if (!useWholesale && (!Number.isInteger(pct) || pct < 1 || pct > 90)) throw new UserError("Percent off: a whole number from 1 to 90.");
  const keys = RULE_KINDS.map((k) => k.key);
  const kinds = fd.getAll("kinds").map(String).filter((k) => keys.includes(k));
  const data = { name, pctOff: pct, useWholesale, kinds: kinds.length === keys.length ? [] : kinds, onSaleItems: fd.get("onSaleItems") != null, active: id ? fd.get("active") != null : true };
  if (id) {
    const r = await db.priceGroup.updateMany({ where: { id, shopId: user.shopId }, data });
    if (!r.count) throw new UserError("Price group not found.");
    return id;
  }
  if ((await db.priceGroup.count({ where: { shopId: user.shopId } })) >= 30) throw new UserError("That's a lot of groups (30). Switch one off and reuse it.");
  return (await db.priceGroup.create({ data: { shopId: user.shopId, ...data } })).id;
}

/** The lifetime discount a machine sold here gives on its supplies by default (owner or admin). */
export async function saveLifetimeDefaultFor(user: CurrentUser, fd: FormData): Promise<void> {
  admin(user);
  const pct = Number(str(fd.get("lifetimePct"))?.replace(/%$/, "") ?? "");
  if (!Number.isInteger(pct) || pct < 0 || pct > 90) throw new UserError("Lifetime discount: a whole percent from 0 to 90.");
  await db.shop.update({ where: { id: user.shopId }, data: { lifetimePctDefault: pct } });
}

/** An item that sells a membership: its group and months (owner or admin; blank group: an ordinary item again). */
export async function saveMembershipItemFor(user: CurrentUser, partId: string, fd: FormData): Promise<void> {
  admin(user);
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId }, select: { id: true, kind: true } });
  if (!p) throw new UserError("Item not found.");
  const groupId = str(fd.get("groupId"));
  if (!groupId) {
    await db.part.update({ where: { id: p.id }, data: { membershipGroupId: null, membershipMonths: null } });
    return;
  }
  if (!(await db.priceGroup.count({ where: { id: groupId, shopId: user.shopId } }))) throw new UserError("Price group not found.");
  const months = Number(str(fd.get("months")) ?? "12");
  if (!Number.isInteger(months) || months < 1 || months > 60) throw new UserError("How long: 1 to 60 months.");
  await db.part.update({ where: { id: p.id }, data: { membershipGroupId: groupId, membershipMonths: months } });
}

// ---------------------------------------------------------------------------------------------------------------------
// A customer's group

/** Join a group on her page (with an end day for a paid membership), or leave it (owner or admin). */
export async function setCustomerGroupFor(user: CurrentUser, customerId: string, fd: FormData): Promise<void> {
  admin(user);
  await requireBaseWritable(user);
  const c = await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId }, select: { id: true, name: true, priceGroupId: true, priceGroupUntil: true } });
  if (!c) throw new UserError("Customer not found.");
  const groupId = str(fd.get("groupId"));
  if (groupId && !(await db.priceGroup.count({ where: { id: groupId, shopId: user.shopId } }))) throw new UserError("Price group not found.");
  const untilRaw = str(fd.get("until"));
  const until = untilRaw ? parseYmd(untilRaw) : null;
  if (untilRaw && !until) throw new UserError("Ends: pick a date, or leave it blank (no end).");
  await db.customer.update({ where: { id: c.id }, data: { priceGroupId: groupId || null, priceGroupUntil: groupId ? until : null } });
  await audit(db, actorOf(user), { action: "customer.pricegroup", subjectType: "Customer", subjectId: c.id, subjectLabel: c.name, changes: { priceGroupId: [c.priceGroupId, groupId || null], priceGroupUntil: [c.priceGroupUntil, groupId ? until : null] } });
}

export type CustomerGroup = GroupRule & { until: string | null; inForce: boolean; endsSoon: boolean; renew: { partId: string; description: string; priceCents: number | null; months: number | null } | null };

/** Her group as the register and her page show it: in force today, ending within 30 days (with the item to renew). */
export async function customerGroupFor(shopId: string, customerId: string, today?: string): Promise<CustomerGroup | null> {
  const c = await db.customer.findFirst({ where: { id: customerId, shopId }, select: { priceGroupUntil: true, priceGroup: true } });
  if (!c?.priceGroup) return null;
  const day = today ?? ymdOf(new Date(), await shopTimeZone(shopId));
  const g = c.priceGroup;
  const inForce = groupInForce(g, c.priceGroupUntil, day);
  const endsSoon = !!c.priceGroupUntil && c.priceGroupUntil <= addDays(day, 30);
  const item = endsSoon ? await db.part.findFirst({ where: { shopId, membershipGroupId: g.id }, select: { id: true, description: true, priceCents: true, membershipMonths: true } }) : null;
  return {
    id: g.id,
    name: g.name,
    pctOff: g.pctOff,
    useWholesale: g.useWholesale,
    kinds: g.kinds,
    onSaleItems: g.onSaleItems,
    until: c.priceGroupUntil,
    inForce,
    endsSoon,
    renew: item ? { partId: item.id, description: item.description, priceCents: item.priceCents, months: item.membershipMonths } : null,
  };
}

/** What the register's rules need for a customer today: her group in force, her machines' lifetime discounts. */
export async function ruleCtxFor(shopId: string, customerId: string | null, today: string): Promise<RuleCtx> {
  if (!customerId) return {};
  const [g, units] = await Promise.all([
    customerGroupFor(shopId, customerId, today),
    db.stockUnit.findMany({ where: { shopId, status: "SOLD", lifetimePctOff: { gt: 0 }, machine: { customerId } }, select: { machineId: true, lifetimePctOff: true } }),
  ]);
  return { group: g?.inForce ? g : null, lifetime: units.map((u) => ({ machineId: u.machineId, pctOff: u.lifetimePctOff! })) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Memberships sold at the register (inside the sale's transaction)

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * A membership item sold: the buyer joins its group from today for its months (a renewal of the same group adds them to
 * the day it ends, if that is later). Returns the line's note ("member:<prev group>|<prev until>") so a void puts her back.
 */
export async function applyMembership(tx: Tx, a: { shopId: string; customerId: string; groupId: string; months: number; today: string }): Promise<string> {
  const c = await tx.customer.findFirst({ where: { id: a.customerId, shopId: a.shopId }, select: { priceGroupId: true, priceGroupUntil: true } });
  if (!c) throw new UserError("Customer not found.");
  const from = c.priceGroupId === a.groupId && c.priceGroupUntil && c.priceGroupUntil > a.today ? c.priceGroupUntil : a.today;
  const until = addMonths(from, a.months) ?? addDays(from, a.months * 30);
  await tx.customer.updateMany({ where: { id: a.customerId, shopId: a.shopId }, data: { priceGroupId: a.groupId, priceGroupUntil: until } });
  return `member:${c.priceGroupId ?? ""}|${c.priceGroupUntil ?? ""}`;
}

/** Voiding a membership's sale: she goes back to the group (and end day) she had before. */
export async function undoMembership(tx: Tx, a: { shopId: string; customerId: string | null; note: string | null }): Promise<void> {
  if (!a.customerId || !a.note?.startsWith("member:")) return;
  const [prevGroup, prevUntil] = a.note.slice("member:".length).split("|");
  const stillThere = prevGroup ? await tx.priceGroup.count({ where: { id: prevGroup, shopId: a.shopId } }) : 0;
  await tx.customer.updateMany({ where: { id: a.customerId, shopId: a.shopId }, data: { priceGroupId: stillThere ? prevGroup : null, priceGroupUntil: stillThere ? prevUntil || null : null } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reports

/** Discounts given by group (lines it priced on sales that stand), members, and memberships ending in the next 30 days. */
export async function groupReport(shopId: string, today: string): Promise<{ groups: (GroupView & { givenCents: number; lines: number })[]; renewals: { id: string; name: string; group: string; until: string }[] }> {
  const groups = await priceGroupsFor(shopId);
  const sums = await db.saleLine.groupBy({ by: ["priceGroupId"], where: { priceGroupId: { in: groups.map((g) => g.id) }, sale: { shopId, status: "COMPLETED" } }, _sum: { discountCents: true }, _count: { _all: true } });
  const by = new Map(sums.map((s) => [s.priceGroupId!, s]));
  const due = await db.customer.findMany({ where: { shopId, priceGroupId: { not: null }, priceGroupUntil: { gte: addDays(today, -30), lte: addDays(today, 30) } }, select: { id: true, name: true, priceGroupUntil: true, priceGroup: { select: { name: true } } }, orderBy: { priceGroupUntil: "asc" }, take: 200 });
  return {
    groups: groups.map((g) => ({ ...g, givenCents: by.get(g.id)?._sum.discountCents ?? 0, lines: by.get(g.id)?._count._all ?? 0 })),
    renewals: due.map((c) => ({ id: c.id, name: c.name, group: c.priceGroup?.name ?? "", until: c.priceGroupUntil! })),
  };
}
