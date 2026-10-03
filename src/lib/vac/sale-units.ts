import "server-only";
// The register's Vac Shop hooks (modules-design.md section 10.c): a vacuum sold from stock (one line of 1), a sold
// vacuum coming back (-1, at most what it sold for), and a trade-in taken as credit (-1, never taxable). The register's
// plumbing (src/lib/register-sale.ts) calls prepareUnitLines before the sale, applyUnitLine inside the sale's
// transaction and voidUnitLines inside the void's; every write is a guarded updateMany with shopId.
import type { Prisma, SaleLine } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { VACUUM_KIND } from "@/lib/equipment/vacuum";
import { modelKey, money } from "@/lib/format";
import { blockedMessage, type ModuleState } from "@/lib/module-info";
import { moduleState } from "@/lib/modules";
import type { RegisterItem } from "@/lib/register-item";
import { lineNet } from "@/lib/register-math";
import type { TradeInInput } from "@/lib/vac/types";
import { DEFAULT_WARRANTY_MONTHS, isCondition, pushEvent, unitDescription, unitDisclosure, warrantyByDefault, warrantyEnd, type UnitEvent } from "@/lib/vac/units";

export type UnitLineIn = { stockUnitId: string | null; tradeIn: TradeInInput | null; qty: number; unitPriceCents: number; taxable: boolean };
export type UnitLineOut = { description: string; qty: number; unitPriceCents: number; taxable: boolean; discountable: boolean; costCents: number | null; stockUnitId: string | null };

type Tx = Prisma.TransactionClient;

/** Before the sale: check every unit and trade-in line (by index) and fix its wording, price, tax and quantity. Throws UserError. */
export async function prepareUnitLines(a: { shopId: string; role: "OWNER" | "ADMIN" | "TECH"; customerId: string | null; lines: UnitLineIn[] }): Promise<Map<number, UnitLineOut>> {
  const out = new Map<number, UnitLineOut>();
  const mine = a.lines.map((l, i) => [l, i] as const).filter(([l]) => l.stockUnitId || l.tradeIn);
  if (!mine.length) return out;
  let state: ModuleState | null = null;
  // New work (a sale, a trade-in) needs the module; a return is money already owed, whatever the module's state.
  const needActive = async () => {
    state ??= await moduleState(a.shopId, "vac");
    if (!state.active) throw new UserError(blockedMessage(state, a.role !== "TECH"));
  };
  for (const [l, i] of mine) {
    if (l.stockUnitId && l.tradeIn) throw new UserError("A line can only be one thing.");
    const price = Math.round(Number(l.unitPriceCents));
    if (!Number.isFinite(price) || price < 0) throw new UserError("Prices can't be negative. For a return, use Return mode (negative quantity).");
    if (l.tradeIn) {
      await needActive();
      const t = l.tradeIn;
      if (!a.customerId) throw new UserError("Pick the customer trading it in.");
      const brand = String(t.brand ?? "").trim();
      const model = String(t.model ?? "").trim();
      if (!brand || !model) throw new UserError("Enter the trade-in's brand and model.");
      if (t.bagged !== "Bagged" && t.bagged !== "Bagless") throw new UserError("Say whether it takes bags.");
      if (!isCondition(t.condition)) throw new UserError("Pick the trade-in's condition.");
      const serial = typeof t.serial === "string" && t.serial.trim() ? t.serial.trim().slice(0, 60) : null;
      out.set(i, { description: `Trade-in: ${brand} ${model}${serial ? ` S/N ${serial}` : ""}`, qty: -1, unitPriceCents: price, taxable: false, discountable: false, costCents: null, stockUnitId: null });
      continue;
    }
    const unit = await db.stockUnit.findFirst({ where: { id: l.stockUnitId!, shopId: a.shopId }, include: { machine: true } });
    const desc = unit ? unitDescription(unit) : "That vacuum";
    if (l.qty < 0) {
      // A return: the unit was sold here and hasn't come back.
      if (!unit || unit.status !== "SOLD" || !unit.soldLineId) throw new UserError(`${desc} wasn't sold here, or has been returned already.`);
      const original = await db.saleLine.findFirst({ where: { id: unit.soldLineId, sale: { shopId: a.shopId, status: "COMPLETED" } } });
      if (!original) throw new UserError(`The sale of ${desc} is void; there is nothing to return.`);
      const max = unit.soldNetCents ?? lineNet(original);
      if (a.role === "TECH" && price !== max) throw new UserError(`Only an owner or admin can change the refund for ${desc}.`);
      if (price > max) throw new UserError(`You can refund at most ${money(max)} for ${desc}.`);
      out.set(i, { description: `Return: ${unit.machine.brand} ${unit.machine.model} S/N ${unit.machine.serial ?? "none"}`, qty: -1, unitPriceCents: price, taxable: original.taxable, discountable: false, costCents: unit.costCents, stockUnitId: unit.id });
      continue;
    }
    await needActive();
    if (!unit || unit.status !== "IN_STOCK") throw new UserError(`${desc} isn't in stock any more.`);
    if (l.qty !== 1) throw new UserError("A vacuum is one line of 1.");
    if (!a.customerId) throw new UserError("Pick the customer first: a warranty needs the buyer.");
    if (unit.priceCents == null) throw new UserError(`Set a price for ${desc} first (Vac Shop → For sale).`);
    if (a.role === "TECH" && price !== unit.priceCents) throw new UserError(`Only an owner or admin can change the price of ${desc}.`);
    out.set(i, { description: desc, qty: 1, unitPriceCents: price, taxable: l.taxable, discountable: true, costCents: unit.costCents, stockUnitId: unit.id });
  }
  return out;
}

/** Inside the sale's transaction, right after that line was written. discountShareCents: its share of the whole-sale discount. */
export async function applyUnitLine(
  tx: Tx,
  a: { shopId: string; saleNumber: number; customerId: string | null; at: Date; timeZone: string; line: SaleLine; tradeIn: TradeInInput | null; discountShareCents: number },
): Promise<void> {
  const { shopId, line, at } = a;
  if (a.tradeIn) return tradeIn(tx, a, a.tradeIn);
  if (!line.stockUnitId) return;
  const unit = await tx.stockUnit.findFirst({ where: { id: line.stockUnitId, shopId }, include: { machine: true } });
  if (!unit) throw new UserError("That vacuum isn't one of this shop's.");
  const desc = unitDescription(unit);
  const when = at.toISOString();
  if (line.qty > 0) {
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true } });
    const months = unit.warrantyMonths ?? (isCondition(unit.condition) ? DEFAULT_WARRANTY_MONTHS[unit.condition] : 12);
    const { until } = warrantyEnd(at, months, a.timeZone);
    const sold = await tx.stockUnit.updateMany({
      where: { shopId, id: unit.id, status: "IN_STOCK" },
      data: {
        status: "SOLD",
        soldAt: at,
        soldLineId: line.id,
        soldNetCents: lineNet(line) - a.discountShareCents,
        returnLineId: null,
        warrantyUntil: until,
        warrantyMonths: months,
        warrantyBy: unit.warrantyBy ?? warrantyByDefault(unit.condition, unit.machine.brand, shop.name),
        registeredAt: null,
        registrationRef: null,
        events: pushEvent(unit.events, { at: when, note: `Sold on sale #${a.saleNumber}`, line: line.id }),
      },
    });
    if (!sold.count) throw new UserError(`${desc} was just sold. Take it off this sale.`);
    await tx.machine.updateMany({ where: { id: unit.machineId, shopId }, data: { customerId: a.customerId } });
    return;
  }
  const back = await tx.stockUnit.updateMany({
    where: { shopId, id: unit.id, status: "SOLD", soldLineId: unit.soldLineId },
    data: { status: "IN_STOCK", returnLineId: line.id, events: pushEvent(unit.events, { at: when, note: `Returned on sale #${a.saleNumber}`, line: line.id }) },
  });
  if (!back.count) throw new UserError(`${desc} was just returned.`);
  await tx.machine.updateMany({ where: { id: unit.machineId, shopId }, data: { customerId: null } });
}

/** A trade-in: the machine (found by serial and model, or made), its unit back IN_STOCK at the credit, no price yet. */
async function tradeIn(tx: Tx, a: { shopId: string; saleNumber: number; at: Date; line: SaleLine }, t: TradeInInput): Promise<void> {
  const { shopId, line, at } = a;
  const brand = t.brand.trim();
  const model = t.model.trim();
  const key = modelKey(model);
  const serial = t.serial?.trim() || null;
  const credit = Math.abs(lineNet(line));
  const when = at.toISOString();
  const note = `Traded in on sale #${a.saleNumber}`;
  const found = serial ? await tx.machine.findFirst({ where: { shopId, equipment: "VACUUM", serial: { equals: serial, mode: "insensitive" }, modelKey: key }, include: { stock: true } }) : null;
  const machine =
    found ??
    (await tx.machine.create({
      data: { shopId, brand, model, modelKey: key, serial, machineType: t.machineType?.trim() || null, equipment: VACUUM_KIND.equipment, kind: VACUUM_KIND.key, details: { bagged: t.bagged, ...(t.bagType ? { bagType: t.bagType } : {}) } },
      include: { stock: true },
    }));
  const unit = machine.stock;
  let unitId: string;
  if (unit && unit.status !== "SOLD") throw new UserError("That vacuum is already in your stock.");
  if (unit) {
    // Sold here before: what the sale set is kept on the event, so voiding this trade-in puts it back exactly.
    const prev = {
      status: unit.status,
      soldAt: unit.soldAt?.toISOString() ?? null,
      soldLineId: unit.soldLineId,
      soldNetCents: unit.soldNetCents,
      returnLineId: unit.returnLineId,
      warrantyUntil: unit.warrantyUntil?.toISOString() ?? null,
      registeredAt: unit.registeredAt?.toISOString() ?? null,
      registrationRef: unit.registrationRef,
      customerId: machine.customerId,
      condition: unit.condition,
      costCents: unit.costCents,
      priceCents: unit.priceCents,
      tradeInLineId: unit.tradeInLineId,
    };
    const r = await tx.stockUnit.updateMany({
      where: { shopId, id: unit.id, status: "SOLD" },
      data: {
        status: "IN_STOCK",
        soldAt: null,
        soldLineId: null,
        soldNetCents: null,
        returnLineId: null,
        warrantyUntil: null,
        registeredAt: null,
        registrationRef: null,
        condition: t.condition,
        costCents: credit,
        priceCents: null,
        tradeInLineId: line.id,
        events: pushEvent(unit.events, { at: when, note, line: line.id, prev }),
      },
    });
    if (!r.count) throw new UserError("That vacuum was just changed by someone else. Try again.");
    unitId = unit.id;
  } else {
    const made = await tx.stockUnit.create({
      data: { shopId, machineId: machine.id, status: "IN_STOCK", condition: t.condition, costCents: credit, tradeInLineId: line.id, events: [{ at: when, note, line: line.id }] },
      select: { id: true },
    });
    unitId = made.id;
  }
  await tx.saleLine.update({ where: { id: line.id }, data: { tradeInUnitId: unitId } });
  const details = { ...((machine.details as Record<string, unknown>) ?? {}), bagged: t.bagged, ...(t.bagType ? { bagType: t.bagType } : {}) };
  await tx.machine.updateMany({ where: { id: machine.id, shopId }, data: { customerId: null, details: details as Prisma.InputJsonValue, ...(found ? {} : {}) } });
}

const dateOf = (v: unknown) => (typeof v === "string" ? new Date(v) : null);
const strOf = (v: unknown) => (typeof v === "string" ? v : null);
const numOf = (v: unknown) => (typeof v === "number" ? v : null);

/** Inside voidSale's transaction, after the sale is marked void. */
export async function voidUnitLines(tx: Tx, a: { shopId: string; saleNumber: number; customerId: string | null; lines: SaleLine[]; at: Date }): Promise<void> {
  const { shopId, at } = a;
  const when = at.toISOString();
  for (const l of a.lines) {
    if (l.stockUnitId && l.qty > 0) {
      const unit = await tx.stockUnit.findFirst({ where: { id: l.stockUnitId, shopId }, include: { machine: true } });
      if (!unit) continue;
      const r = await tx.stockUnit.updateMany({
        where: { shopId, id: unit.id, status: "SOLD", soldLineId: l.id },
        data: { status: "IN_STOCK", soldAt: null, soldLineId: null, soldNetCents: null, warrantyUntil: null, registeredAt: null, registrationRef: null, events: pushEvent(unit.events, { at: when, note: `Sale #${a.saleNumber} void: back in stock` }) },
      });
      if (!r.count) throw new UserError(`${unitDescription(unit)} was returned since this sale; void that return first.`);
      await tx.machine.updateMany({ where: { id: unit.machineId, shopId }, data: { customerId: null } });
    } else if (l.stockUnitId && l.qty < 0) {
      const unit = await tx.stockUnit.findFirst({ where: { id: l.stockUnitId, shopId }, include: { machine: true } });
      if (!unit) continue;
      const r = await tx.stockUnit.updateMany({
        where: { shopId, id: unit.id, status: "IN_STOCK", returnLineId: l.id },
        data: { status: "SOLD", returnLineId: null, events: pushEvent(unit.events, { at: when, note: `Return on sale #${a.saleNumber} void: sold again` }) },
      });
      if (!r.count) throw new UserError(`${unitDescription(unit)} was sold again since; void that sale first.`);
      const original = unit.soldLineId ? await tx.saleLine.findFirst({ where: { id: unit.soldLineId, sale: { shopId } }, select: { sale: { select: { customerId: true } } } }) : null;
      await tx.machine.updateMany({ where: { id: unit.machineId, shopId }, data: { customerId: original?.sale.customerId ?? a.customerId } });
    } else if (l.tradeInUnitId) {
      const unit = await tx.stockUnit.findFirst({ where: { shopId, id: l.tradeInUnitId, status: "IN_STOCK", tradeInLineId: l.id }, include: { machine: true } });
      if (!unit) throw new UserError("The traded-in vacuum was sold since; void that sale first.");
      const events = Array.isArray(unit.events) ? (unit.events as UnitEvent[]) : [];
      const last = [...events].reverse().find((e) => e.prev);
      if (last?.prev && last.line === l.id) {
        const p = last.prev;
        await tx.stockUnit.updateMany({
          where: { shopId, id: unit.id, status: "IN_STOCK", tradeInLineId: l.id },
          data: {
            status: strOf(p.status) ?? "SOLD",
            soldAt: dateOf(p.soldAt),
            soldLineId: strOf(p.soldLineId),
            soldNetCents: numOf(p.soldNetCents),
            returnLineId: strOf(p.returnLineId),
            warrantyUntil: dateOf(p.warrantyUntil),
            registeredAt: dateOf(p.registeredAt),
            registrationRef: strOf(p.registrationRef),
            condition: strOf(p.condition) ?? unit.condition,
            costCents: numOf(p.costCents),
            priceCents: numOf(p.priceCents),
            tradeInLineId: strOf(p.tradeInLineId),
            events: pushEvent(unit.events, { at: when, note: `Trade-in on sale #${a.saleNumber} void: as it was before` }),
          },
        });
        await tx.machine.updateMany({ where: { id: unit.machineId, shopId }, data: { customerId: strOf(p.customerId) } });
      } else {
        await tx.stockUnit.updateMany({
          where: { shopId, id: unit.id, status: "IN_STOCK", tradeInLineId: l.id },
          data: { status: "REMOVED", events: pushEvent(unit.events, { at: when, note: `Trade-in on sale #${a.saleNumber} void: off sale` }) },
        });
        await tx.machine.updateMany({ where: { id: unit.machineId, shopId }, data: { customerId: a.customerId } });
      }
    }
  }
}

/** Register scan ("code": serial, exact, case-insensitive) and search ("search": brand / model words): in-stock units as items. [] unless vac is active. */
export async function registerUnitHits(a: { shopId: string; q: string; mode: "code" | "search" }): Promise<RegisterItem[]> {
  const t = a.q.trim();
  if (!t) return [];
  if (!(await moduleState(a.shopId, "vac")).active) return [];
  const words = t.split(/\s+/).slice(0, 4);
  const machine: Prisma.MachineWhereInput =
    a.mode === "code"
      ? { serial: { equals: t, mode: "insensitive" } }
      : { AND: words.map((w) => ({ OR: [{ brand: { contains: w, mode: "insensitive" as const } }, { model: { contains: w, mode: "insensitive" as const } }, { serial: { contains: w, mode: "insensitive" as const } }] })) };
  const rows = await db.stockUnit.findMany({ where: { shopId: a.shopId, status: "IN_STOCK", machine }, include: { machine: true }, orderBy: { createdAt: "desc" }, take: 10 });
  return rows.map((u) => ({
    id: u.id,
    partNumber: u.machine.serial ?? "no serial",
    description: unitDescription(u),
    priceCents: u.priceCents,
    unit: null,
    qtyOnHand: 1,
    kind: "UNIT",
    consigned: false,
    disclosure: unitDisclosure(u.condition),
    stockUnitId: u.id,
  }));
}
