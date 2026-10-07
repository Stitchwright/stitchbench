"use server";

// Filling inventory fast: look a store barcode up online, and load a supplier's line sheet or a spreadsheet.
import { revalidatePath } from "next/cache";
import { requireBaseWritable } from "@/lib/base-gate";
import { isUserError } from "@/lib/user-error";
import { requireAdmin, requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { actorOf, audit } from "@/lib/audit";
import { lookupBarcode, type BarcodeInfo } from "@/lib/barcode-lookup";
import { runImport, type ImportOptions as Options, type ImportRow as Row } from "@/lib/inventory-import";

export async function barcodeDetails(code: string): Promise<{ info: BarcodeInfo | null } | { error: string }> {
  const user = await requireUser();
  try {
    return { info: await lookupBarcode(code, user.shopId) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Lookup failed." };
  }
}

export type ImportRow = Row;
export type ImportOptions = Options;

/**
 * Rows from a spreadsheet: new items are added; items already here (same number) get the new prices and details when
 * updateExisting is on. Quantities are received into stock when addQty is on (see lib/inventory-import.ts).
 */
export async function importItems(rows: ImportRow[], opts: ImportOptions): Promise<{ added: number; updated: number; skipped: number; unmatched?: string[] } | { error: string }> {
  try {
    const user = await requireAdmin();
    await requireBaseWritable(user);
    const result = await runImport(user.shopId, user.id, rows, opts);
    await audit(db, actorOf(user), {
      action: "import.items",
      subjectType: "Items",
      subjectLabel: `${result.added} added, ${result.updated} updated, ${result.skipped} skipped`,
      changes: { added: [0, result.added], updated: [0, result.updated], skipped: [0, result.skipped] },
    });
    revalidatePath("/parts", "layout");
    return result;
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}
