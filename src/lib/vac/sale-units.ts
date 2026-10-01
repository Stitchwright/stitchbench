/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the owning package fills in the bodies */
import "server-only";
// The register's Vac Shop hooks (modules-design.md section 10.c). Foundation stub: the register's plumbing calls these;
// the vac-sales-warranty package fills them in. Until then a unit or trade-in line is refused and nothing else happens.
import type { Prisma, SaleLine } from "@/generated/prisma/client";
import type { RegisterItem } from "@/actions/register";
import { UserError } from "@/lib/action";
import type { TradeInInput } from "@/lib/vac/types";

export type UnitLineIn = { stockUnitId: string | null; tradeIn: TradeInInput | null; qty: number; unitPriceCents: number; taxable: boolean };
export type UnitLineOut = { description: string; qty: number; unitPriceCents: number; taxable: boolean; discountable: boolean; costCents: number | null; stockUnitId: string | null };

/** Before the sale: check every unit and trade-in line (by index) and fix its wording, price, tax and quantity. Throws UserError. */
export async function prepareUnitLines(a: { shopId: string; role: "OWNER" | "ADMIN" | "TECH"; customerId: string | null; lines: UnitLineIn[] }): Promise<Map<number, UnitLineOut>> {
  if (a.lines.some((l) => l.stockUnitId || l.tradeIn)) throw new UserError("Selling vacuums from stock needs the Vac Shop module.");
  return new Map();
}

/** Inside the sale's transaction, right after that line was written. discountShareCents: its share of the whole-sale discount. */
export async function applyUnitLine(
  _tx: Prisma.TransactionClient,
  _a: { shopId: string; saleNumber: number; customerId: string | null; at: Date; timeZone: string; line: SaleLine; tradeIn: TradeInInput | null; discountShareCents: number },
): Promise<void> {}

/** Inside voidSale's transaction, after the sale is marked void. */
export async function voidUnitLines(_tx: Prisma.TransactionClient, _a: { shopId: string; saleNumber: number; customerId: string | null; lines: SaleLine[]; at: Date }): Promise<void> {}

/** Register scan ("code": serial, exact, case-insensitive) and search ("search": brand / model words): in-stock units as items. [] unless vac is active. */
export async function registerUnitHits(_a: { shopId: string; q: string; mode: "code" | "search" }): Promise<RegisterItem[]> {
  return [];
}
