"use server";

// The Fabric page's Kits (fabric-smarts-design.md section 4, package F4): the kit builder, making and unmaking kits, and
// Block of the Month series with their rosters. Bodies in src/lib/kits.ts. Each is refused while the program key has lapsed
// (safe() with no exception: they are new stock work).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe, UserError } from "@/lib/action";
import { db } from "@/lib/db";
import { str } from "@/lib/format";
import { requireAdmin, requireUser } from "@/lib/session";
import { KIT_FIELDS, KIT_SELECT, type KitSettings } from "@/lib/kits-math";
import { addMemberFor, createSeriesFor, deleteKitFor, deleteSeriesFor, linkKitFor, makeKitsFor, removeMemberFor, saveKitFor, setHandoutFor, unmakeKitFor } from "@/lib/kits";

const refresh = (kitId?: string, seriesId?: string) => {
  revalidatePath("/fabric");
  revalidatePath("/parts");
  if (kitId) revalidatePath(`/fabric/kits/${kitId}`);
  if (seriesId) revalidatePath(`/fabric/kits/series/${seriesId}`);
};

export const saveKit = safe(async function saveKit(kitId: string | null, formData: FormData) {
  const user = await requireUser();
  const saved = await saveKitFor(user, kitId, formData);
  refresh(saved.id);
  if (!kitId) redirect(`/fabric/kits/${saved.id}`);
  return noted(saved.text);
});

export const makeKits = safe(async function makeKits(kitId: string, formData: FormData) {
  const user = await requireUser();
  const raw = str(formData.get("count")) ?? "";
  const text = await makeKitsFor(user, kitId, /^\d+$/.test(raw) ? Number(raw) : NaN);
  refresh(kitId);
  return noted(text);
});

export const unmakeKit = safe(async function unmakeKit(kitId: string) {
  const user = await requireUser();
  const text = await unmakeKitFor(user, kitId);
  refresh(kitId);
  return noted(text);
});

export const deleteKit = safe(async function deleteKit(kitId: string) {
  const user = await requireUser();
  await deleteKitFor(user, kitId);
  refresh();
  redirect("/fabric?tab=kits");
});

export const createSeries = safe(async function createSeries(formData: FormData) {
  const user = await requireUser();
  const id = await createSeriesFor(user, formData);
  refresh();
  redirect(`/fabric/kits/series/${id}`);
});

export const linkKit = safe(async function linkKit(seriesId: string, month: number, formData: FormData) {
  const user = await requireUser();
  const text = await linkKitFor(user, seriesId, month, str(formData.get(`kit.${month}`)));
  refresh(undefined, seriesId);
  return noted(text);
});

export const setHandout = safe(async function setHandout(seriesId: string, kitId: string, done: boolean) {
  const user = await requireUser();
  const text = await setHandoutFor(user, kitId, done);
  refresh(kitId, seriesId);
  return noted(text);
});

export const addMember = safe(async function addMember(seriesId: string, formData: FormData) {
  const user = await requireUser();
  const text = await addMemberFor(user, seriesId, str(formData.get("customerId")) ?? "", str(formData.get("note")));
  refresh(undefined, seriesId);
  return noted(text);
});

export const removeMember = safe(async function removeMember(seriesId: string, memberId: string) {
  const user = await requireUser();
  const text = await removeMemberFor(user, memberId);
  refresh(undefined, seriesId);
  return noted(text);
});

export const deleteSeries = safe(async function deleteSeries(seriesId: string) {
  const user = await requireUser();
  await deleteSeriesFor(user, seriesId);
  refresh();
  redirect("/fabric?tab=kits");
});

/** Settings -> Fabric: the kit margin target and bundle discount. A blank box keeps what is saved. */
export const saveKitSettings = safe(async function saveKitSettings(formData: FormData) {
  const user = await requireAdmin();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: KIT_SELECT });
  const next = { ...shop } as KitSettings;
  for (const f of KIT_FIELDS) {
    const label = f.label.replace(/ \(.*$/, "");
    const raw = str(String(formData.get(f.key) ?? "").replace(/[%,]/g, ""));
    if (raw == null) continue;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < f.min || v > f.max) throw new UserError(`${label}: enter a whole number from ${f.min} to ${f.max}.`);
    next[f.key] = v;
  }
  await db.shop.update({ where: { id: user.shopId }, data: next });
  revalidatePath("/fabric");
  revalidatePath("/settings");
});
