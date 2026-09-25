import "server-only";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { DEFAULT_CHECKLIST, DEFAULT_SERVICE_MENU } from "@/lib/service-menu";

/** A new company with its owner login. New companies start with the menu names but no prices; they set their own. */
export async function createShopWithOwner(input: { shopName: string; name: string; email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  if (!input.shopName.trim() || !input.name.trim() || !email || input.password.length < 8) {
    throw new UserError("Fill in every field; password 8+ characters.");
  }
  if (await db.user.findUnique({ where: { email } })) throw new UserError("That email already has an account.");
  return db.shop.create({
    data: {
      name: input.shopName.trim(),
      checklistItems: DEFAULT_CHECKLIST,
      users: { create: { email, name: input.name.trim(), role: "OWNER", passwordHash: await bcrypt.hash(input.password, 10) } },
      serviceItems: { create: DEFAULT_SERVICE_MENU.map((s, i) => ({ name: s.name, priceCents: 0, sortOrder: i })) },
    },
    select: { id: true },
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
