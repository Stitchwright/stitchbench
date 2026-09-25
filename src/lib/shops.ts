import "server-only";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { DEFAULT_CHECKLIST, DEFAULT_SERVICE_MENU } from "@/lib/service-menu";

export type ShopKind = "repair" | "retail" | "both";

/** What a company does, from the sign-up / Companies choice. */
export function shopModes(kind: string | null | undefined) {
  return { doesRepair: kind !== "retail", sellsRetail: kind === "retail" || kind === "both" };
}

/**
 * A new company with its owner login. Repair shops start with the service menu names but no prices; they set their own.
 * A sewing / quilt shop (kind "retail") gets the StitchShop register instead of the repair bench.
 */
export async function createShopWithOwner(input: { shopName: string; name: string; email: string; password: string; kind?: ShopKind }) {
  const email = input.email.trim().toLowerCase();
  if (!input.shopName.trim() || !input.name.trim() || !email || input.password.length < 8) {
    throw new UserError("Fill in every field; password 8+ characters.");
  }
  if (await db.user.findUnique({ where: { email } })) throw new UserError("That email already has an account.");
  const modes = shopModes(input.kind);
  return db.shop.create({
    data: {
      name: input.shopName.trim(),
      ...modes,
      checklistItems: DEFAULT_CHECKLIST,
      users: { create: { email, name: input.name.trim(), role: "OWNER", passwordHash: await bcrypt.hash(input.password, 10) } },
      serviceItems: modes.doesRepair ? { create: DEFAULT_SERVICE_MENU.map((s, i) => ({ name: s.name, priceCents: 0, sortOrder: i })) } : undefined,
    },
    select: { id: true, name: true },
  });
}

/** Whoever runs StitchBench itself (PLATFORM_ADMIN_EMAILS, comma-separated) can create companies for other shops. */
export function isPlatformAdmin(email: string | null | undefined) {
  if (!email) return false;
  const list = (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}
