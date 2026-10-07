"use server";

// The card reader at the counter (shop-features-round-2-design.md 4.8, package card-reader). Bodies in src/lib/card-reader.ts.
// The register's calls return data (hand-rolled, in src/lib/lapse-allow.ts); Settings' are wrapped with safe().
import { revalidatePath } from "next/cache";
import { isUserError, noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { cancelReaderPaymentFor, pairReaderFor, readerPaymentStatusFor, refundLoosePaymentFor, removeReaderFor, saveReaderSettingsFor, simulateTapFor, startReaderPaymentFor } from "@/lib/card-reader";

const refresh = () => revalidatePath("/settings/card-reader");
const words = (e: unknown) => (isUserError(e) ? (e as Error).message : "The card reader didn't answer. Check the connection, then try again.");

export const saveReaderSettings = safe(async function saveReaderSettings(formData: FormData) {
  const user = await requireUser();
  const text = await saveReaderSettingsFor(user, formData);
  refresh();
  revalidatePath("/register");
  return noted(text);
});

export const pairReader = safe(async function pairReader(formData: FormData) {
  const user = await requireUser();
  const text = await pairReaderFor(user, formData);
  refresh();
  return noted(text);
});

export const removeReader = safe(async function removeReader(id: string) {
  const user = await requireUser();
  const text = await removeReaderFor(user, id);
  refresh();
  return noted(text);
});

export const refundLoosePayment = safe(async function refundLoosePayment(id: string) {
  const user = await requireUser();
  const text = await refundLoosePaymentFor(user, id);
  refresh();
  return noted(text);
});

/** The register: send the amount to the reader. */
export async function startReaderPayment(readerId: string, amountCents: number, clientKey: string) {
  try {
    return await startReaderPaymentFor(await requireUser(), readerId, amountCents, clientKey);
  } catch (e) {
    return { error: words(e) };
  }
}

/** The register: how the payment on the reader stands. */
export async function readerPaymentStatus(paymentId: string) {
  try {
    return await readerPaymentStatusFor(await requireUser(), paymentId);
  } catch (e) {
    return { error: words(e) };
  }
}

export async function cancelReaderPayment(paymentId: string) {
  try {
    return { note: await cancelReaderPaymentFor(await requireUser(), paymentId) };
  } catch (e) {
    return { error: words(e) };
  }
}

export async function simulateReaderTap(paymentId: string, decline: boolean) {
  try {
    return { note: await simulateTapFor(await requireUser(), paymentId, decline) };
  } catch (e) {
    return { error: words(e) };
  }
}
