"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str, toCents } from "@/lib/format";
import { partKeys, splitList } from "@/lib/parts";
import type { PartKind } from "@/generated/prisma/enums";

const KINDS: PartKind[] = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"];

/**
 * A quantity as typed. Whole pieces for most things; fabric by the yard to the thousandth (it's cut to the eighth).
 * Blank is 0. Negative, or a fraction of something sold each, is a typo: the register could never sell that off.
 */
function qtyValue(v: FormDataEntryValue | null, unit: string | null) {
  const s = str(v);
  const n = s == null ? 0 : Number(s);
  if (!Number.isFinite(n) || n < 0) throw new UserError("Enter a quantity of 0 or more.");
  if (unit === "yd") return Math.round(n * 1000) / 1000;
  if (!Number.isInteger(n)) throw new UserError("This item is sold each: use a whole number.");
  return n;
}

function partData(formData: FormData) {
  const partNumber = str(formData.get("partNumber"));
  const description = str(formData.get("description"));
  if (!partNumber || !description) throw new UserError("Enter a part number and description.");
  const kind = (str(formData.get("kind")) ?? "PART") as PartKind;
  if (!KINDS.includes(kind)) throw new UserError("Pick what kind of item it is.");
  const altNumbers = splitList(str(formData.get("altNumbers"))).filter((n) => n !== partNumber);
  const unit = str(formData.get("unit")) === "yd" ? "yd" : null;
  return {
    partNumber,
    description,
    kind,
    altNumbers,
    numberKeys: partKeys(partNumber, altNumbers),
    brand: str(formData.get("brand")),
    fits: str(formData.get("fits")),
    location: str(formData.get("location")),
    reorderAt: qtyValue(formData.get("reorderAt"), unit),
    unit,
    wholesaleCents: toCents(formData.get("wholesale")),
    offerToPartners: formData.get("offerToPartners") === "on",
    costCents: toCents(formData.get("cost")),
    priceCents: toCents(formData.get("price")),
    supplier: str(formData.get("supplier")),
    notes: str(formData.get("notes")),
  };
}

export const createPart = safe(async function createPart(formData: FormData) {
  const user = await requireUser();
  const data = partData(formData);
  // The same number in another case is the same part (the scanner treats them as one).
  const exists = await db.part.findFirst({ where: { shopId: user.shopId, partNumber: { equals: data.partNumber, mode: "insensitive" } } });
  const qty = qtyValue(formData.get("qtyOnHand"), data.unit);
  if (exists && qty) throw new UserError(`${exists.partNumber} is already in inventory. Open it and use Receive stock to add ${qty}.`);
  if (exists) redirect(`/parts/${exists.id}`);
  const p = await db.part.create({
    data: {
      ...data,
      shopId: user.shopId,
      qtyOnHand: qty,
      moves: qty ? { create: { shopId: user.shopId, qty, reason: "RECEIVED", userId: user.id, note: "Opening stock" } } : undefined,
    },
  });
  revalidatePath("/parts");
  redirect(`/parts/${p.id}`);
});

export const updatePart = safe(async function updatePart(partId: string, formData: FormData) {
  const user = await requireUser();
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId } });
  if (!p) throw new UserError("Part not found.");
  const data = partData(formData);
  const clash = await db.part.findFirst({ where: { shopId: user.shopId, id: { not: partId }, partNumber: { equals: data.partNumber, mode: "insensitive" } } });
  if (clash) throw new UserError(`${clash.partNumber} is already another item in inventory.`);
  await db.part.update({ where: { id: partId }, data });
  revalidatePath(`/parts/${partId}`);
  revalidatePath("/parts");
});

/** Receive stock (+) or correct the count (set to what's on the shelf). */
export const moveStock = safe(async function moveStock(partId: string, formData: FormData) {
  const user = await requireUser();
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId } });
  if (!p) throw new UserError("Part not found.");
  const mode = str(formData.get("mode"));
  const typed = str(formData.get("qty"));
  if (typed == null) throw new UserError("Enter a quantity.");
  // Fabric is counted in yards (to the eighth); everything else in whole pieces, and a shelf count is never below zero.
  const n = qtyValue(typed, p.unit);
  const note = str(formData.get("note"));
  if (mode === "count") {
    const delta = n - p.qtyOnHand;
    if (delta === 0) return;
    await db.$transaction([
      db.part.update({ where: { id: partId }, data: { qtyOnHand: n } }),
      db.stockMove.create({ data: { shopId: user.shopId, partId, qty: delta, reason: "ADJUSTED", userId: user.id, note: note ?? "Shelf count" } }),
    ]);
  } else {
    if (n <= 0) throw new UserError("Enter how many arrived.");
    const cost = toCents(formData.get("cost"));
    await db.$transaction([
      db.part.update({ where: { id: partId }, data: { qtyOnHand: { increment: n }, ...(cost != null ? { costCents: cost } : {}) } }),
      db.stockMove.create({ data: { shopId: user.shopId, partId, qty: n, reason: "RECEIVED", userId: user.id, note } }),
    ]);
  }
  revalidatePath(`/parts/${partId}`);
  revalidatePath("/parts");
  revalidatePath("/");
});

// ---------- where to buy (this shop's own suppliers for a part) ----------

async function ownPart(partId: string) {
  const user = await requireUser();
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId }, select: { id: true } });
  if (!p) throw new UserError("Part not found.");
  return p;
}

export const addPartSource = safe(async function addPartSource(partId: string, formData: FormData) {
  await ownPart(partId);
  const vendor = str(formData.get("vendor"));
  const url = str(formData.get("url"));
  if (!vendor) throw new UserError("Enter where you buy it.");
  if (url && !/^https?:\/\//i.test(url)) throw new UserError("The link must start with http:// or https://");
  const preferred = formData.get("preferred") === "on";
  await db.$transaction([
    ...(preferred ? [db.partSource.updateMany({ where: { partId }, data: { preferred: false } })] : []),
    db.partSource.create({ data: { partId, vendor, url, priceCents: toCents(formData.get("price")), note: str(formData.get("note")), preferred } }),
  ]);
  revalidatePath(`/parts/${partId}`);
});

export const removePartSource = safe(async function removePartSource(partId: string, sourceId: string) {
  await ownPart(partId);
  await db.partSource.deleteMany({ where: { id: sourceId, partId } });
  revalidatePath(`/parts/${partId}`);
});

export const preferPartSource = safe(async function preferPartSource(partId: string, sourceId: string) {
  await ownPart(partId);
  await db.$transaction([
    db.partSource.updateMany({ where: { partId }, data: { preferred: false } }),
    db.partSource.updateMany({ where: { id: sourceId, partId }, data: { preferred: true } }),
  ]);
  revalidatePath(`/parts/${partId}`);
});
