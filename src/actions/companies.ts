"use server";

import { revalidatePath } from "next/cache";
import { safe, UserError } from "@/lib/action";
import { requirePlatformAdmin } from "@/lib/session";
import { createShopWithOwner, type ShopKind } from "@/lib/shops";
import { redeemPartnerCode } from "@/lib/partners";

/**
 * The StitchBench admin sets up another shop and its owner login (sign-up stays closed). With a partner code from the
 * shop's repair shop (made on the repair shop's own install), the new company is connected to it straight away:
 * how a repair shop hosting StitchShop for its partner sewing shops adds each one.
 */
export const createCompany = safe(async function createCompany(formData: FormData) {
  await requirePlatformAdmin();
  const email = String(formData.get("email") ?? "");
  const shop = await createShopWithOwner({
    shopName: String(formData.get("shop") ?? ""),
    name: String(formData.get("name") ?? ""),
    email,
    password: String(formData.get("password") ?? ""),
    kind: (String(formData.get("kind") ?? "repair") as ShopKind) || "repair",
  });
  revalidatePath("/companies");
  const code = String(formData.get("partnerCode") ?? "").trim();
  if (code) {
    try {
      await redeemPartnerCode(shop.id, shop.name, email, code);
    } catch (e) {
      throw new UserError(`The company was created, but the partner code didn't connect it: ${e instanceof Error ? e.message : e}. Its owner can enter a new code under Partner shops.`);
    }
  }
});
