"use server";

// Birthdays and per-yard breaks (shop-features-round-2-design.md 1.6): a customer's birthday, the shop's birthday offer
// and the register's "give her the birthday credit", the yard breaks and an item's own break. Bodies in src/lib/birthdays.ts.
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";
import { addYardBreakFor, giveBirthdayCreditAs, removeYardBreakFor, saveBirthdayFor, saveBirthdayOfferFor, saveItemBreakFor } from "@/lib/birthdays";

export const saveBirthday = safe(async function saveBirthday(customerId: string, formData: FormData) {
  await saveBirthdayFor(await requireUser(), customerId, formData);
  revalidatePath(`/customers/${customerId}`);
});

export const saveBirthdayOffer = safe(async function saveBirthdayOffer(formData: FormData) {
  await saveBirthdayOfferFor(await requireUser(), formData);
  revalidatePath("/settings/prices");
});

export const giveBirthdayCredit = safe(async function giveBirthdayCredit(customerId: string) {
  const user = await requireUser();
  const words = await giveBirthdayCreditAs(user, customerId, ymdOf(new Date(), await shopTimeZone(user.shopId)));
  revalidatePath(`/customers/${customerId}`);
  return noted(words);
});

export const addYardBreak = safe(async function addYardBreak(formData: FormData) {
  await addYardBreakFor(await requireUser(), formData);
  revalidatePath("/settings/prices");
});

export const removeYardBreak = safe(async function removeYardBreak(id: string) {
  await removeYardBreakFor(await requireUser(), id);
  revalidatePath("/settings/prices");
});

export const saveItemBreak = safe(async function saveItemBreak(partId: string, formData: FormData) {
  await saveItemBreakFor(await requireUser(), partId, formData);
  revalidatePath(`/parts/${partId}`);
});
