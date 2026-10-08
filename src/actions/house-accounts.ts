"use server";

// House charge accounts (shop-features-round-2-design.md 9.4, package house-accounts). Bodies in src/lib/house-accounts.ts.
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { emailStatementFor, saveAccountFor, setHouseAccountsOnFor, takeAccountPaymentFor, undoAccountEntryFor } from "@/lib/house-accounts";

const refresh = () => {
  revalidatePath("/paperwork/accounts", "layout");
  revalidatePath("/customers", "layout");
  revalidatePath("/register");
};

export const setHouseAccountsOn = safe(async function setHouseAccountsOn(on: boolean) {
  const user = await requireUser();
  const text = await setHouseAccountsOnFor(user, on);
  refresh();
  return noted(text);
});

export const saveHouseAccount = safe(async function saveHouseAccount(customerId: string, formData: FormData) {
  const user = await requireUser();
  const text = await saveAccountFor(user, customerId, formData);
  refresh();
  return noted(text);
});

export const takeAccountPayment = safe(async function takeAccountPayment(accountId: string, formData: FormData) {
  const user = await requireUser();
  const text = await takeAccountPaymentFor(user, accountId, formData);
  refresh();
  return noted(text);
});

export const undoAccountEntry = safe(async function undoAccountEntry(entryId: string) {
  const user = await requireUser();
  const text = await undoAccountEntryFor(user, entryId);
  refresh();
  return noted(text);
});

export const emailStatement = safe(async function emailStatement(accountId: string, month: string) {
  const user = await requireUser();
  const text = await emailStatementFor(user, accountId, month);
  return noted(text);
});
