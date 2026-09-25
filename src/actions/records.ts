"use server";

// Machines, customers, model notes (gotchas), photos.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { modelKey, str } from "@/lib/format";
import { PHOTO_KINDS } from "@/lib/constants";
import type { CustomerKind, NoteKind, PhotoKind } from "@/generated/prisma/enums";

// ---------- machines ----------

export const createMachine = safe(async function createMachine(formData: FormData) {
  const user = await requireUser();
  const brand = str(formData.get("brand"));
  const model = str(formData.get("model"));
  if (!brand || !model) throw new UserError("Enter the brand and model.");
  const customerId = str(formData.get("customerId"));
  if (customerId && !(await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId } }))) {
    throw new UserError("Customer not found.");
  }
  const m = await db.machine.create({
    data: {
      shopId: user.shopId,
      brand,
      model,
      modelKey: modelKey(model),
      serial: str(formData.get("serial")),
      machineType: str(formData.get("machineType")),
      customerId,
      notes: str(formData.get("notes")),
    },
  });
  revalidatePath("/machines");
  redirect(`/machines/${m.id}`);
});

export const updateMachine = safe(async function updateMachine(machineId: string, formData: FormData) {
  const user = await requireUser();
  const m = await db.machine.findFirst({ where: { id: machineId, shopId: user.shopId } });
  if (!m) throw new UserError("Machine not found.");
  const brand = str(formData.get("brand")) ?? m.brand;
  const model = str(formData.get("model")) ?? m.model;
  const customerId = str(formData.get("customerId"));
  if (customerId && !(await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId } }))) {
    throw new UserError("Customer not found.");
  }
  await db.machine.update({
    where: { id: machineId },
    data: {
      brand,
      model,
      modelKey: modelKey(model),
      serial: str(formData.get("serial")),
      machineType: str(formData.get("machineType")),
      customerId,
      notes: str(formData.get("notes")),
    },
  });
  revalidatePath(`/machines/${machineId}`);
});

export const deletePhoto = safe(async function deletePhoto(photoId: string) {
  const user = await requireUser();
  const p = await db.machinePhoto.findFirst({ where: { id: photoId, shopId: user.shopId }, select: { id: true, machineId: true, ticketId: true } });
  if (!p) throw new UserError("Photo not found.");
  await db.machinePhoto.delete({ where: { id: photoId } });
  revalidatePath(`/machines/${p.machineId}`);
  if (p.ticketId) revalidatePath(`/tickets/${p.ticketId}`);
});

export const updatePhoto = safe(async function updatePhoto(photoId: string, formData: FormData) {
  const user = await requireUser();
  const p = await db.machinePhoto.findFirst({ where: { id: photoId, shopId: user.shopId }, select: { id: true, machineId: true, ticketId: true } });
  if (!p) throw new UserError("Photo not found.");
  const kind = str(formData.get("kind")) as PhotoKind | null;
  if (kind && !PHOTO_KINDS.includes(kind)) throw new UserError("Pick what the photo shows.");
  await db.machinePhoto.update({
    where: { id: photoId },
    data: { caption: str(formData.get("caption"))?.slice(0, 300) ?? null, ...(kind ? { kind } : {}) },
  });
  revalidatePath(`/machines/${p.machineId}`);
  if (p.ticketId) revalidatePath(`/tickets/${p.ticketId}`);
  revalidatePath("/models", "layout");
});

// ---------- customers ----------

export const saveCustomer = safe(async function saveCustomer(customerId: string | null, formData: FormData) {
  const user = await requireUser();
  const name = str(formData.get("name"));
  if (!name) throw new UserError("Enter a name.");
  const kind = (str(formData.get("kind")) ?? "RETAIL") as CustomerKind;
  const commission = str(formData.get("commissionPct"));
  const data = {
    name,
    kind,
    phone: str(formData.get("phone")),
    email: str(formData.get("email")),
    address: str(formData.get("address")),
    code: kind === "TRADE" ? str(formData.get("code")) : null,
    commissionPct: kind === "TRADE" && commission != null ? Number(commission) : null,
    routeDay: kind === "TRADE" ? str(formData.get("routeDay")) : null,
    notes: str(formData.get("notes")),
  };
  if (customerId) {
    const c = await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId } });
    if (!c) throw new UserError("Customer not found.");
    await db.customer.update({ where: { id: customerId }, data });
    revalidatePath(`/customers/${customerId}`);
    revalidatePath("/customers");
    return;
  }
  const c = await db.customer.create({ data: { ...data, shopId: user.shopId } });
  revalidatePath("/customers");
  redirect(`/customers/${c.id}`);
});

// ---------- model notes: important facts and gotchas ----------

export const addNote = safe(async function addNote(formData: FormData) {
  const user = await requireUser();
  const brand = str(formData.get("brand"));
  const model = str(formData.get("model"));
  const body = str(formData.get("body"));
  if (!brand || !model || !body) throw new UserError("Write the note first.");
  await db.modelNote.create({
    data: {
      shopId: user.shopId,
      brand,
      modelKey: modelKey(model),
      modelLabel: model,
      kind: (str(formData.get("kind")) ?? "GOTCHA") as NoteKind,
      body,
      authorId: user.id,
    },
  });
  revalidatePath("/", "layout");
});

export const toggleNotePin = safe(async function toggleNotePin(noteId: string) {
  const user = await requireUser();
  const n = await db.modelNote.findFirst({ where: { id: noteId, shopId: user.shopId } });
  if (!n) throw new UserError("Note not found.");
  await db.modelNote.update({ where: { id: noteId }, data: { pinned: !n.pinned } });
  revalidatePath("/", "layout");
});

export const deleteNote = safe(async function deleteNote(noteId: string) {
  const user = await requireUser();
  const n = await db.modelNote.findFirst({ where: { id: noteId, shopId: user.shopId } });
  if (!n) throw new UserError("Note not found.");
  if (user.role === "TECH" && n.authorId !== user.id) throw new UserError("Only the author or an admin can delete this note.");
  await db.modelNote.delete({ where: { id: noteId } });
  revalidatePath("/", "layout");
});
