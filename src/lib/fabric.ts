import "server-only";
// Fabric basics (fabric-smarts-design.md, package F1): cutting a bolt end into fat quarters, half yards or a remnant,
// the Fabric page's list of bolt ends, and adding a whole collection. Bodies the server actions in src/actions/fabric.ts
// call; each reads and writes only the signed-in company's rows.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str } from "@/lib/format";
import { MAX_CENTS, MAX_STOCK, centsField, partKeys, partNumberClash } from "@/lib/parts";
import { inEighths, yards } from "@/lib/register-math";
import { CUT_INFO, cutPlan, cutPrices, type CutKind } from "@/lib/fabric-math";
import type { CurrentUser } from "@/lib/session";
import type { InPrint } from "@/generated/prisma/enums";

const LINK = { FQ: "fatQuarterId", HALF: "halfYardId", REMNANT: "remnantId" } as const;
const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTO_BYTES = 2_500_000;
export const MAX_COLLECTION_ROWS = 60;

/**
 * Cuts the fabric's yards into fat quarters, half yards or a remnant: takes them off the bolt, adds them to the item
 * that kind of cut feeds (made the first time, priced from the yard price by the shop's settings), and records both
 * moves (reason CUT, each naming the other item). Returns the sentence the shop sees.
 */
export async function cutFor(user: CurrentUser, partId: string, kind: CutKind): Promise<string> {
  assertId(partId);
  if (!(kind in CUT_INFO)) throw new UserError("Pick fat quarters, half yards or remnant.");
  const info = CUT_INFO[kind];
  const out = await db
    .$transaction(async (tx) => {
      const src = await tx.part.findFirst({ where: { id: partId, shopId: user.shopId }, include: { photos: { orderBy: { sortOrder: "asc" }, take: 1 } } });
      if (!src) throw new UserError("Fabric not found.");
      if (src.consignLinkId) throw new UserError(`${src.partNumber} is a partner's consigned stock: it can't be cut here.`);
      if (src.unit !== "yd") throw new UserError(`${src.partNumber} isn't sold by the yard, so there are no yards to cut.`);
      if (src.qtyOnHand <= 0) throw new UserError(`${src.partNumber} has no yards left to cut.`);
      const plan = cutPlan(kind, src.qtyOnHand);
      if (plan.count <= 0) throw new UserError(`${yards(src.qtyOnHand)} yd is too short for a ${info.one}.`);
      if (src.priceCents == null) throw new UserError(`Give ${src.partNumber} a price per yard first: the ${info.tag} price is worked out from it.`);
      const shop = await tx.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { fatQuarterMarkupPct: true, halfYardMarkupPct: true, remnantPricePct: true } });
      const link = src[LINK[kind]];
      let target = link ? await tx.part.findFirst({ where: { id: link, shopId: user.shopId } }) : null;
      let made = false;
      if (!target) {
        const partNumber = `${src.partNumber}-${info.suffix}`;
        const taken = await tx.part.findFirst({ where: { shopId: user.shopId, partNumber: { equals: partNumber, mode: "insensitive" } }, select: { partNumber: true } });
        if (taken) throw new UserError(`${taken.partNumber} is already another item in inventory, so the ${info.tag} item can't be made under that number. Rename that item first.`);
        const prices = cutPrices(kind, src, shop);
        target = await tx.part.create({
          data: {
            shopId: user.shopId,
            partNumber,
            numberKeys: partKeys(partNumber, []),
            ownNumber: src.ownNumber,
            description: `${src.description} (${info.tag})`,
            kind: "FABRIC",
            unit: info.each ? null : "yd",
            brand: src.brand,
            collection: src.collection,
            designer: src.designer,
            colorTags: src.colorTags,
            inPrint: src.inPrint,
            supplier: src.supplier,
            location: src.location,
            boltYards: src.boltYards,
            reorderAt: 0,
            ...prices,
            // The same swatch, so the register and the stock list show the fabric on the cut too.
            photos: src.photos[0] ? { create: { shopId: user.shopId, mime: src.photos[0].mime, data: src.photos[0].data, sortOrder: 0 } } : undefined,
          },
        });
        await tx.part.update({ where: { id: src.id }, data: { [LINK[kind]]: target.id } });
        made = true;
      }
      // The bolt's yards go first, and only while they are all still there (two cuts at once can't take the same yards).
      const took = await tx.part.updateMany({ where: { id: src.id, shopId: user.shopId, qtyOnHand: { gte: plan.usedYards } }, data: { qtyOnHand: { decrement: plan.usedYards } } });
      if (took.count !== 1) throw new UserError(`${src.partNumber} changed while you were cutting it. Look at the yards left and try again.`);
      await tx.part.update({ where: { id: target.id }, data: { qtyOnHand: { increment: plan.count } } });
      const what = kind === "REMNANT" ? `${yards(plan.count)} yd of remnant` : `${plan.count} ${plan.count === 1 ? info.one : info.many}`;
      await tx.stockMove.createMany({
        data: [
          { shopId: user.shopId, partId: src.id, qty: -plan.usedYards, reason: "CUT", userId: user.id, note: `Cut into ${what}`, otherPartId: target.id },
          { shopId: user.shopId, partId: target.id, qty: plan.count, reason: "CUT", userId: user.id, note: `Cut from ${yards(plan.usedYards)} yd of ${src.partNumber}`, otherPartId: src.id },
        ],
      });
      const left = plan.leftYards > 0 ? ` ${yards(plan.leftYards)} yd left on the bolt.` : "";
      return { text: `Cut ${yards(plan.usedYards)} yd into ${what}${made ? ` (new item ${target.partNumber})` : ""}.${left}`, number: `${src.partNumber}-${info.suffix}` };
    })
    .catch(async (e: unknown) => {
      // Two cuts made the target item at the same moment: the database's key on the number refused the second.
      const src = await db.part.findFirst({ where: { id: partId, shopId: user.shopId }, select: { partNumber: true } });
      throw await partNumberClash(e, user.shopId, `${src?.partNumber ?? ""}-${info.suffix}`);
    });
  return out.text;
}

export type BoltEnd = {
  id: string;
  partNumber: string;
  description: string;
  brand: string | null;
  collection: string | null;
  qtyOnHand: number;
  priceCents: number | null;
  photoId: string | null;
};

/**
 * Fabric with `boltEndYards` or fewer left and none on order (no open "waiting on a part" for it), least first. The items
 * the cuts feed (fat quarters, remnant) aren't bolt ends themselves.
 */
export async function boltEndsFor(shopId: string): Promise<{ rows: BoltEnd[]; limit: number }> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { boltEndYards: true } });
  const [linked, ordered] = await Promise.all([
    db.part.findMany({ where: { shopId, OR: [{ fatQuarterId: { not: null } }, { halfYardId: { not: null } }, { remnantId: { not: null } }] }, select: { fatQuarterId: true, halfYardId: true, remnantId: true } }),
    db.partWait.findMany({ where: { shopId, receivedAt: null, cancelledAt: null, partId: { not: null } }, select: { partId: true } }),
  ]);
  const skip = new Set<string>([...linked.flatMap((l) => [l.fatQuarterId, l.halfYardId, l.remnantId]), ...ordered.map((o) => o.partId)].filter((x): x is string => !!x));
  const parts = await db.part.findMany({
    where: { shopId, kind: "FABRIC", unit: "yd", consignLinkId: null, qtyOnHand: { gt: 0, lte: shop.boltEndYards }, id: { notIn: [...skip] } },
    orderBy: [{ qtyOnHand: "asc" }, { description: "asc" }],
    take: 500,
    select: { id: true, partNumber: true, description: true, brand: true, collection: true, qtyOnHand: true, priceCents: true, photos: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true } } },
  });
  return { limit: shop.boltEndYards, rows: parts.map(({ photos, ...p }) => ({ ...p, photoId: photos[0]?.id ?? null })) };
}

export type CollectionRow = { number: string; color: string; yards: number; priceCents: number; photo: File | null };

/** Reads the "Add a collection" form: rows i = 0.. with number.i, color.i, yards.i, price.i and photo.i; blank rows are skipped. */
export function collectionRows(fd: FormData): CollectionRow[] {
  const rows: CollectionRow[] = [];
  for (let i = 0; i < MAX_COLLECTION_ROWS + 20; i++) {
    const number = str(fd.get(`number.${i}`));
    const color = str(fd.get(`color.${i}`));
    const y = str(fd.get(`yards.${i}`));
    const price = str(fd.get(`price.${i}`));
    const file = fd.get(`photo.${i}`);
    const photo = file instanceof File && file.size > 0 ? file : null;
    if (!number && !color && !y && !price && !photo) continue;
    const at = `Row ${rows.length + 1}`;
    if (!number) throw new UserError(`${at}: enter the maker's item number.`);
    if (!color) throw new UserError(`${at} (${number}): enter the color.`);
    const n = y ? Number(y) : 0;
    if (!Number.isFinite(n) || n < 0 || n > MAX_STOCK) throw new UserError(`${at} (${number}): yards received must be from 0 to ${MAX_STOCK.toLocaleString("en-US")}.`);
    if (!inEighths(n)) throw new UserError(`${at} (${number}): fabric is counted in eighths of a yard (1/8 = 0.125).`);
    const priceCents = centsField(price, `${at} (${number}) price`);
    if (priceCents == null) throw new UserError(`${at} (${number}): enter the price per yard.`);
    rows.push({ number, color, yards: n, priceCents, photo });
  }
  if (!rows.length) throw new UserError("Add at least one colorway.");
  if (rows.length > MAX_COLLECTION_ROWS) throw new UserError(`${MAX_COLLECTION_ROWS} colorways at most in one go. Add the rest as a second collection entry.`);
  return rows;
}

/**
 * Adds a collection: the maker, collection name and designer once, then one fabric per colorway (item number, color,
 * yards received, price per yard, an optional swatch picture). All or none: a number the shop already has, or a number
 * twice in the list, stops the whole add before anything is made. Returns how many fabrics were made.
 */
export async function addCollectionFor(user: CurrentUser, fd: FormData): Promise<number> {
  const maker = str(fd.get("maker"));
  const collection = str(fd.get("collection"));
  if (!maker) throw new UserError("Enter the maker (Moda, Riley Blake...).");
  if (!collection) throw new UserError("Enter the collection's name.");
  const designer = str(fd.get("designer"));
  const inPrintRaw = str(fd.get("inPrint")) ?? "UNKNOWN";
  if (!["YES", "NO", "UNKNOWN"].includes(inPrintRaw)) throw new UserError("Pick whether the collection is still in print.");
  const boltRaw = str(fd.get("boltYards"));
  const boltYards = boltRaw ? Number(boltRaw) : 15;
  if (!Number.isFinite(boltYards) || boltYards <= 0 || boltYards > 100 || !inEighths(boltYards)) throw new UserError("Yards on a full bolt: a number from 1/8 to 100 (15 is usual).");
  const supplier = str(fd.get("supplier"));
  const rows = collectionRows(fd);
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.number.toLowerCase();
    if (seen.has(k)) throw new UserError(`${r.number} is in the list twice.`);
    seen.add(k);
    if (r.priceCents > MAX_CENTS) throw new UserError(`${r.number}: the price is too high.`);
    if (r.photo && !IMAGE.has(r.photo.type)) throw new UserError(`${r.number}: photos are JPEG, PNG or WebP.`);
    if (r.photo && r.photo.size > MAX_PHOTO_BYTES) throw new UserError(`${r.number}: that photo is too large (2.5 MB at most).`);
  }
  const photos = await Promise.all(rows.map(async (r) => (r.photo ? new Uint8Array(await r.photo.arrayBuffer()) : null)));
  try {
    await db.$transaction(async (tx) => {
      for (const r of rows) {
        const dup = await tx.part.findFirst({ where: { shopId: user.shopId, partNumber: { equals: r.number, mode: "insensitive" } }, select: { partNumber: true } });
        if (dup) throw new UserError(`${dup.partNumber} is already in inventory. Take it out of the list (open it to receive more).`);
      }
      for (const [i, r] of rows.entries()) {
        const data = photos[i];
        await tx.part.create({
          data: {
            shopId: user.shopId,
            partNumber: r.number,
            numberKeys: partKeys(r.number, []),
            description: `${collection} ${r.color}`,
            kind: "FABRIC",
            unit: "yd",
            brand: maker,
            collection,
            designer,
            inPrint: inPrintRaw as InPrint,
            boltYards,
            priceCents: r.priceCents,
            qtyOnHand: r.yards,
            supplier,
            colorTags: [],
            moves: r.yards > 0 ? { create: { shopId: user.shopId, qty: r.yards, reason: "RECEIVED", userId: user.id, note: `Received with ${collection}` } } : undefined,
            photos: data ? { create: { shopId: user.shopId, mime: r.photo!.type, data, sortOrder: 0 } } : undefined,
          },
        });
      }
    });
  } catch (e) {
    // Someone added one of these numbers at the same moment: the database's key on the number refused it.
    throw await partNumberClash(e, user.shopId, rows.map((r) => r.number).join(" or "));
  }
  return rows.length;
}
