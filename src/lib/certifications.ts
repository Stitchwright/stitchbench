import "server-only";
// Certified on the shop's machines (shop-features-round-2-design.md 6.4, package maker-space): the longarm's "certified to
// rent" made general, so a customer can be certified on the Longarm, the Laser, the 3D printer... after the safety class,
// and an appointment type of the shop's own machine by the hour books only certified customers (certFor; empty with
// needsCert means the longarm, as before). Customer.longarmCertifiedAt is kept in step with the "Longarm" row until it is
// removed. Certifying on anything but the longarm is the Maker Shop module's (maker-space time). Owner or admin.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { moduleState } from "@/lib/modules";

const makerOn = async (shopId: string) => (await moduleState(shopId, "maker")).active;
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

export const LONGARM = "Longarm";
/** Machines a shop with Maker Shop certifies on, suggested in the forms. */
export const MAKER_EQUIPMENT = ["Laser", "3D printer", "Resin printer", "Craft cutter"];

/** "laser" -> "Laser"; the longarm in any case -> "Longarm"; blank -> null. */
export function equipmentName(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!t) return null;
  if (t.toLowerCase() === LONGARM.toLowerCase()) return LONGARM;
  const known = MAKER_EQUIPMENT.find((e) => e.toLowerCase() === t.toLowerCase());
  return known ?? t.charAt(0).toUpperCase() + t.slice(1);
}

/** What an appointment type needs her certified on: its own machine, the longarm for an older "certified only" type, or nothing. */
export const certNeeded = (t: { needsCert: boolean; certFor: string | null }) => (t.certFor ? equipmentName(t.certFor) : t.needsCert ? LONGARM : null);

type Db = Prisma.TransactionClient | typeof db;

export async function isCertified(tx: Db, shopId: string, customerId: string, equipment: string): Promise<boolean> {
  const name = equipmentName(equipment)!;
  const row = await tx.certification.findFirst({ where: { shopId, customerId, equipment: { equals: name, mode: "insensitive" } }, select: { id: true } });
  if (row) return true;
  if (name !== LONGARM) return false;
  const c = await tx.customer.findFirst({ where: { id: customerId, shopId }, select: { longarmCertifiedAt: true } });
  return !!c?.longarmCertifiedAt;
}

export type CertRow = { id: string; equipment: string; certifiedAt: Date };

export async function certificationsOf(shopId: string, customerId: string): Promise<CertRow[]> {
  return db.certification.findMany({ where: { shopId, customerId }, select: { id: true, equipment: true, certifiedAt: true }, orderBy: { equipment: "asc" } });
}

/** The machines the shop certifies on: those its appointment types name, the longarm for a shop with a counter, and with Maker Shop the usual maker ones. */
export async function equipmentChoices(shopId: string): Promise<string[]> {
  const [types, shop, maker] = await Promise.all([
    db.appointmentType.findMany({ where: { shopId, OR: [{ certFor: { not: null } }, { needsCert: true }] }, select: { certFor: true, needsCert: true } }),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { sellsRetail: true } }),
    makerOn(shopId),
  ]);
  const out = new Set<string>();
  if (shop.sellsRetail) out.add(LONGARM);
  for (const t of types) {
    const n = certNeeded(t);
    if (n) out.add(n);
  }
  if (maker) for (const e of MAKER_EQUIPMENT) out.add(e);
  return [...out];
}

/**
 * Certifies a customer on a machine (after its safety class), or takes it away. The longarm is the base program's (and
 * keeps Customer.longarmCertifiedAt in step); any other machine needs Maker Shop. Owner or admin.
 */
export async function setCertificationFor(user: CurrentUser, customerId: string, equipment: string, on: boolean): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can certify someone.");
  const name = equipmentName(equipment);
  if (!name) throw new UserError("Which machine? Type it, like Laser.");
  if (name !== LONGARM && on && !(await makerOn(user.shopId))) throw new UserError("Certifying on your own machines (maker-space time) is part of the Maker Shop module.");
  const c = await db.customer.findFirst({ where: { id: assertId(customerId), shopId: user.shopId }, select: { id: true, name: true } });
  if (!c) throw new UserError("Customer not found.");
  await db.$transaction(async (tx) => {
    if (on) {
      const have = await tx.certification.findFirst({ where: { shopId: user.shopId, customerId: c.id, equipment: { equals: name, mode: "insensitive" } }, select: { id: true } });
      if (!have) await tx.certification.create({ data: { shopId: user.shopId, customerId: c.id, equipment: name, byUserId: user.id } });
    } else {
      await tx.certification.deleteMany({ where: { shopId: user.shopId, customerId: c.id, equipment: { equals: name, mode: "insensitive" } } });
    }
    if (name === LONGARM) await tx.customer.updateMany({ where: { id: c.id, shopId: user.shopId }, data: { longarmCertifiedAt: on ? new Date() : null } });
  });
  return on ? `${c.name} is certified on the ${name}.` : `${c.name} is no longer certified on the ${name}.`;
}

/** Who is certified on each machine, for Maker Shop's maker-space page. */
export async function certifiedBy(shopId: string): Promise<{ equipment: string; people: { customerId: string; name: string; certifiedAt: Date }[] }[]> {
  const rows = await db.certification.findMany({ where: { shopId }, include: { customer: { select: { name: true } } }, orderBy: [{ equipment: "asc" }, { certifiedAt: "desc" }], take: 2000 });
  const by = new Map<string, { customerId: string; name: string; certifiedAt: Date }[]>();
  for (const r of rows) by.set(r.equipment, [...(by.get(r.equipment) ?? []), { customerId: r.customerId, name: r.customer.name, certifiedAt: r.certifiedAt }]);
  return [...by.entries()].map(([equipment, people]) => ({ equipment, people }));
}
