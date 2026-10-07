import "server-only";
// The spreadsheet import. Every row is planned in memory from one read of the company's parts, then written with a few
// bulk statements in one transaction: the parts it changes are locked for moments (a sale at the register isn't held up
// for as long as the sheet is long), and it holds one database connection for a second or two, not for minutes.
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { EXCEL_NUMBER } from "@/lib/input";
import { MAX_CENTS, MAX_STOCK, isPartNumberClash, numberKey, partKeys } from "@/lib/parts";
import { CONDITIONS, ORIGINS, numberNames, twinNumber } from "@/lib/part-labels";
import type { PartCondition, PartKind, PartOrigin } from "@/generated/prisma/enums";
import { currentStoreId, isMainStoreId } from "@/lib/stores";

const KINDS: PartKind[] = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"];
const BLOCK = 500; // rows per insert, so no statement carries more values than the database takes

export type ImportRow = {
  partNumber: string;
  barcode?: string | null;
  description?: string | null;
  brand?: string | null;
  costCents?: number | null;
  /** The same cost in ten-thousandths of a dollar, when the sheet gives a finer figure than cents. */
  costTenThou?: number | null;
  priceCents?: number | null;
  qty?: number | null;
  location?: string | null;
  /** NEW | USED | REFURB and GENUINE | COMPATIBLE | PRINTED, when the sheet says (anything else counts as not said). */
  condition?: string | null;
  origin?: string | null;
};

export type ImportOptions = { kind: string; unit: string | null; supplier: string | null; addQty: boolean; updateExisting: boolean };

export type ImportResult = { added: number; updated: number; skipped: number; unmatched?: string[] };

/** An item as the import sees it: what's in the database, changed as the sheet's rows are applied one after another. */
type Item = {
  id: string;
  partNumber: string;
  description: string;
  brand: string | null;
  location: string | null;
  costCents: number | null;
  costTenThou: number | null;
  priceCents: number | null;
  unit: string | null;
  altNumbers: string[];
  numberKeys: string[];
  condition: PartCondition;
  origin: PartOrigin;
  consigned: boolean;
  fresh: boolean; // made by this import
  changed: boolean; // details to write
  more: number; // stock to add
};

const cents = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_CENTS ? Math.round(v) : null);

/**
 * Rows from a spreadsheet: new items are added; items already here (same number) get the new prices and details when
 * updateExisting is on. Quantities are received into stock when addQty is on. All or nothing: a failure leaves no
 * half-done import behind (pressing Import again would receive twice).
 */
export async function runImport(shopId: string, userId: string, rows: ImportRow[], opts: ImportOptions): Promise<ImportResult> {
  if (!Array.isArray(rows) || !rows.length) throw new UserError("Nothing to import.");
  if (rows.length > 5000) throw new UserError("5,000 rows at a time, please.");
  const kind = (KINDS.includes(opts.kind as PartKind) ? opts.kind : "PART") as PartKind;
  const unit = opts.unit === "yd" ? "yd" : null;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const unmatched: string[] = [];
  // The stock comes in at the store this person is working at (7.2; the main store's needs no level of its own).
  const loc = await currentStoreId({ id: userId, shopId });
  const atOther = !(await isMainStoreId(db, shopId, loc));
  await db.$transaction(
    async (tx) => {
      // One import at a time per company: a second one (a double click, a script) is turned away, not queued up
      // behind the first with a database connection held for each.
      const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(7710002, hashtext(${shopId})) AS ok`;
      if (!lock.ok) throw new UserError("An import for this company is already running. Wait for it to finish, check the parts list, then import again.");

      // What the company has now, read once. Lookups are by lower-case number and by number key.
      const items = (
        await tx.part.findMany({
          where: { shopId },
          select: { id: true, partNumber: true, description: true, brand: true, location: true, costCents: true, costTenThou: true, priceCents: true, unit: true, altNumbers: true, numberKeys: true, condition: true, origin: true, consignLinkId: true },
        })
      ).map((p): Item => ({ ...p, consigned: p.consignLinkId != null, fresh: false, changed: false, more: 0 }));
      // Every number in use, in lower case: the database holds a number once in any case (a partner's consigned
      // items included), so a new item's number is checked the same way.
      const taken = new Set(items.map((p) => p.partNumber.toLowerCase()));
      const byName = new Map<string, Item[]>();
      const byKey = new Map<string, Item[]>();
      const add = (map: Map<string, Item[]>, k: string, it: Item) => {
        const list = map.get(k);
        if (!list) map.set(k, [it]);
        else if (!list.includes(it)) list.push(it);
      };
      // A partner's consigned stock is never imported into, so it isn't looked up.
      const index = (it: Item) => {
        if (it.consigned) return;
        add(byName, it.partNumber.toLowerCase(), it);
        for (const k of it.numberKeys) add(byKey, k, it);
      };
      items.forEach(index);

      const fresh: Item[] = [];
      const moves: { shopId: string; locationId?: string | null; partId: string; qty: number; reason: "RECEIVED"; userId: string; note: string }[] = [];
      for (const r of rows) {
        if (!r || typeof r !== "object") {
          skipped++;
          continue;
        }
        const partNumber = String(r.partNumber ?? "").trim().slice(0, 80);
        const description = String(r.description ?? "").trim().slice(0, 300);
        // A long number Excel shortened ("7.44272E+11") has lost its digits: it isn't the barcode, and matching on it
        // would join different products.
        let barcode = r.barcode ? String(r.barcode).trim().slice(0, 40) : null;
        if (barcode && EXCEL_NUMBER.test(barcode)) barcode = null;
        if (!partNumber || (!description && !barcode)) {
          skipped++;
          continue;
        }
        const alt = barcode && barcode !== partNumber ? [barcode] : [];
        // The finer figure counts only while it still rounds to the cents the row gives (a stale or edited pair is cents only).
        const costT = typeof r.costTenThou === "number" && Number.isInteger(r.costTenThou) && r.costTenThou >= 0 && r.costTenThou <= MAX_CENTS * 100 ? r.costTenThou : null;
        const cost = costT != null ? Math.round(costT / 100) : cents(r.costCents);
        const costTenThou = costT != null && cents(r.costCents) === cost ? costT : null;
        const price = cents(r.priceCents);
        const brand = String(r.brand ?? "").trim() || null;
        const location = String(r.location ?? "").trim() || null;
        const condition = CONDITIONS.find((c) => c === r.condition) ?? null;
        const origin = ORIGINS.find((o) => o === r.origin) ?? null;
        // A quantity that can't be read, or is beyond belief, keeps the row out (it would come in with no stock).
        const typed = opts.addQty && r.qty != null ? Number(r.qty) : null;
        if (typed != null && (!Number.isFinite(typed) || typed > MAX_STOCK)) {
          skipped++;
          continue;
        }

        // The same number in any case is the same item; a partner's consigned stock is never imported into. When a
        // partner's consigned item already has the number, this shop's own stock of it is "<number> (own)". A sheet
        // that gives the condition means the item in that condition: the same part in another is a second item.
        const lower = partNumber.toLowerCase();
        const same = numberNames(lower).flatMap((n) => byName.get(n) ?? []);
        let item = (condition ? same.find((p) => p.condition === condition) : (same.find((p) => p.partNumber.toLowerCase() === lower) ?? same[0])) ?? null;
        // No item has the number: an item that already has the row's barcode or number among its numbers (e.g. added
        // at the scanner with the UPC as its number) is the same item, and gets the row's number as another number.
        let alsoKnownAs: string[] = [];
        if (!item) {
          const keys = [...new Set([partNumber, ...alt].map(numberKey).filter((k) => k.length >= 3))];
          const hits = new Set(keys.flatMap((k) => byKey.get(k) ?? []).filter((p) => !condition || p.condition === condition));
          if (hits.size > 1) {
            // Two items share these numbers: which one is meant is the user's call.
            unmatched.push(partNumber);
            skipped++;
            continue;
          }
          item = [...hits][0] ?? null;
          if (item && item.partNumber !== partNumber) alsoKnownAs = [partNumber];
        }
        // Yards to the thousandth for fabric (the item's own unit when it exists), whole pieces for everything else.
        const raw = typed != null && typed > 0 ? typed : 0;
        const qty = (item ? item.unit : unit) === "yd" ? Math.round(raw * 1000) / 1000 : Math.round(raw);
        if (item) {
          if (!opts.updateExisting && !qty) {
            skipped++;
            continue;
          }
          if (opts.updateExisting) {
            const ownNumber = item.partNumber;
            const altNumbers = [...new Set([...item.altNumbers, ...alsoKnownAs, ...alt])].filter((n) => n !== ownNumber);
            item.description = description || item.description;
            item.brand = brand || item.brand;
            if (cost != null) {
              item.costCents = cost;
              item.costTenThou = costTenThou;
            }
            item.priceCents = price ?? item.priceCents;
            item.location = location || item.location;
            item.origin = origin ?? item.origin;
            item.altNumbers = altNumbers;
            item.numberKeys = partKeys(item.partNumber, altNumbers);
            item.changed = true;
            for (const k of item.numberKeys) add(byKey, k, item);
          }
          item.more += qty;
          if (qty) moves.push({ shopId, partId: item.id, qty, reason: "RECEIVED", userId, note: "Imported" });
          updated++;
        } else {
          // The number is taken by a partner's consigned item, or by this shop's own stock in another condition.
          const clash = taken.has(lower) || same.some((p) => p.partNumber.toLowerCase() === lower);
          const own = clash ? twinNumber(partNumber, condition ?? "NEW", same.length > 0) : partNumber;
          if (own !== partNumber && taken.has(own.toLowerCase())) {
            unmatched.push(partNumber);
            skipped++;
            continue;
          }
          const alts = own !== partNumber ? [...new Set([partNumber, ...alt])] : alt;
          const it: Item = {
            id: randomUUID(),
            partNumber: own,
            description: description || partNumber,
            brand,
            location,
            costCents: cost,
            costTenThou,
            priceCents: price,
            unit,
            altNumbers: alts,
            numberKeys: partKeys(own, alts),
            condition: condition ?? "NEW",
            origin: origin ?? "GENUINE",
            consigned: false,
            fresh: true,
            changed: false,
            more: qty,
          };
          taken.add(own.toLowerCase());
          index(it);
          fresh.push(it);
          if (qty) moves.push({ shopId, partId: it.id, qty, reason: "RECEIVED", userId, note: "Imported" });
          added++;
        }
      }

      // The plan was made from one read: a number someone adds at the counter (in any case) while the sheet is being
      // planned is refused by the database's key on the number, and the whole import rolls back.
      const addedMeanwhile = (e: unknown) => {
        throw isPartNumberClash(e) ? new UserError("A number in the sheet was added to the parts by someone else while the import ran, so nothing was imported. Check the parts list, then import again.") : e;
      };
      for (let i = 0; i < fresh.length; i += BLOCK) {
        await tx.part.createMany({
          data: fresh.slice(i, i + BLOCK).map((it) => ({
            id: it.id,
            shopId,
            partNumber: it.partNumber,
            description: it.description,
            kind,
            unit: it.unit,
            brand: it.brand,
            location: it.location,
            condition: it.condition,
            origin: it.origin,
            supplier: opts.supplier,
            costCents: it.costCents,
            costTenThou: it.costTenThou,
            priceCents: it.priceCents,
            altNumbers: it.altNumbers,
            numberKeys: it.numberKeys,
            qtyOnHand: it.more,
          })),
        }).catch(addedMeanwhile);
      }
      for (let i = 0; i < moves.length; i += BLOCK) await tx.stockMove.createMany({ data: moves.slice(i, i + BLOCK).map((m) => ({ ...m, locationId: loc })) });
      // Items that were here already: all their new details in one statement, all their added stock in another.
      const details = items.filter((it) => it.changed);
      if (details.length) {
        const list = JSON.stringify(details.map((it) => ({ id: it.id, description: it.description, brand: it.brand, location: it.location, costCents: it.costCents, costTenThou: it.costTenThou, priceCents: it.priceCents, origin: it.origin, altNumbers: it.altNumbers, numberKeys: it.numberKeys })));
        await tx.$executeRaw`
          UPDATE "Part" p SET description = v.description, brand = v.brand, location = v.location, "costCents" = v."costCents", "costTenThou" = v."costTenThou", "priceCents" = v."priceCents",
            origin = v.origin::"PartOrigin", "altNumbers" = ARRAY(SELECT jsonb_array_elements_text(v."altNumbers")), "numberKeys" = ARRAY(SELECT jsonb_array_elements_text(v."numberKeys"))
          FROM jsonb_to_recordset(${list}::jsonb) AS v(id text, description text, brand text, location text, "costCents" int, "costTenThou" int, "priceCents" int, origin text, "altNumbers" jsonb, "numberKeys" jsonb)
          WHERE p.id = v.id AND p."shopId" = ${shopId}`;
      }
      const stock = items.filter((it) => it.more > 0);
      if (stock.length) {
        const list = JSON.stringify(stock.map((it) => ({ id: it.id, qty: it.more })));
        await tx.$executeRaw`
          UPDATE "Part" p SET "qtyOnHand" = p."qtyOnHand" + v.qty
          FROM jsonb_to_recordset(${list}::jsonb) AS v(id text, qty double precision)
          WHERE p.id = v.id AND p."shopId" = ${shopId}`;
      }
      // Another store than the main one: the stock that came in (new items' and existing ones') is its own level too
      // (Part.qtyOnHand stays the total).
      const placed = [...items, ...fresh].filter((it) => it.more > 0);
      if (atOther && loc && placed.length) {
        const levels = JSON.stringify(placed.map((it) => ({ id: it.id, qty: it.more })));
        await tx.$executeRaw`
          INSERT INTO "StockLevel" ("id", "shopId", "partId", "locationId", "qtyOnHand", "reorderAt", "updatedAt")
          SELECT 'lvl' || md5(random()::text || v.id), ${shopId}, v.id, ${loc}, v.qty, 0, now()
          FROM jsonb_to_recordset(${levels}::jsonb) AS v(id text, qty double precision)
          ON CONFLICT ("partId", "locationId") DO UPDATE SET "qtyOnHand" = "StockLevel"."qtyOnHand" + EXCLUDED."qtyOnHand", "updatedAt" = now()`;
      }
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
  return { added, updated, skipped, ...(unmatched.length ? { unmatched } : {}) };
}
