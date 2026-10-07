import "server-only";
// Catalog import through a connector (package F6): the sheet's rows become new fabrics or updates to the shop's own
// fabrics, matched by the maker's item number. A dry run counts and lists what would change without writing; applying
// plans again inside one transaction (so a change between preview and apply is honoured) and writes. Stock is never
// touched: a catalog says what exists, not what the shop has. Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { money } from "@/lib/format";
import { MAX_CENTS, numberKey, partKeys, partNumberClash } from "@/lib/parts";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";
import { catalogConnectorFor } from "./registry";
import { cleanMap, headerRowIndex, suggestMap } from "./layout";
import { readTable } from "./sheet";
import type { CatalogRow, ColumnMap } from "./types";

export const MAX_CATALOG_ROWS = 20_000;
const BLOCK = 500;

export type SheetView = { headers: string[]; sample: string[][]; rowCount: number; map: ColumnMap; mapFrom: "saved" | "suggested" | "placeholder"; placeholder: boolean };

/** What the mapping step shows: the sheet's headings, its first rows, and the map to start from (the supplier's saved one, else the headings' own). */
export async function sheetViewFor(user: CurrentUser, supplierId: string, name: string, bytes: Uint8Array): Promise<SheetView> {
  assertId(supplierId);
  const s = await db.fabricSupplier.findFirst({ where: { id: supplierId, shopId: user.shopId } });
  if (!s) throw new UserError("Supplier not found.");
  const table = readTable(name, bytes);
  if (!table.length) throw new UserError("That sheet is empty.");
  const h0 = headerRowIndex(table);
  const headers = table[h0].map((c) => c.trim());
  const conn = catalogConnectorFor(s.connector);
  const saved = cleanMap(s.catalogMap);
  const have = (m: ColumnMap) => Object.values(m).filter((h) => headers.some((x) => x.toLowerCase() === h.toLowerCase())).length;
  let map = saved;
  let mapFrom: SheetView["mapFrom"] = "saved";
  if (!saved.itemNumber || have(saved) === 0) {
    const dflt = cleanMap(conn.defaultMap ?? {});
    if (conn.placeholder && have(dflt) >= 2) {
      map = dflt;
      mapFrom = "placeholder";
    } else {
      map = suggestMap(headers);
      mapFrom = "suggested";
    }
  }
  return { headers, sample: table.slice(h0 + 1, h0 + 6), rowCount: Math.max(0, table.length - h0 - 1), map, mapFrom, placeholder: !!conn.placeholder };
}

export type CatalogChange = { itemNumber: string; what: string[] };
export type CatalogPlan = {
  creates: CatalogRow[];
  updates: { id: string; row: CatalogRow; data: Prisma.PartUpdateInput; what: string[] }[];
  unchanged: number;
  skipped: string[];
};
export type CatalogPreview = { create: number; update: number; unchanged: number; skipped: number; problems: string[]; newSample: string[]; changeSample: CatalogChange[]; missing: string[] };

const supplierText = (name: string) => name.trim().slice(0, 80);

/** Plans the import against the shop's fabrics now: which rows make a fabric, which change one, which change nothing. Reads only. */
async function plan(tx: Prisma.TransactionClient, shopId: string, supplierName: string, rows: CatalogRow[]): Promise<CatalogPlan> {
  const out: CatalogPlan = { creates: [], updates: [], unchanged: 0, skipped: [] };
  const keys = [...new Set(rows.map((r) => numberKey(r.itemNumber)).filter((k) => k.length >= 3))];
  const found: Awaited<ReturnType<typeof tx.part.findMany>> = [];
  for (let i = 0; i < keys.length; i += BLOCK) found.push(...(await tx.part.findMany({ where: { shopId, numberKeys: { hasSome: keys.slice(i, i + BLOCK) } } })));
  const byKey = new Map<string, typeof found>();
  for (const p of found) for (const k of new Set([numberKey(p.partNumber), ...p.altNumbers.map(numberKey)])) byKey.set(k, [...(byKey.get(k) ?? []), p]);
  const marked = new Set((await tx.fabricMarkdown.findMany({ where: { shopId, undoneAt: null, partId: { in: found.map((p) => p.id) } }, select: { partId: true } })).map((m) => m.partId));
  const seen = new Set<string>();
  for (const r of rows) {
    const k = numberKey(r.itemNumber);
    if (k.length < 3) {
      out.skipped.push(`Row ${r.line}: "${r.itemNumber}" is too short to be an item number.`);
      continue;
    }
    if (seen.has(k)) {
      out.skipped.push(`Row ${r.line}: ${r.itemNumber} is in the sheet twice; the first row was used.`);
      continue;
    }
    seen.add(k);
    const cands = [...new Map((byKey.get(k) ?? []).map((p) => [p.id, p])).values()];
    const exact = cands.find((p) => p.partNumber.toLowerCase() === r.itemNumber.toLowerCase()) ?? cands.find((p) => numberKey(p.partNumber) === k) ?? (cands.length === 1 ? cands[0] : undefined);
    if (cands.length > 1 && !exact) {
      out.skipped.push(`Row ${r.line}: ${r.itemNumber} matches ${cands.length} items; left alone.`);
      continue;
    }
    if (!exact) {
      out.creates.push(r);
      continue;
    }
    if (exact.kind !== "FABRIC" || exact.unit !== "yd" || exact.consignLinkId) {
      out.skipped.push(`Row ${r.line}: ${r.itemNumber} is already in inventory as something other than fabric by the yard; left alone.`);
      continue;
    }
    const data: Prisma.PartUpdateInput = {};
    const what: string[] = [];
    if (r.description && r.description !== exact.description) {
      data.description = r.description;
      what.push(`description "${exact.description}" to "${r.description}"`);
    }
    if (r.costTenThou != null && r.costTenThou !== (exact.costTenThou ?? (exact.costCents != null ? exact.costCents * 100 : null))) {
      data.costTenThou = r.costTenThou;
      data.costCents = r.costCents;
      what.push(`cost ${exact.costCents == null ? "none" : money(exact.costCents)} to ${money(r.costCents!)}`);
    }
    if (r.priceCents != null && r.priceCents !== exact.priceCents) {
      if (marked.has(exact.id)) out.skipped.push(`Row ${r.line}: ${r.itemNumber} is marked down, so its price was left alone.`);
      else {
        data.priceCents = r.priceCents;
        what.push(`price ${exact.priceCents == null ? "none" : money(exact.priceCents)} to ${money(r.priceCents)}`);
      }
    }
    for (const f of ["collection", "designer"] as const) {
      const v = r[f];
      if (v && v !== exact[f]) {
        data[f] = v;
        what.push(`${f} to ${v}`);
      }
    }
    if (r.brand && r.brand !== exact.brand) {
      data.brand = r.brand;
      what.push(`maker to ${r.brand}`);
    }
    if (r.boltYards != null && r.boltYards !== exact.boltYards) {
      data.boltYards = r.boltYards;
      what.push(`bolt length to ${r.boltYards} yd`);
    }
    if (!exact.supplier?.trim()) {
      data.supplier = supplierText(supplierName);
      what.push(`supplier to ${supplierName}`);
    }
    if (what.length) out.updates.push({ id: exact.id, row: r, data, what });
    else out.unchanged += 1;
  }
  return out;
}

async function readRows(user: CurrentUser, supplierId: string, name: string, bytes: Uint8Array, rawMap: unknown) {
  assertId(supplierId);
  const s = await db.fabricSupplier.findFirst({ where: { id: supplierId, shopId: user.shopId } });
  if (!s) throw new UserError("Supplier not found.");
  const map = cleanMap(rawMap);
  if (!map.itemNumber) throw new UserError("Pick the column that holds the maker's item number.");
  const read = catalogConnectorFor(s.connector).readCatalog!(readTable(name, bytes), map);
  if (read.missing.length) throw new UserError(`The sheet has no column headed ${read.missing.map((f) => `"${map[f]}"`).join(", ")}. Pick the columns again.`);
  if (!read.rows.length) throw new UserError(read.problems[0] ?? "No rows to import.");
  if (read.rows.length > MAX_CATALOG_ROWS) throw new UserError(`${MAX_CATALOG_ROWS.toLocaleString("en-US")} rows at a time, please.`);
  return { s, map, read };
}

/** The dry run: counts and examples of what applying would do. Nothing is written. */
export async function previewCatalogFor(user: CurrentUser, supplierId: string, name: string, bytes: Uint8Array, rawMap: unknown): Promise<CatalogPreview> {
  const { s, read } = await readRows(user, supplierId, name, bytes, rawMap);
  const p = await plan(db, user.shopId, s.name, read.rows);
  const problems = [...read.problems, ...p.skipped];
  return {
    create: p.creates.length,
    update: p.updates.length,
    unchanged: p.unchanged,
    skipped: problems.length,
    problems: problems.slice(0, 25),
    newSample: p.creates.slice(0, 8).map((r) => `${r.itemNumber}${r.description ? ` ${r.description}` : ""}`),
    changeSample: p.updates.slice(0, 8).map((u) => ({ itemNumber: u.row.itemNumber, what: u.what })),
    missing: read.missing,
  };
}

/** Applies it: new fabrics are made (no stock), changed ones updated, the map saved on the supplier. All or nothing. */
export async function applyCatalogFor(user: CurrentUser, supplierId: string, name: string, bytes: Uint8Array, rawMap: unknown, saveMap: boolean): Promise<string> {
  const { s, map, read } = await readRows(user, supplierId, name, bytes, rawMap);
  try {
    return await db.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(7710003, hashtext(${user.shopId})) AS ok`;
        if (!lock.ok) throw new UserError("A catalog import for this company is already running. Wait for it to finish, then look at the fabric list.");
        const p = await plan(tx, user.shopId, s.name, read.rows);
        for (let i = 0; i < p.creates.length; i += BLOCK) {
          await tx.part.createMany({
            data: p.creates.slice(i, i + BLOCK).map((r) => ({
              shopId: user.shopId,
              partNumber: r.itemNumber,
              numberKeys: partKeys(r.itemNumber, []),
              description: r.description ?? `${r.collection ?? s.name} ${r.itemNumber}`.slice(0, 200),
              kind: "FABRIC" as const,
              unit: "yd",
              brand: r.brand ?? null,
              collection: r.collection ?? null,
              designer: r.designer ?? null,
              boltYards: r.boltYards ?? 15,
              costCents: r.costCents ?? null,
              costTenThou: r.costTenThou ?? null,
              priceCents: r.priceCents != null && r.priceCents <= MAX_CENTS ? r.priceCents : null,
              supplier: supplierText(s.name),
              qtyOnHand: 0,
              colorTags: [],
            })),
          });
        }
        for (const u of p.updates) await tx.part.update({ where: { id: u.id }, data: u.data });
        const note = `${p.creates.length} new, ${p.updates.length} updated, ${p.unchanged} unchanged`;
        await tx.fabricSupplier.update({ where: { id: s.id }, data: { catalogAt: new Date(), catalogNote: note, ...(saveMap ? { catalogMap: map } : {}) } });
        const partly = p.skipped.length + read.problems.length;
        return `Imported ${s.name}'s catalog: ${note}${partly ? `; ${partly} rows were skipped or partly read` : ""}.${saveMap ? " The column mapping is saved for next time." : ""}`;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  } catch (e) {
    throw await partNumberClash(e, user.shopId, "one of those numbers");
  }
}
