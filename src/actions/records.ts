"use server";

// Machines, customers, model notes (gotchas), photos.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireAdmin, requireUser, type CurrentUser } from "@/lib/session";
import { modelKey, str } from "@/lib/format";
import { assertId } from "@/lib/input";
import { PHOTO_KINDS } from "@/lib/constants";
import { requireModule } from "@/lib/modules";
import { recordConsent } from "@/lib/messaging/consent";
import { isNotifyBy } from "@/components/notify-by-field";
import { EQUIPMENT_LABEL, isEquipment } from "@/lib/equipment";
import { withArticle } from "@/lib/equipment/types";
import { readAnswers } from "@/lib/equipment/form";
import { machineWorkable, requireEquipment, ticketWorkable } from "@/lib/equipment/gate";
import { kindOf, usableKind } from "@/lib/equipment/shop";
import { convertMachineKindFor } from "@/lib/equipment/convert";
import type { CustomerKind, NoteKind, PhotoKind } from "@/generated/prisma/enums";

// ---------- machines ----------

export const createMachine = safe(async function createMachine(formData: FormData) {
  const user = await requireUser();
  // What it is: the hidden or chosen `kind` (missing = a sewing machine); only a kind that may take new work.
  const kind = await usableKind(user.shopId, str(formData.get("kind")) ?? "sewing");
  if (!kind) throw new UserError("Pick what it is.");
  if (kind.module) await requireModule(user, kind.module);
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
      equipment: kind.equipment,
      kind: kind.key,
      details: readAnswers(kind.intakeFields, "machine", formData),
    },
  });
  revalidatePath("/machines");
  redirect(`/machines/${m.id}`);
});

export const updateMachine = safe(async function updateMachine(machineId: string, formData: FormData) {
  const user = await requireUser();
  const m = await db.machine.findFirst({ where: { id: machineId, shopId: user.shopId }, include: { stock: { select: { id: true } } } });
  if (!m) throw new UserError("Machine not found.");
  // Its module must allow work (or an open ticket of it must), else the module's own message.
  if (!(await machineWorkable(user.shopId, machineId))) {
    await requireEquipment(user, m.equipment);
    throw new UserError("This record is read-only.");
  }
  const current = await kindOf(user.shopId, m);
  // A kind change stays within the same equipment (a mixer filed as "Other appliance"); across equipments is convertMachineKind.
  let kind = current;
  const kindKey = str(formData.get("kind"));
  if (kindKey && kindKey !== m.kind) {
    const target = await usableKind(user.shopId, kindKey);
    if (!target || target.equipment !== m.equipment) {
      const what = isEquipment(m.equipment) ? EQUIPMENT_LABEL[m.equipment] : current.noun;
      throw new UserError(`Pick one of the ${what} kinds. To change what it is, use 'It isn't ${withArticle(current.noun)}'.`);
    }
    kind = target;
  }
  const brand = str(formData.get("brand")) ?? m.brand;
  const model = str(formData.get("model")) ?? m.model;
  const serial = str(formData.get("serial"));
  const customerId = str(formData.get("customerId"));
  if (customerId && !(await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId } }))) {
    throw new UserError("Customer not found.");
  }
  // A unit for sale: its identity and owner are managed from Vac Shop (the sale and warranty hang off them).
  if (m.stock && (brand !== m.brand || model !== m.model || serial !== m.serial || customerId !== m.customerId || kind.key !== m.kind)) {
    throw new UserError("This vacuum is in Vac Shop → For sale. Change it there.");
  }
  // The form shows the current kind's questions; answers under keys that kind doesn't ask are kept.
  const details = readAnswers(current.intakeFields, "machine", formData, (m.details ?? {}) as Record<string, unknown>);
  await db.machine.update({
    where: { id: machineId },
    data: {
      brand,
      model,
      modelKey: modelKey(model),
      serial,
      machineType: str(formData.get("machineType")),
      customerId,
      notes: str(formData.get("notes")),
      kind: kind.key,
      details,
    },
  });
  revalidatePath(`/machines/${machineId}`);
});

/** Admin: a vacuum logged as a sewing machine years ago becomes a vacuum (across equipments; section 9.5). */
export const convertMachineKind = safe(async (machineId: string, fd: FormData) => convertMachineKindFor(await requireAdmin(), assertId(machineId), fd));

/** The "work" check for a photo: with its ticket when it has one, else the machine's; throws the module's message. */
async function requirePhotoWork(user: CurrentUser, p: { machineId: string; ticketId: string | null }) {
  if (p.ticketId ? await ticketWorkable(user.shopId, p.ticketId) : await machineWorkable(user.shopId, p.machineId)) return;
  const m = await db.machine.findFirst({ where: { id: p.machineId, shopId: user.shopId }, select: { equipment: true } });
  if (!m) throw new UserError("Machine not found.");
  await requireEquipment(user, m.equipment, { closing: true });
  throw new UserError("This photo is read-only.");
}

export const deletePhoto = safe(async function deletePhoto(photoId: string) {
  const user = await requireUser();
  const p = await db.machinePhoto.findFirst({ where: { id: photoId, shopId: user.shopId }, select: { id: true, machineId: true, ticketId: true } });
  if (!p) throw new UserError("Photo not found.");
  await requirePhotoWork(user, p);
  await db.machinePhoto.delete({ where: { id: photoId } });
  revalidatePath(`/machines/${p.machineId}`);
  if (p.ticketId) revalidatePath(`/tickets/${p.ticketId}`);
});

export const updatePhoto = safe(async function updatePhoto(photoId: string, formData: FormData) {
  const user = await requireUser();
  const p = await db.machinePhoto.findFirst({ where: { id: photoId, shopId: user.shopId }, select: { id: true, machineId: true, ticketId: true } });
  if (!p) throw new UserError("Photo not found.");
  await requirePhotoWork(user, p);
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
  if (kind !== "RETAIL" && kind !== "TRADE") throw new UserError("Pick retail customer or quilt shop / dealer account.");
  // "10" or "10%": a share of the service price. Anything else would quietly pay no commission.
  const commission = str(String(formData.get("commissionPct") ?? "").replace("%", ""));
  const commissionPct = kind === "TRADE" && commission != null ? Number(commission) : null;
  if (commissionPct != null && !(Number.isFinite(commissionPct) && commissionPct >= 0 && commissionPct <= 100)) {
    throw new UserError("Commission is a percent from 0 to 100, e.g. 10.");
  }
  const data = {
    name,
    kind,
    phone: str(formData.get("phone")),
    email: str(formData.get("email")),
    address: str(formData.get("address")),
    code: kind === "TRADE" ? str(formData.get("code")) : null,
    commissionPct,
    routeDay: kind === "TRADE" ? str(formData.get("routeDay")) : null,
    notes: str(formData.get("notes")),
  };
  // "How should we tell them": written only when the form carried the field (the field is hidden while Marketing was
  // never on); a change is a consent record. No consent field (smsConsent*) is ever written here.
  let notifyBy: string | null = null;
  if (formData.has("notifyBy")) {
    const v = str(formData.get("notifyBy")) ?? "";
    if (!isNotifyBy(v)) throw new UserError("Pick how to tell them.");
    notifyBy = v;
  }
  const pref = (customerId: string, value: string) => ({ shopId: user.shopId, customerId, channel: "any", event: "notify_pref", source: "customer_page", detail: value, byUserId: user.id });
  if (customerId) {
    const c = await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId } });
    if (!c) throw new UserError("Customer not found.");
    const changed = notifyBy != null && notifyBy !== c.notifyBy;
    await db.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: customerId }, data: { ...data, ...(changed ? { notifyBy: notifyBy! } : {}) } });
      if (changed) await recordConsent(tx, pref(customerId, notifyBy!));
    });
    revalidatePath(`/customers/${customerId}`);
    revalidatePath("/customers");
    return;
  }
  const c = await db.$transaction(async (tx) => {
    const made = await tx.customer.create({ data: { ...data, shopId: user.shopId, notifyBy: notifyBy ?? "" } });
    if (notifyBy) await recordConsent(tx, pref(made.id, notifyBy));
    return made;
  });
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
