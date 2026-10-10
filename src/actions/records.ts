"use server";

// Machines, customers, model notes (gotchas), photos.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, undoable, UserError } from "@/lib/action";
import { stashUndo, takeUndo } from "@/lib/undo";
import { requireAdmin, requireUser, type CurrentUser } from "@/lib/session";
import { modelKey, str } from "@/lib/format";
import { assertId } from "@/lib/input";
import { PHOTO_KINDS } from "@/lib/constants";
import { requireModule } from "@/lib/modules";
import { recordConsent } from "@/lib/messaging/consent";
import { actorOf, audit } from "@/lib/audit";
import { parseExemptUntil } from "@/lib/tax-exempt";
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
  // The whole row, picture included (it is stored in the database, not as a file): kept in memory for the Undo bar.
  const p = await db.machinePhoto.findFirst({ where: { id: photoId, shopId: user.shopId } });
  if (!p) throw new UserError("Photo not found.");
  await requirePhotoWork(user, p);
  const mach = await db.machine.findFirst({ where: { id: p.machineId, shopId: user.shopId }, select: { brand: true, model: true } });
  await db.$transaction(async (tx) => {
    await tx.machinePhoto.delete({ where: { id: photoId } });
    await audit(tx, actorOf(user), { action: "photo.delete", subjectType: "Machine", subjectId: p.machineId, subjectLabel: `Photo of ${mach ? `${mach.brand} ${mach.model}` : "a machine"}` });
  });
  revalidatePath(`/machines/${p.machineId}`);
  if (p.ticketId) revalidatePath(`/tickets/${p.ticketId}`);
  return undoable("Photo deleted.", stashUndo(user, "photo", p));
});

/** Undo for deletePhoto: the same photo, same id, back on the machine (and its ticket, if that is still there). */
export const restorePhoto = safe(async function restorePhoto(token: string) {
  const user = await requireUser();
  const p = takeUndo<{ id: string; shopId: string; machineId: string; ticketId: string | null; caption: string | null; kind: PhotoKind; mime: string; data: Uint8Array; createdAt: Date }>(user, "photo", token);
  // The same rules as deleting it: the shop's own machine, still there, and its module allowing work.
  if (p.shopId !== user.shopId || !(await db.machine.findFirst({ where: { id: p.machineId, shopId: user.shopId }, select: { id: true } }))) throw new UserError("Machine not found.");
  const ticketId = p.ticketId && (await db.ticket.findFirst({ where: { id: p.ticketId, shopId: user.shopId }, select: { id: true } })) ? p.ticketId : null;
  await requirePhotoWork(user, { machineId: p.machineId, ticketId });
  if (await db.machinePhoto.findUnique({ where: { id: p.id }, select: { id: true } })) throw new UserError("That photo is already back.");
  const mach = await db.machine.findFirst({ where: { id: p.machineId, shopId: user.shopId }, select: { brand: true, model: true } });
  await db.$transaction(async (tx) => {
    await tx.machinePhoto.create({ data: { id: p.id, shopId: user.shopId, machineId: p.machineId, ticketId, caption: p.caption, kind: p.kind, mime: p.mime, data: p.data as Uint8Array<ArrayBuffer>, createdAt: p.createdAt } });
    await audit(tx, actorOf(user), { action: "photo.restore", subjectType: "Machine", subjectId: p.machineId, subjectLabel: `Photo of ${mach ? `${mach.brand} ${mach.model}` : "a machine"}` });
  });
  revalidatePath(`/machines/${p.machineId}`);
  if (ticketId) revalidatePath(`/tickets/${ticketId}`);
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
  // Tax exempt: a certificate number (and the last day it is good, if it has one). Only the form that carries the field writes it.
  if (formData.has("taxExemptId") && user.role === "TECH") throw new UserError("Only an owner or admin can mark a customer tax exempt.");
  const exempt = formData.has("taxExemptId")
    ? (() => {
        const until = parseExemptUntil(str(formData.get("taxExemptUntil")));
        if ("error" in until) throw new UserError(until.error);
        const id = str(formData.get("taxExemptId"))?.slice(0, 60) ?? null;
        return { taxExemptId: id, taxExemptUntil: id ? until.date : null };
      })()
    : null;
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
      await tx.customer.update({ where: { id: customerId }, data: { ...data, ...(exempt ?? {}), ...(changed ? { notifyBy: notifyBy! } : {}) } });
      if (exempt && (exempt.taxExemptId !== (c.taxExemptId ?? null) || (exempt.taxExemptUntil?.getTime() ?? null) !== (c.taxExemptUntil?.getTime() ?? null))) {
        await audit(tx, actorOf(user), {
          action: "customer.taxexempt",
          subjectType: "Customer",
          subjectId: c.id,
          subjectLabel: c.name,
          changes: { taxExemptId: [c.taxExemptId, exempt.taxExemptId], taxExemptUntil: [c.taxExemptUntil?.toISOString().slice(0, 10) ?? null, exempt.taxExemptUntil?.toISOString().slice(0, 10) ?? null] },
        });
      }
      if (changed) await recordConsent(tx, pref(customerId, notifyBy!));
    });
    revalidatePath(`/customers/${customerId}`);
    revalidatePath("/customers");
    return;
  }
  const c = await db.$transaction(async (tx) => {
    const made = await tx.customer.create({ data: { ...data, ...(exempt ?? {}), shopId: user.shopId, notifyBy: notifyBy ?? "" } });
    if (exempt?.taxExemptId) {
      await audit(tx, actorOf(user), { action: "customer.taxexempt", subjectType: "Customer", subjectId: made.id, subjectLabel: made.name, changes: { taxExemptId: [null, exempt.taxExemptId] } });
    }
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
  await db.$transaction(async (tx) => {
    await tx.modelNote.delete({ where: { id: noteId } });
    await audit(tx, actorOf(user), { action: "note.delete", subjectType: "ModelNote", subjectId: noteId, subjectLabel: `Note on ${n.modelLabel}: ${n.body.slice(0, 60)}` });
  });
  revalidatePath("/", "layout");
  return undoable("Note deleted.", stashUndo(user, "note", n));
});

/** Undo for deleteNote: the note back with its own id, pin, author and date. */
export const restoreNote = safe(async function restoreNote(token: string) {
  const user = await requireUser();
  const n = takeUndo<{ id: string; shopId: string; brand: string; modelKey: string; modelLabel: string; kind: NoteKind; body: string; pinned: boolean; authorId: string | null; createdAt: Date }>(user, "note", token);
  if (n.shopId !== user.shopId) throw new UserError("Note not found.");
  if (user.role === "TECH" && n.authorId !== user.id) throw new UserError("Only the author or an admin can put this note back.");
  if (await db.modelNote.findUnique({ where: { id: n.id }, select: { id: true } })) throw new UserError("That note is already back.");
  // A user removed meanwhile leaves the note without an author, as it would have.
  const author = n.authorId ? await db.user.findFirst({ where: { id: n.authorId, shopId: user.shopId }, select: { id: true } }) : null;
  await db.$transaction(async (tx) => {
    await tx.modelNote.create({ data: { id: n.id, shopId: user.shopId, brand: n.brand, modelKey: n.modelKey, modelLabel: n.modelLabel, kind: n.kind, body: n.body, pinned: n.pinned, authorId: author?.id ?? null, createdAt: n.createdAt } });
    await audit(tx, actorOf(user), { action: "note.restore", subjectType: "ModelNote", subjectId: n.id, subjectLabel: `Note on ${n.modelLabel}: ${n.body.slice(0, 60)}` });
  });
  revalidatePath("/", "layout");
});
