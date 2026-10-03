"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { isUserError, safe, UserError, type ActionResult } from "@/lib/action";
import { openWaits } from "@/lib/part-waits";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { MAX_STOCK, centsField, countStock, isPartNumberClash, partKeys, partNumberClash, splitList, stockFor, takeShopNumber } from "@/lib/parts";
import { assertId, assertIds, sameText } from "@/lib/input";
import { CONDITIONS, ORIGINS } from "@/lib/part-labels";
import type { PartCondition, PartKind, PartOrigin } from "@/generated/prisma/enums";

const KINDS: PartKind[] = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"];

/** Whole numbers for most things; fabric by the yard to the eighth (`byYard`). Never below 0 or above what a partner accepts. */
function qtyValue(v: FormDataEntryValue | null, byYard = true) {
  const n = Number(str(v) ?? "0");
  if (!Number.isFinite(n)) return 0;
  if (n > MAX_STOCK) throw new UserError(`${MAX_STOCK.toLocaleString("en-US")} is the most it can be.`);
  return Math.max(0, byYard ? Math.round(n * 1000) / 1000 : Math.round(n));
}

/** What the form says about the item. The part number is null when left blank: the shop gives such an item a number. */
function partData(formData: FormData) {
  const partNumber = str(formData.get("partNumber"));
  const description = str(formData.get("description"));
  if (!description) throw new UserError("Enter a description.");
  const kind = (str(formData.get("kind")) ?? "PART") as PartKind;
  if (!KINDS.includes(kind)) throw new UserError("Pick what kind of item it is.");
  // A form from before these were added doesn't send them: a new item is New + Genuine, a saved one stays as it is.
  const condition = str(formData.get("condition")) as PartCondition | null;
  if (condition && !CONDITIONS.includes(condition)) throw new UserError("Pick new, used or refurbished.");
  const origin = str(formData.get("origin")) as PartOrigin | null;
  if (origin && !ORIGINS.includes(origin)) throw new UserError("Pick who made it: genuine, compatible or 3D printed.");
  return {
    partNumber,
    description,
    kind,
    condition: condition ?? undefined,
    origin: origin ?? undefined,
    altNumbers: splitList(str(formData.get("altNumbers"))),
    brand: str(formData.get("brand")),
    fits: str(formData.get("fits")),
    location: str(formData.get("location")),
    reorderAt: qtyValue(formData.get("reorderAt")),
    unit: str(formData.get("unit")) === "yd" ? "yd" : null,
    wholesaleCents: centsField(formData.get("wholesale"), "Partner price"),
    offerToPartners: formData.get("offerToPartners") === "on",
    costCents: centsField(formData.get("cost"), "Cost"),
    priceCents: centsField(formData.get("price"), "Price"),
    supplier: str(formData.get("supplier")),
    notes: str(formData.get("notes")),
  };
}

export const createPart = safe(async function createPart(formData: FormData) {
  const user = await requireUser();
  const data = partData(formData);
  const qty = qtyValue(formData.get("qtyOnHand"), data.unit === "yd");
  const row = {
    ...data,
    shopId: user.shopId,
    qtyOnHand: qty,
    moves: qty ? { create: { shopId: user.shopId, qty, reason: "RECEIVED" as const, userId: user.id, note: "Opening stock" } } : undefined,
  };
  if (!data.partNumber) {
    // The maker gave no number: the item gets a shop number (SB-00001), taken in the same step as the item.
    const p = await db
      .$transaction(async (tx) => {
        const partNumber = await takeShopNumber(tx, user.shopId);
        return tx.part.create({ data: { ...row, partNumber, ownNumber: true, numberKeys: partKeys(partNumber, data.altNumbers) } });
      })
      .catch((e: unknown) => {
        // Two saves took the same shop number at the same moment (the counter's step and the number check don't lock
        // each other out): the database's key refused the second, and saving again takes the next number.
        throw isPartNumberClash(e) ? new UserError("Another item was given that shop number at the same moment. Save again.") : e;
      });
    revalidatePath("/parts");
    redirect(`/parts/${p.id}`);
  }
  // The same number in another case is the same part (the scanner treats them as one). A partner's consigned stock
  // doesn't count: the shop's own stock of that number is kept apart as "<number> (own)", as the import does. The same
  // part in another condition is a second item, "<number> (used)".
  const stock = await stockFor(db, user.shopId, data.partNumber, data.condition ?? "NEW");
  if (stock.existing && qty) throw new UserError(`${stock.existing.partNumber} is already in inventory. Open it and use Receive stock to add ${qty}.`);
  // Opened with a note on the page: what was typed here isn't saved anywhere.
  if (stock.existing) redirect(`/parts/${stock.existing.id}?existing=1`);
  const altNumbers = [...new Set([...stock.altNumbers, ...data.altNumbers.filter((n) => n !== data.partNumber)])];
  // The check above and this insert aren't one step: someone adding the same number (in any case) meanwhile is caught
  // by the database's key on the number, not made a second item.
  const p = await db.part.create({ data: { ...row, partNumber: stock.partNumber, altNumbers, numberKeys: partKeys(stock.partNumber, altNumbers) } }).catch(async (e: unknown) => {
    throw await partNumberClash(e, user.shopId, stock.partNumber);
  });
  revalidatePath("/parts");
  redirect(`/parts/${p.id}`);
});

export const updatePart = safe(async function updatePart(partId: string, formData: FormData) {
  assertId(partId);
  const user = await requireUser();
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId } });
  if (!p) throw new UserError("Part not found.");
  const data = partData(formData);
  // A shop number stays as it is (its form shows it, but doesn't send it).
  const partNumber = p.ownNumber ? p.partNumber : data.partNumber;
  if (!partNumber) throw new UserError("Enter a part number.");
  // What an item costs, sells for and is offered to partner shops at is for an owner or admin to change (the register
  // holds a tech to the price too): a tech's Save keeps those as they were.
  if (user.role === "TECH") Object.assign(data, { costCents: p.costCents, priceCents: p.priceCents, wholesaleCents: p.wholesaleCents, offerToPartners: p.offerToPartners });
  const clash = await db.part.findFirst({ where: { shopId: user.shopId, id: { not: partId }, partNumber: sameText(partNumber) } });
  if (clash) throw new UserError(`${clash.partNumber} is already another item in inventory.`);
  const altNumbers = data.altNumbers.filter((n) => n !== partNumber);
  // The clash check and this update aren't one step: the database's key on the number (in any case) catches a number
  // taken meanwhile.
  await db.part.update({ where: { id: partId }, data: { ...data, partNumber, altNumbers, numberKeys: partKeys(partNumber, altNumbers) } }).catch(async (e: unknown) => {
    throw await partNumberClash(e, user.shopId, partNumber);
  });
  revalidatePath(`/parts/${partId}`);
  revalidatePath("/parts");
});

/** Receive stock (+) or correct the count (set to what's on the shelf). Received stock that tickets are waiting for says so in the toast. */
export async function moveStock(partId: string, formData: FormData): Promise<ActionResult> {
  try {
    assertId(partId);
    const user = await requireUser();
    await requireBaseWritable(user); // a stock move is new work: refused while the program is read-only
    const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId } });
    if (!p) throw new UserError("Part not found.");
    // A partner's consigned stock is placed, counted and taken back by the partner; receiving the shop's own units into
    // it would pay the partner for them when they sell.
    if (p.consignLinkId) throw new UserError(`${p.partNumber} is a partner's consigned stock: its stock comes and goes through the partnership. Add your own stock as a separate item.`);
    const mode = str(formData.get("mode"));
    const raw = Number(str(formData.get("qty")) ?? "NaN");
    if (!Number.isFinite(raw)) throw new UserError("Enter a quantity.");
    // Fabric is counted in yards (to the eighth); everything else in whole pieces.
    const n = p.unit === "yd" ? Math.round(raw * 1000) / 1000 : Math.round(raw);
    if (n < 0 || n > MAX_STOCK) throw new UserError(`Enter a quantity from 0 to ${MAX_STOCK.toLocaleString("en-US")}.`);
    const note = str(formData.get("note"));
    if (mode === "count") {
      await countStock(user.shopId, partId, n, user.id, note ?? "Shelf count");
    } else {
      if (n <= 0) throw new UserError("Enter how many arrived.");
      const cost = centsField(formData.get("cost"), "Cost");
      await db.$transaction([
        db.part.update({ where: { id: partId }, data: { qtyOnHand: { increment: n }, ...(cost != null ? { costCents: cost } : {}) } }),
        db.stockMove.create({ data: { shopId: user.shopId, partId, qty: n, reason: "RECEIVED", userId: user.id, note } }),
      ]);
    }
    revalidatePath(`/parts/${partId}`);
    revalidatePath("/parts");
    revalidatePath("/");
    if (mode !== "count") {
      const waiting = await openWaits(user.shopId, { partId });
      if (waiting.length) {
        const n = waiting.length;
        return {
          ok: true,
          warn: `Received. ${n} ticket${n === 1 ? " is" : "s are"} waiting for this part: mark ${n === 1 ? "it" : "them"} received under Parts, On order, so the customer${n === 1 ? "" : "s"} hear${n === 1 ? "s" : ""} it's in.`,
        };
      }
    }
    return { ok: true };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

// ---------- where to buy (this shop's own suppliers for a part) ----------

/** The part, if it's this shop's. PartSource has no shopId, so every write below is scoped by the id this returns. */
async function ownPart(partId: string) {
  assertId(partId);
  const user = await requireUser();
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId }, select: { id: true } });
  if (!p) throw new UserError("Part not found.");
  return p;
}

export const addPartSource = safe(async function addPartSource(partId: string, formData: FormData) {
  const { id } = await ownPart(partId);
  const vendor = str(formData.get("vendor"));
  const url = str(formData.get("url"));
  if (!vendor) throw new UserError("Enter where you buy it.");
  if (url && !/^https?:\/\//i.test(url)) throw new UserError("The link must start with http:// or https://");
  const priceCents = centsField(formData.get("price"), "Price");
  const preferred = formData.get("preferred") === "on";
  await db.$transaction([
    ...(preferred ? [db.partSource.updateMany({ where: { partId: id }, data: { preferred: false } })] : []),
    db.partSource.create({ data: { partId: id, vendor, url, priceCents, note: str(formData.get("note")), preferred } }),
  ]);
  revalidatePath(`/parts/${id}`);
});

export const removePartSource = safe(async function removePartSource(partId: string, sourceId: string) {
  assertIds(partId, sourceId);
  const { id } = await ownPart(partId);
  await db.partSource.deleteMany({ where: { id: sourceId, partId: id } });
  revalidatePath(`/parts/${id}`);
});

export const preferPartSource = safe(async function preferPartSource(partId: string, sourceId: string) {
  assertIds(partId, sourceId);
  const { id } = await ownPart(partId);
  await db.$transaction([
    db.partSource.updateMany({ where: { partId: id }, data: { preferred: false } }),
    db.partSource.updateMany({ where: { id: sourceId, partId: id }, data: { preferred: true } }),
  ]);
  revalidatePath(`/parts/${id}`);
});
