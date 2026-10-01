/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the owning package fills in the bodies */
import "server-only";
// Vacuums for sale (modules-design.md section 10.c). Foundation stub; the vac-sales-warranty package fills it in.

export type UnitRow = { id: string; status: string; brand: string; model: string; serial: string | null };

/** The company's units on one tab, matching `q`; always scoped by shopId. */
export async function listUnits(_shopId: string, _tab: string | null, _q: string | null): Promise<UnitRow[]> {
  return [];
}

/** One unit, or null when it isn't this company's. */
export async function unitDetail(_shopId: string, _id: string): Promise<UnitRow | null> {
  return null;
}
