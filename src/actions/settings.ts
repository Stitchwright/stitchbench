"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { str, toCents } from "@/lib/format";
import { isPlatformAdmin } from "@/lib/shops";
import type { Role } from "@/generated/prisma/enums";

/** An IANA time zone this server knows (America/New_York...), or null. */
function validTimeZone(tz: string | null) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new UserError(`"${tz}" isn't a time zone. Use a name like America/New_York or America/Chicago.`);
  }
}

export const saveShop = safe(async function saveShop(formData: FormData) {
  const user = await requireAdmin();
  const num = (k: string, d: number) => {
    const v = Number(str(formData.get(k)) ?? "");
    return Number.isFinite(v) ? v : d;
  };
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId } });
  await db.shop.update({
    where: { id: user.shopId },
    data: {
      name: str(formData.get("name")) ?? shop.name,
      phone: str(formData.get("phone")),
      email: str(formData.get("email")),
      address: str(formData.get("address")),
      laborRateCents: toCents(formData.get("laborRate")) ?? shop.laborRateCents,
      taxRatePct: num("taxRatePct", shop.taxRatePct),
      partsMarkupPct: num("partsMarkupPct", shop.partsMarkupPct),
      warrantyDays: Math.round(num("warrantyDays", shop.warrantyDays)),
      abandonedAfterDays: Math.round(num("abandonedAfterDays", shop.abandonedAfterDays)),
      storageFeeCents: toCents(formData.get("storageFee")) ?? shop.storageFeeCents,
      nextTicketNumber: Math.max(1, Math.round(num("nextTicketNumber", shop.nextTicketNumber))),
      libraryRoot: str(formData.get("libraryRoot")) ?? shop.libraryRoot,
      timeZone: validTimeZone(str(formData.get("timeZone"))) ?? shop.timeZone,
      payInstructions: str(formData.get("payInstructions")),
    },
  });
  revalidatePath("/", "layout");
});

export const saveChecklist = safe(async function saveChecklist(formData: FormData) {
  const user = await requireAdmin();
  const items = String(formData.get("items") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  await db.shop.update({ where: { id: user.shopId }, data: { checklistItems: items } });
  revalidatePath("/", "layout");
});

export const saveServiceItem = safe(async function saveServiceItem(itemId: string | null, formData: FormData) {
  const user = await requireAdmin();
  const name = str(formData.get("name"));
  const price = toCents(formData.get("price"));
  if (!name || price == null) throw new UserError("Enter a name and price.");
  const listing = { category: str(formData.get("category")), description: str(formData.get("description")) };
  if (itemId) {
    const it = await db.serviceItem.findFirst({ where: { id: itemId, shopId: user.shopId } });
    if (!it) throw new UserError("Service not found.");
    await db.serviceItem.update({ where: { id: itemId }, data: { name, priceCents: price, active: formData.get("active") === "on", ...listing } });
  } else {
    const count = await db.serviceItem.count({ where: { shopId: user.shopId } });
    await db.serviceItem.create({ data: { shopId: user.shopId, name, priceCents: price, sortOrder: count, ...listing } });
  }
  revalidatePath("/settings");
  revalidatePath("/price-list");
});

export const savePriceListNote = safe(async function savePriceListNote(formData: FormData) {
  const user = await requireAdmin();
  await db.shop.update({ where: { id: user.shopId }, data: { priceListNote: str(formData.get("priceListNote")) } });
  revalidatePath("/settings");
  revalidatePath("/price-list");
});

export const resetUserPassword = safe(async function resetUserPassword(userId: string, formData: FormData) {
  const admin = await requireAdmin();
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) throw new UserError("Use at least 8 characters.");
  const u = await db.user.findFirst({ where: { id: userId, shopId: admin.shopId } });
  if (!u) throw new UserError("User not found.");
  // Your own password is changed under "My password", which asks for the current one first: a signed-in PC left
  // unattended can't be used to take the account over. And nobody else gets to reset the owner's.
  if (u.id === admin.id) throw new UserError("Change your own password under My password.");
  if (u.role === "OWNER") throw new UserError("Only the owner can change the owner's password, under My password.");
  // Signed-in devices of that person have to sign in again with the new password.
  await db.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(password, 10), sessionVersion: { increment: 1 } } });
});

export const addUser = safe(async function addUser(formData: FormData) {
  const admin = await requireAdmin();
  const email = str(formData.get("email"))?.toLowerCase();
  const name = str(formData.get("name"));
  const password = str(formData.get("password"));
  if (!email || !name || !password || password.length < 8) throw new UserError("Enter a name, email and a temporary password of 8+ characters.");
  if (await db.user.findUnique({ where: { email } })) throw new UserError("That email already has an account.");
  // The StitchBench administrator's address carries install-wide rights: nobody else may take it for a login.
  if (isPlatformAdmin(email) && !isPlatformAdmin(admin.email)) throw new UserError("That email is reserved on this StitchBench.");
  const role = (str(formData.get("role")) ?? "TECH") as Role;
  if (role !== "ADMIN" && role !== "TECH") throw new UserError("Pick admin or tech.");
  await db.user.create({
    data: { shopId: admin.shopId, email, name, role, passwordHash: await bcrypt.hash(password, 10) },
  });
  revalidatePath("/settings");
});

export const setUserActive = safe(async function setUserActive(userId: string, active: boolean) {
  const admin = await requireAdmin();
  const u = await db.user.findFirst({ where: { id: userId, shopId: admin.shopId } });
  if (!u) throw new UserError("User not found.");
  if (u.role === "OWNER") throw new UserError("The owner account can't be switched off.");
  // Switching someone off also signs them out everywhere, at once.
  await db.user.update({ where: { id: userId }, data: { active, ...(active ? {} : { sessionVersion: { increment: 1 } }) } });
  revalidatePath("/settings");
});

export const changePassword = safe(async function changePassword(formData: FormData) {
  const user = await requireUser();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  if (next.length < 8) throw new UserError("Use at least 8 characters.");
  const u = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!(await bcrypt.compare(current, u.passwordHash))) throw new UserError("Current password is wrong.");
  // Every device signed in with the old password (this one too) signs in again.
  await db.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(next, 10), sessionVersion: { increment: 1 } } });
});
