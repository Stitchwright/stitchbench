"use server";

// Minimum advertised prices (shop-features-round-2-design.md 9.3, package map-prices). Body in src/lib/map-prices.ts.
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { setMapFor } from "@/lib/map-prices";

export const saveMapPrice = safe(async function saveMapPrice(what: "part" | "unit", id: string, formData: FormData) {
  const user = await requireUser();
  const text = await setMapFor(user, what === "unit" ? "unit" : "part", id, formData);
  revalidatePath(what === "unit" ? `/units/${id}` : `/parts/${id}`);
  return noted(text);
});
