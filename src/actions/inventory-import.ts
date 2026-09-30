"use server";

// Filling inventory fast: look a store barcode up online, and load a supplier's line sheet or a spreadsheet.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { UserError, isUserError } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { lookupBarcode, type BarcodeInfo } from "@/lib/barcode-lookup";
import { numberKey, partKeys } from "@/lib/parts";
import { sameText } from "@/lib/input";
import type { PartKind } from "@/generated/prisma/enums";

const KINDS: PartKind[] = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"];

export async function barcodeDetails(code: string): Promise<{ info: BarcodeInfo | null } | { error: string }> {
  await requireUser();
  try {
    return { info: await lookupBarcode(code) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Lookup failed." };
  }
}

export type ImportRow = {
  partNumber: string;
  barcode?: string | null;
  description?: string | null;
  brand?: string | null;
  costCents?: number | null;
  priceCents?: number | null;
  qty?: number | null;
  location?: string | null;
};

export type ImportOptions = { kind: string; unit: string | null; supplier: string | null; addQty: boolean; updateExisting: boolean };

/**
 * Rows from a spreadsheet: new items are added; items already here (same number) get the new prices and details when
 * updateExisting is on. Quantities are received into stock when addQty is on.
 */
export async function importItems(
  rows: ImportRow[],
  opts: ImportOptions,
): Promise<{ added: number; updated: number; skipped: number; unmatched?: string[] } | { error: string }> {
  try {
    const user = await requireAdmin();
    const shopId = user.shopId;
    if (!Array.isArray(rows) || !rows.length) throw new UserError("Nothing to import.");
    if (rows.length > 5000) throw new UserError("5,000 rows at a time, please.");
    const kind = (KINDS.includes(opts.kind as PartKind) ? opts.kind : "PART") as PartKind;
    const unit = opts.unit === "yd" ? "yd" : null;
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const unmatched: string[] = [];
    // All or nothing: a row that fails leaves no half-done import behind (pressing Import again would receive twice).
    await db.$transaction(
      async (tx) => {
        for (const r of rows) {
          if (!r || typeof r !== "object") {
            skipped++;
            continue;
          }
          const partNumber = String(r.partNumber ?? "").trim().slice(0, 80);
          const description = String(r.description ?? "").trim().slice(0, 300);
          if (!partNumber || (!description && !r.barcode)) {
            skipped++;
            continue;
          }
          const barcode = r.barcode ? String(r.barcode).trim().slice(0, 40) : null;
          const alt = barcode && barcode !== partNumber ? [barcode] : [];
          const cost = r.costCents != null && Number.isFinite(r.costCents) ? Math.round(r.costCents) : null;
          const price = r.priceCents != null && Number.isFinite(r.priceCents) ? Math.round(r.priceCents) : null;
          // The same number in any case is the same item; a partner's consigned stock is never imported into. When a
          // partner's consigned item already has the number, this shop's own stock of it is "<number> (own)".
          const same = await tx.part.findMany({
            where: { shopId, consignLinkId: null, OR: [{ partNumber: sameText(partNumber) }, { partNumber: sameText(`${partNumber} (own)`) }] },
          });
          let existing = same.find((p) => p.partNumber.toLowerCase() === partNumber.toLowerCase()) ?? same[0] ?? null;
          // No item has the number: an item that already has the row's barcode or number among its numbers (e.g. added
          // at the scanner with the UPC as its number) is the same item, and gets the row's number as another number.
          let alsoKnownAs: string[] = [];
          if (!existing) {
            const keys = [...new Set([partNumber, ...alt].map(numberKey).filter((k) => k.length >= 3))];
            const byKey = keys.length ? await tx.part.findMany({ where: { shopId, consignLinkId: null, numberKeys: { hasSome: keys } }, take: 2 }) : [];
            if (byKey.length > 1) {
              // Two items share these numbers: which one is meant is the user's call.
              unmatched.push(partNumber);
              skipped++;
              continue;
            }
            existing = byKey[0] ?? null;
            if (existing && existing.partNumber !== partNumber) alsoKnownAs = [partNumber];
          }
          // Yards to the thousandth for fabric (the item's own unit when it exists), whole pieces for everything else.
          const rowUnit = existing ? existing.unit : unit;
          const raw = opts.addQty && r.qty != null && Number.isFinite(Number(r.qty)) && Number(r.qty) > 0 ? Number(r.qty) : 0;
          const qty = rowUnit === "yd" ? Math.round(raw * 1000) / 1000 : Math.round(raw);
          if (existing) {
            if (!opts.updateExisting && !qty) {
              skipped++;
              continue;
            }
            const ownNumber = existing.partNumber;
            const altNumbers = [...new Set([...existing.altNumbers, ...alsoKnownAs, ...alt])].filter((n) => n !== ownNumber);
            await tx.part.update({
              where: { id: existing.id },
              data: {
                ...(opts.updateExisting
                  ? {
                      description: description || existing.description,
                      brand: r.brand?.trim() || existing.brand,
                      costCents: cost ?? existing.costCents,
                      priceCents: price ?? existing.priceCents,
                      location: r.location?.trim() || existing.location,
                      altNumbers,
                      numberKeys: partKeys(existing.partNumber, altNumbers),
                    }
                  : {}),
                ...(qty ? { qtyOnHand: { increment: qty } } : {}),
              },
            });
            if (qty) await tx.stockMove.create({ data: { shopId, partId: existing.id, qty, reason: "RECEIVED", userId: user.id, note: "Imported" } });
            updated++;
          } else {
            const consigned = await tx.part.findFirst({ where: { shopId, partNumber }, select: { id: true } });
            const own = consigned ? `${partNumber} (own)` : partNumber;
            const alts = consigned ? [...new Set([partNumber, ...alt])] : alt;
            await tx.part.create({
              data: {
                shopId,
                partNumber: own,
                description: description || partNumber,
                kind,
                unit,
                brand: r.brand?.trim() || null,
                location: r.location?.trim() || null,
                supplier: opts.supplier,
                costCents: cost,
                priceCents: price,
                altNumbers: alts,
                numberKeys: partKeys(own, alts),
                qtyOnHand: qty,
                moves: qty ? { create: { shopId, qty, reason: "RECEIVED", userId: user.id, note: "Imported" } } : undefined,
              },
            });
            added++;
          }
        }
      },
      { timeout: 180_000, maxWait: 15_000 },
    );
    revalidatePath("/parts", "layout");
    return { added, updated, skipped, ...(unmatched.length ? { unmatched } : {}) };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}
