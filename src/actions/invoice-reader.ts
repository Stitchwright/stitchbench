"use server";

// "Receive from a photo" (shop-features-round-2-design.md 1.10): read the packing slip's pictures (the lines come back to
// the screen once, matched), then receive what was ticked. Bodies in src/lib/invoice-reader.ts.
import { revalidatePath } from "next/cache";
import { noted, safe, shownOnce } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { readSlipFor, receiveSlipFor, type ReceiveRow } from "@/lib/invoice-reader";

export const readSlip = safe(async function readSlip(orderId: string | null, photos: { data: string; mediaType: string }[]) {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await readSlipFor(user, { orderId, photos })));
});

export const receiveSlip = safe(async function receiveSlip(orderId: string | null, rows: ReceiveRow[], key?: string | null) {
  const words = await receiveSlipFor(await requireUser(), { orderId, rows, key: typeof key === "string" ? key : null });
  revalidatePath("/parts", "layout");
  if (orderId) revalidatePath(`/parts/orders/${orderId}`);
  return noted(words);
});
