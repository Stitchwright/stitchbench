import "server-only";
// Catalog import through a connector (package F6): the sheet's rows become new items or updates to the shop's own items,
// matched by the maker's item number. A dry run counts and lists what would change without writing; applying plans again
// inside one transaction (so a change between preview and apply is honoured) and writes. Stock is never touched: a
// catalog says what exists, not what the shop has. Every query filters by shopId.
// Since shop-features-round-2-design.md 2.3 (package catalog-any-item) a list can hold any item: thread, notions,
// accessories, patterns and supplies beside fabric, each row's type from its own column or the supplier's default
// (FabricSupplier.defaultKind), with the item details of 2.1 (color number and name, material, weight, spool size...).
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { money } from "@/lib/format";
import { MAX_CENTS, numberKey, partKeys, partNumberClash } from "@/lib/parts";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";
import { detailsFrom, kindChoiceValue, kindFromWords, machineKindFromWords, machineKindKey, parseKindChoice, specsOf, typeOf, type Details, type ItemType, type PlainKind, type Specs } from "@/lib/item-details";
import { Prisma as P } from "@/generated/prisma/client";
import { catalogConnectorFor } from "./registry";
import { cleanMap, headerRowIndex, suggestMap } from "./layout";
import { readTable } from "./sheet";
import type { CatalogRead, CatalogRow, ColumnMap } from "./types";
import { catalogSourceFor } from "./sources";

export const MAX_CATALOG_ROWS = 20_000;
const BLOCK = 500;

export type SheetView = { headers: string[]; sample: string[][]; rowCount: number; map: ColumnMap; mapFrom: "saved" | "suggested" | "placeholder"; placeholder: boolean; defaultKind: string };

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
  return { headers, sample: table.slice(h0 + 1, h0 + 6), rowCount: Math.max(0, table.length - h0 - 1), map, mapFrom, placeholder: !!conn.placeholder, defaultKind: kindChoiceValue(s.defaultKind) ?? "FABRIC" };
}

export type CatalogChange = { itemNumber: string; what: string[] };
type Choice = { kind: PlainKind; itemType: ItemType | null };
export type CatalogPlan = {
  creates: { row: CatalogRow; choice: Choice; details: Details }[];
  updates: { id: string; row: CatalogRow; data: Prisma.PartUpdateInput; what: string[] }[];
  unchanged: number;
  skipped: string[];
};
export type CatalogPreview = { create: number; update: number; unchanged: number; skipped: number; problems: string[]; newSample: string[]; changeSample: CatalogChange[]; missing: string[] };

const supplierText = (name: string) => name.trim().slice(0, 80);

/** A row's item details as the item form would read them (the swatch color isn't a list column). */
const rowDetail = (r: CatalogRow) => (key: string): string | null => {
  const v = (r as Record<string, unknown>)[key];
  return key === "colorHex" || typeof v !== "string" ? null : v;
};

const isFabricYd = (p: { kind: string; unit: string | null }) => p.kind === "FABRIC" && p.unit === "yd";

/**
 * Plans the import against the shop's items now: which rows make an item, which change one, which change nothing. Each
 * row's type is its own type column in words, else `defaultKind`. Reads only.
 */
async function plan(tx: Prisma.TransactionClient, shopId: string, supplierName: string, rows: CatalogRow[], defaultKind = "FABRIC"): Promise<CatalogPlan> {
  const fallback = parseKindChoice(kindChoiceValue(defaultKind) ?? "FABRIC");
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
    // The row's type: its own column in words ("Thread", "3D filament"), else the list's default.
    const typed = r.kind ? kindFromWords(r.kind) : null;
    if (r.kind && !typed) out.skipped.push(`Row ${r.line} (${r.itemNumber}): type "${r.kind.slice(0, 30)}" isn't one the program knows; read as the list's default.`);
    const choice: Choice = typed ? parseKindChoice(typed) : fallback;
    // A list has no swatch column, so nothing here can be refused.
    const details: Details = detailsFrom(choice.itemType, rowDetail(r));
    // A machine model: which machines-for-sale kind it becomes, from the type column's words (sewing when they don't say).
    if (choice.kind === "MACHINE") details.specs.machineKind = machineKindFromWords(r.kind) ?? machineKindKey(details.specs.machineKind);
    const cands = [...new Map((byKey.get(k) ?? []).map((p) => [p.id, p])).values()];
    const exact = cands.find((p) => p.partNumber.toLowerCase() === r.itemNumber.toLowerCase()) ?? cands.find((p) => numberKey(p.partNumber) === k) ?? (cands.length === 1 ? cands[0] : undefined);
    if (cands.length > 1 && !exact) {
      out.skipped.push(`Row ${r.line}: ${r.itemNumber} matches ${cands.length} items; left alone.`);
      continue;
    }
    if (!exact) {
      out.creates.push({ row: r, choice, details });
      continue;
    }
    if (exact.consignLinkId) {
      out.skipped.push(`Row ${r.line}: ${r.itemNumber} is a partner's consigned stock here; left alone.`);
      continue;
    }
    if (choice.kind === "FABRIC" && !isFabricYd(exact)) {
      out.skipped.push(`Row ${r.line}: ${r.itemNumber} is already in inventory as something other than fabric by the yard; left alone.`);
      continue;
    }
    if (choice.kind !== "FABRIC" && isFabricYd(exact)) {
      out.skipped.push(`Row ${r.line}: ${r.itemNumber} is fabric by the yard in inventory, not ${choice.kind.toLowerCase()}; left alone.`);
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
    if (isFabricYd(exact)) {
      for (const f of ["collection", "designer"] as const) {
        const v = r[f];
        if (v && v !== exact[f]) {
          data[f] = v;
          what.push(`${f} to ${v}`);
        }
      }
      if (r.boltYards != null && r.boltYards !== exact.boltYards) {
        data.boltYards = r.boltYards;
        what.push(`bolt length to ${r.boltYards} yd`);
      }
    }
    if (r.brand && r.brand !== exact.brand) {
      data.brand = r.brand;
      what.push(`maker to ${r.brand}`);
    }
    // A barcode the item doesn't know yet goes among its other numbers (a scan then finds it).
    if (r.upc && !partKeys(exact.partNumber, exact.altNumbers).some((k) => partKeys(r.upc!, []).includes(k))) {
      const alt = [...exact.altNumbers, r.upc];
      data.altNumbers = alt;
      data.numberKeys = partKeys(exact.partNumber, alt);
      what.push(`barcode ${r.upc} added`);
    }
    // Item details (2.1): an item of no type yet takes the list's type when its kind is the same (a SUPPLY on a filament
    // list becomes filament); then the details the row gives fill or change its own.
    let type = typeOf(exact);
    if (!type && choice.itemType && choice.kind === exact.kind) {
      type = choice.itemType;
      data.itemType = type;
      what.push(`type to ${type}`);
    }
    if (type) {
      const d = type === choice.itemType ? details : detailsFrom(type, rowDetail(r));
      for (const f of ["colorNumber", "colorName", "material"] as const) {
        if (d[f] && d[f] !== exact[f]) {
          data[f] = d[f];
          what.push(`${f === "colorNumber" ? "color number" : f === "colorName" ? "color name" : "material"} to ${d[f]}`);
        }
      }
      const had = specsOf(exact.specs);
      const next: Specs = { ...had };
      for (const [key, v] of Object.entries(d.specs) as [keyof Specs, string][]) {
        if (v && v !== had[key]) {
          next[key] = v;
          what.push(`${key === "putUp" ? "spool" : key} to ${v}`);
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(had)) data.specs = next;
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

/** The list's default type: what the form sent (checked), else the supplier's saved one, else fabric by the yard. */
const defaultKindOf = (sent: string | null | undefined, saved: string | null) => kindChoiceValue(sent) ?? kindChoiceValue(saved) ?? "FABRIC";

/** The company's own supplier, by id. */
async function ownSupplier(user: CurrentUser, supplierId: string) {
  assertId(supplierId);
  const s = await db.fabricSupplier.findFirst({ where: { id: supplierId, shopId: user.shopId } });
  if (!s) throw new UserError("Supplier not found.");
  return s;
}

type Supplier = Awaited<ReturnType<typeof ownSupplier>>;

/** What a source read, checked the same way whatever the source: something to import, and not too much at once. */
function checkRead(read: CatalogRead, map?: ColumnMap) {
  if (map && read.missing.length) throw new UserError(`The sheet has no column headed ${read.missing.map((f) => `"${map[f]}"`).join(", ")}. Pick the columns again.`);
  if (!read.rows.length) throw new UserError(read.problems[0] ?? "No rows to import.");
  if (read.rows.length > MAX_CATALOG_ROWS) throw new UserError(`${MAX_CATALOG_ROWS.toLocaleString("en-US")} rows at a time, please.`);
}

/** The spreadsheet source (the first CatalogSource): the uploaded file read through the column map. */
async function readRows(user: CurrentUser, supplierId: string, name: string, bytes: Uint8Array, rawMap: unknown) {
  const s = await ownSupplier(user, supplierId);
  const map = cleanMap(rawMap);
  if (!map.itemNumber) throw new UserError("Pick the column that holds the maker's item number.");
  const read = catalogConnectorFor(s.connector).readCatalog!(readTable(name, bytes), map);
  checkRead(read, map);
  return { s, map, read };
}

/**
 * The dry run of rows from any source (shop-features-round-2-design.md 2.3: a spreadsheet now, a distributor's own feed
 * or API later, through CatalogSource in ./types): counts and examples of what applying would do. Nothing is written.
 */
export async function previewRowsFor(user: CurrentUser, s: Supplier, read: CatalogRead, defaultKind?: string | null): Promise<CatalogPreview> {
  const p = await plan(db, user.shopId, s.name, read.rows, defaultKindOf(defaultKind, s.defaultKind));
  const problems = [...read.problems, ...p.skipped];
  return {
    create: p.creates.length,
    update: p.updates.length,
    unchanged: p.unchanged,
    skipped: problems.length,
    problems: problems.slice(0, 25),
    newSample: p.creates.slice(0, 8).map(({ row: r }) => `${r.itemNumber}${r.description ? ` ${r.description}` : ""}`),
    changeSample: p.updates.slice(0, 8).map((u) => ({ itemNumber: u.row.itemNumber, what: u.what })),
    missing: read.missing,
  };
}

/** The dry run of an uploaded spreadsheet. Nothing is written. */
export async function previewCatalogFor(user: CurrentUser, supplierId: string, name: string, bytes: Uint8Array, rawMap: unknown, defaultKind?: string | null): Promise<CatalogPreview> {
  const { s, read } = await readRows(user, supplierId, name, bytes, rawMap);
  return previewRowsFor(user, s, read, defaultKind);
}

/** The dry run of a feed source (a distributor's published feed or API); none is registered yet. */
export async function previewSourceFor(user: CurrentUser, supplierId: string, sourceId: string, defaultKind?: string | null): Promise<CatalogPreview> {
  const s = await ownSupplier(user, supplierId);
  const read = await fetchFromSource(user, s, sourceId);
  return previewRowsFor(user, s, read, defaultKind);
}

/** Brings in what a feed source fetched, with the same matching and review as a spreadsheet. */
export async function applySourceFor(user: CurrentUser, supplierId: string, sourceId: string, defaultKind?: string | null): Promise<string> {
  const s = await ownSupplier(user, supplierId);
  const read = await fetchFromSource(user, s, sourceId);
  return applyRowsFor(user, s, read, { defaultKind, saveMap: null, saveKind: true });
}

async function fetchFromSource(user: CurrentUser, s: Supplier, sourceId: string): Promise<CatalogRead> {
  const source = catalogSourceFor(sourceId);
  if (!source || source.kind !== "feed" || !source.fetchCatalog) throw new UserError("That catalog source isn't available.");
  const read = await source.fetchCatalog({ shopId: user.shopId, supplier: { id: s.id, name: s.name, orderEmail: s.orderEmail, accountNumber: s.accountNumber, catalogMap: null, orderLayout: null } });
  checkRead(read);
  return read;
}

/** Applies an uploaded spreadsheet: the map and the list's type saved on the supplier when asked. */
export async function applyCatalogFor(user: CurrentUser, supplierId: string, name: string, bytes: Uint8Array, rawMap: unknown, saveMap: boolean, defaultKind?: string | null): Promise<string> {
  const { s, map, read } = await readRows(user, supplierId, name, bytes, rawMap);
  return applyRowsFor(user, s, read, { defaultKind, saveMap: saveMap ? map : null, saveKind: saveMap });
}

/** Applies rows from any source: new items are made (no stock), changed ones updated. All or nothing. */
async function applyRowsFor(user: CurrentUser, s: Supplier, read: CatalogRead, o: { defaultKind?: string | null; saveMap: ColumnMap | null; saveKind: boolean }): Promise<string> {
  const kindOfList = defaultKindOf(o.defaultKind, s.defaultKind);
  const saveMap = o.saveMap != null;
  const map = o.saveMap;
  try {
    return await db.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(7710003, hashtext(${user.shopId})) AS ok`;
        if (!lock.ok) throw new UserError("A catalog import for this company is already running. Wait for it to finish, then look at the fabric list.");
        const p = await plan(tx, user.shopId, s.name, read.rows, kindOfList);
        for (let i = 0; i < p.creates.length; i += BLOCK) {
          await tx.part.createMany({
            data: p.creates.slice(i, i + BLOCK).map(({ row: r, choice, details: d }) => {
              const fabric = choice.kind === "FABRIC";
              const named = [r.brand, d.colorNumber, d.colorName].filter(Boolean).join(" ");
              return {
                shopId: user.shopId,
                partNumber: r.itemNumber,
                numberKeys: partKeys(r.itemNumber, r.upc ? [r.upc] : []),
                altNumbers: r.upc ? [r.upc] : [],
                description: (r.description ?? (fabric ? `${r.collection ?? s.name} ${r.itemNumber}` : choice.kind === "MACHINE" ? [r.brand, r.model ?? r.itemNumber].filter(Boolean).join(" ") : named || `${s.name} ${r.itemNumber}`)).slice(0, 200),
                kind: choice.kind,
                unit: fabric ? "yd" : null,
                brand: r.brand ?? null,
                collection: fabric ? (r.collection ?? null) : null,
                designer: fabric ? (r.designer ?? null) : null,
                boltYards: fabric ? (r.boltYards ?? 15) : 15,
                costCents: r.costCents ?? null,
                costTenThou: r.costTenThou ?? null,
                priceCents: r.priceCents != null && r.priceCents <= MAX_CENTS ? r.priceCents : null,
                supplier: supplierText(s.name),
                qtyOnHand: 0,
                colorTags: [],
                itemType: choice.itemType,
                colorNumber: d.colorNumber,
                colorName: d.colorName,
                material: d.material,
                specs: Object.keys(d.specs).length ? d.specs : P.DbNull,
              };
            }),
          });
        }
        for (const u of p.updates) await tx.part.update({ where: { id: u.id }, data: u.data });
        const note = `${p.creates.length} new, ${p.updates.length} updated, ${p.unchanged} unchanged`;
        await tx.fabricSupplier.update({ where: { id: s.id }, data: { catalogAt: new Date(), catalogNote: note, ...(map ? { catalogMap: map } : {}), ...(o.saveKind ? { defaultKind: kindOfList } : {}) } });
        const partly = p.skipped.length + read.problems.length;
        return `Imported ${s.name}'s catalog: ${note}${partly ? `; ${partly} rows were skipped or partly read` : ""}.${saveMap ? " The column mapping is saved for next time." : ""}`;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  } catch (e) {
    throw await partNumberClash(e, user.shopId, "one of those numbers");
  }
}
