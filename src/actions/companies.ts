"use server";

import { revalidatePath } from "next/cache";
import { isUserError, safe, UserError } from "@/lib/action";
import { requirePlatformAdmin } from "@/lib/session";
import { createShopWithOwner, type ShopKind } from "@/lib/shops";
import { normalizeEmail } from "@/lib/email";
import { redeemPartnerCode } from "@/lib/partners";
import { str } from "@/lib/format";
import { assertId } from "@/lib/input";
import { setCompanyModuleFor, setHubWritesFor } from "@/lib/modules-admin";

/** An IANA time zone this server knows (America/New_York...), or null for blank. Same check Settings uses. */
function validTimeZone(tz: string | null) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new UserError(`"${tz}" isn't a time zone. Use a name like America/New_York or America/Chicago.`);
  }
}

/**
 * The StitchBench admin sets up another shop and its owner login (sign-up stays closed). With a partner code from the
 * shop's repair shop (made on the repair shop's own install), the new company is connected to it straight away:
 * how a repair shop hosting StitchShop for its partner sewing shops adds each one.
 */
export const createCompany = safe(async function createCompany(formData: FormData) {
  await requirePlatformAdmin();
  const email = normalizeEmail(formData.get("email"));
  const shop = await createShopWithOwner({
    shopName: String(formData.get("shop") ?? ""),
    name: String(formData.get("name") ?? ""),
    email,
    password: String(formData.get("password") ?? ""),
    kind: (String(formData.get("kind") ?? "repair") as ShopKind) || "repair",
    timeZone: validTimeZone(str(formData.get("timeZone"))),
  }, { allowReserved: true });
  revalidatePath("/companies");
  const code = String(formData.get("partnerCode") ?? "").trim();
  if (code) {
    try {
      await redeemPartnerCode(shop.id, shop.name, email, code);
    } catch (e) {
      // Only a message meant for people goes to the browser; a database or network error stays in the server's log.
      if (!isUserError(e)) console.error("partner code for a new company:", e);
      const why = isUserError(e) ? e.message : "something went wrong on the server, and its log has the details";
      throw new UserError(`The company was created, but the partner code didn't connect it: ${why}. Its owner can enter a new code under Partner shops.`);
    }
  }
});

/** The administrator's module switch for one company (modules-design.md section 8). Body: src/lib/modules-admin.ts. */
export const setCompanyModule = safe.whileLapsed("setCompanyModule")(async (fd: FormData) => setCompanyModuleFor(await requirePlatformAdmin(), fd));

/** Switch a company's writes to the community hub off (or back on). */
export const setHubWrites = safe.whileLapsed("setHubWrites")(async (shopId: string, off: boolean) => setHubWritesFor(await requirePlatformAdmin(), assertId(shopId), off));
