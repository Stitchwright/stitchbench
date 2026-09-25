"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requirePlatformAdmin } from "@/lib/session";
import { createShopWithOwner, type ShopKind } from "@/lib/shops";

/** The StitchBench admin sets up another shop and its owner login (sign-up stays closed). */
export const createCompany = safe(async function createCompany(formData: FormData) {
  await requirePlatformAdmin();
  await createShopWithOwner({
    shopName: String(formData.get("shop") ?? ""),
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    kind: (String(formData.get("kind") ?? "repair") as ShopKind) || "repair",
  });
  revalidatePath("/companies");
});
