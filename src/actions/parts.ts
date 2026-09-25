"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str, toCents } from "@/lib/format";
import { partKeys, splitList } from "@/lib/parts";
import type { PartKind } from "@/generated/prisma/enums";

const KINDS: PartKind[] = ["PART", "ACCESSORY", "SUPPLY"];

function partData(formData: FormData) {
  const partNumber = str(formData.get("partNumber"));
  const description = str(formData.get("description"));
  if (!partNumber || !description) throw new UserError("Enter a part number and description.");
  const kind = (str(formData.get("kind")) ?? "PART") as PartKind;
  if (!KINDS.includes(kind)) throw new UserError("Pick part, accessory or supply.");
  const altNumbers = splitList(str(formData.get("altNumbers"))).filter((n) => n !== partNumber);
  return {
    partNumber,
    description,
    kind,
    altNumbers,
    numberKeys: partKeys(partNumber, altNumbers),
    brand: str(formData.get("brand")),
    fits: str(formData.get("fits")),
    location: str(formData.get("location")),
    reorderAt: Math.max(0, Math.round(Number(str(formData.get("reorderAt")) ?? "0"))),
    costCents: toCents(formData.get("cost")),
    priceCents: toCents(formData.get("price")),
    supplier: str(formData.get("supplier")),
    notes: str(formData.get("notes")),
  };
}

export const createPart = safe(async function createPart(formData: FormData) {
  const user = await requireUser();
  const data = partData(formData);
  const exists = await db.part.findFirst({ where: { shopId: user.shopId, partNumber: data.partNumber } });
  if (exists) redirect(`/parts/${exists.id}`);
  const qty = Math.max(0, Math.round(Number(str(formData.get("qtyOnHand")) ?? "0")));
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
  await db.part.update({ where: { id: partId }, data: partData(formData) });
  revalidatePath(`/parts/${partId}`);
  revalidatePath("/parts");
});

/** Receive stock (+) or correct the count (set to what's on the shelf). */
export const moveStock = safe(async function moveStock(partId: string, formData: FormData) {
  const user = await requireUser();
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId } });
  if (!p) throw new UserError("Part not found.");
  const mode = str(formData.get("mode"));
  const n = Math.round(Number(str(formData.get("qty")) ?? "NaN"));
  if (!Number.isFinite(n)) throw new UserError("Enter a quantity.");
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
