"use server";

// Raise prices, the margin floor and back orders (shop-features-round-2-design.md 4.4). Bodies in src/lib/repricing.ts
// and src/lib/backorders.ts.
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { str } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { pctInput } from "@/lib/repricing-math";
import { applyRaiseFor, ruleFrom, saveFloorsFor, undoRaiseFor } from "@/lib/repricing";
import { clearBackorderFor, letThemKnowFor, markBackorderFor } from "@/lib/backorders";

export const raisePrices = safe(async function raisePrices(formData: FormData) {
  const user = await requireUser();
  const [whose, ...rest] = (str(formData.get("who")) ?? "").split("|");
  const rule = ruleFrom({ whose, value: rest.join("|"), pct: pctInput(str(formData.get("pct"))), round: str(formData.get("round")) });
  const r = await applyRaiseFor(user, rule);
  revalidatePath("/parts/raise-prices");
  revalidatePath("/parts");
  return noted(`Done: ${r.count} price${r.count === 1 ? "" : "s"} raised. Undo is below for a day.`);
});

export const undoRaise = safe(async function undoRaise(id: string) {
  const user = await requireUser();
  const r = await undoRaiseFor(user, id);
  revalidatePath("/parts/raise-prices");
  revalidatePath("/parts");
  return noted(`Undone: ${r.back} price${r.back === 1 ? "" : "s"} put back.${r.left ? ` ${r.left} had been changed since and ${r.left === 1 ? "was" : "were"} left as ${r.left === 1 ? "it is" : "they are"}.` : ""}`);
});

export const saveMarginFloors = safe(async function saveMarginFloors(formData: FormData) {
  const user = await requireUser();
  await saveFloorsFor(user, formData);
  revalidatePath("/settings/sales");
  revalidatePath("/parts/raise-prices");
});

export const markBackorder = safe(async function markBackorder(lineId: string, orderId: string, formData: FormData) {
  const user = await requireUser();
  await markBackorderFor(user, lineId, str(formData.get("expectedOn")));
  revalidatePath(`/parts/orders/${orderId}`);
  revalidatePath("/parts/coming-in");
});

export const clearBackorder = safe(async function clearBackorder(lineId: string, orderId: string) {
  const user = await requireUser();
  await clearBackorderFor(user, lineId);
  revalidatePath(`/parts/orders/${orderId}`);
  revalidatePath("/parts/coming-in");
});

export const letThemKnow = safe(async function letThemKnow(lineId: string) {
  const user = await requireUser();
  const told = await letThemKnowFor(user, lineId);
  revalidatePath("/parts/coming-in");
  return noted(told);
});
