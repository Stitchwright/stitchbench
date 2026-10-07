"use server";

// Rentals, rent-to-own and trial purchases (shop-features-round-2-design.md 1.8): rent a machine out, take rent, buy it
// (they return what the receipt link needs, or an error), send the rent as a pay link, the trial days setting. Bodies in
// src/lib/rentals.ts.
import { revalidatePath } from "next/cache";
import { isUserError, noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import type { Tender } from "@/lib/register-math";
import { buyRentalAs, payRentAs, rentOutFor, saveTrialDaysFor, sendRentLinkAs, type RentInput } from "@/lib/rentals";

type Done = { saleId: string; number: number } | { error: string };

function refresh() {
  revalidatePath("/units", "layout");
  revalidatePath("/customers", "layout");
  revalidatePath("/");
}

async function attempt(fn: () => Promise<Done>): Promise<Done> {
  try {
    const r = await fn();
    refresh();
    return r;
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

export async function rentOut(input: RentInput): Promise<Done> {
  return attempt(async () => {
    const r = await rentOutFor(await requireUser(), input);
    return { saleId: r.saleId, number: r.saleNumber };
  });
}

export async function payRent(loanId: string, periods: number, tender: Tender, clientKey: string | null): Promise<Done> {
  return attempt(async () => payRentAs(await requireUser(), { loanId, periods, tender, clientKey }));
}

export async function buyRental(loanId: string, tender: Tender, clientKey: string | null): Promise<Done> {
  return attempt(async () => {
    const r = await buyRentalAs(await requireUser(), { loanId, tender, clientKey });
    return { saleId: r.saleId, number: r.number };
  });
}

export const sendRentLink = safe(async function sendRentLink(loanId: string) {
  const words = await sendRentLinkAs(await requireUser(), loanId);
  refresh();
  return noted(words);
});

export const saveTrialDays = safe(async function saveTrialDays(formData: FormData) {
  await saveTrialDaysFor(await requireUser(), formData);
  revalidatePath("/units/loans");
});
