"use server";
/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the owning package fills in the bodies */

// Vacuums for sale: the register's unit tools call these. Foundation stub; the vac-sales-warranty package fills it in.
import { requireUser } from "@/lib/session";
import type { UnitRow } from "@/lib/vac/units";

/** In-stock units the register may sell. */
export async function unitsForSale(): Promise<UnitRow[]> {
  await requireUser();
  return [];
}

/** Units this customer bought that may come back. */
export async function unitsToReturn(_customerId: string | null): Promise<UnitRow[]> {
  await requireUser();
  return [];
}
