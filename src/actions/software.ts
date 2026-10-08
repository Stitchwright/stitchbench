"use server";

// Software licences and activation codes (shop-features-round-2-design.md 2.5, package software-codes). Bodies in
// src/lib/software.ts. softwareChoices only reads (lapse-allow.ts HAND_ALLOWED); the rest are edits, refused while the
// program is read-only (safe() with no exception).
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { str } from "@/lib/format";
import { codesOnHand, endLicenseFor, fillCodeFor, loadCodesFor, renewableFor, saveSoftwareItemFor, setActivatedFor } from "@/lib/software";

const refresh = (partId?: string) => {
  revalidatePath("/parts/software");
  if (partId) revalidatePath(`/parts/${partId}`);
  revalidatePath("/customers", "layout");
};

export const saveSoftwareItem = safe(async function saveSoftwareItem(partId: string, formData: FormData) {
  const user = await requireUser();
  const text = await saveSoftwareItemFor(user, partId, formData);
  refresh(partId);
  return noted(text);
});

export const loadCodes = safe(async function loadCodes(partId: string, formData: FormData) {
  const user = await requireUser();
  const text = await loadCodesFor(user, partId, String(formData.get("codes") ?? ""));
  refresh(partId);
  return noted(text);
});

export const fillCode = safe(async function fillCode(id: string, formData: FormData) {
  const user = await requireUser();
  const text = await fillCodeFor(user, id, str(formData.get("code")) ?? "");
  refresh();
  return noted(text);
});

export const setActivated = safe(async function setActivated(id: string, on: boolean) {
  const user = await requireUser();
  const text = await setActivatedFor(user, id, on);
  refresh();
  return noted(text);
});

export const endLicense = safe(async function endLicense(id: string) {
  const user = await requireUser();
  const text = await endLicenseFor(user, id);
  refresh();
  return noted(text);
});

/** Settings → Selling: a licence sold counts as activated on the sale date (on), or when the shop marks it (off). */
export const saveSoftwareSettings = safe(async function saveSoftwareSettings(formData: FormData) {
  const user = await requireAdmin();
  await db.shop.update({ where: { id: user.shopId }, data: { softwareActivatedAtSale: formData.get("activatedAtSale") === "on" } });
  revalidatePath("/settings/sales");
  return noted("Saved.");
});

/** The register's software line: the customer's machines, her subscriptions of this item she can renew, and the codes on hand. */
export async function softwareChoices(partId: string, customerId: string | null): Promise<{ onHand: number; machines: { id: string; label: string }[]; renewable: { id: string; label: string }[] }> {
  const user = await requireUser();
  const part = await db.part.findFirst({ where: { id: String(partId), shopId: user.shopId, kind: "SOFTWARE" }, select: { id: true } });
  if (!part) return { onHand: 0, machines: [], renewable: [] };
  const cid = customerId && /^[a-z0-9]{10,40}$/i.test(customerId) ? customerId : null;
  const [onHand, machines, renewable] = await Promise.all([
    codesOnHand(user.shopId, part.id),
    cid ? db.machine.findMany({ where: { shopId: user.shopId, customerId: cid }, select: { id: true, brand: true, model: true }, orderBy: { createdAt: "desc" }, take: 20 }) : Promise.resolve([]),
    cid ? renewableFor(user.shopId, cid, part.id) : Promise.resolve([]),
  ]);
  return { onHand, machines: machines.map((m) => ({ id: m.id, label: `${m.brand} ${m.model}` })), renewable };
}
