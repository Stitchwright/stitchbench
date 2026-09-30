import "server-only";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { EMAIL_HELP, isValidEmail, normalizeEmail } from "@/lib/email";
import { DEFAULT_CHECKLIST, DEFAULT_SERVICE_MENU } from "@/lib/service-menu";

export type ShopKind = "repair" | "retail" | "both";

/**
 * Which product this install is: StitchBench (a repair bench) or StitchShop (a sewing / quilt shop counter). Set by the
 * Windows program's build, or APP_NAME / DEFAULT_SHOP_KIND on a hosted install. It only changes names and defaults:
 * any company can still do repairs, sell over the counter, or both.
 */
export function defaultShopKind(): ShopKind {
  const k = process.env.DEFAULT_SHOP_KIND;
  return k === "retail" || k === "both" ? k : "repair";
}

export function appName(): "StitchShop" | "StitchBench" {
  return process.env.APP_NAME === "StitchShop" || (!process.env.APP_NAME && defaultShopKind() === "retail") ? "StitchShop" : "StitchBench";
}

/** What a company does, from the sign-up / Companies choice. */
export function shopModes(kind: string | null | undefined) {
  return { doesRepair: kind !== "retail", sellsRetail: kind === "retail" || kind === "both" };
}

/**
 * A new company with its owner login. Repair shops start with the service menu names but no prices; they set their own.
 * A sewing / quilt shop (kind "retail") gets the StitchShop register instead of the repair bench.
 */
/**
 * A new company and its owner login. With firstOnly (the Windows program's first-run sign-up) it is made only when the
 * install has no company yet, checked and created under one lock. `first` says whether it is the install's first.
 * The StitchBench administrator's addresses (PLATFORM_ADMIN_EMAILS) carry install-wide rights: only the first company
 * or a platform admin (allowReserved) may give one to a new owner.
 */
export async function createShopWithOwner(
  input: { shopName: string; name: string; email: string; password: string; kind?: ShopKind },
  opts: { firstOnly?: boolean; allowReserved?: boolean } = {},
) {
  const email = normalizeEmail(input.email);
  if (!input.shopName.trim() || !input.name.trim() || !email || input.password.length < 8) {
    throw new UserError("Fill in every field; password 8+ characters.");
  }
  if (!isValidEmail(email)) throw new UserError(EMAIL_HELP);
  if (await db.user.findUnique({ where: { email } })) throw new UserError("That email already has an account.");
  const modes = shopModes(input.kind);
  const passwordHash = await bcrypt.hash(input.password, 10);
  const reserved = isPlatformAdmin(email) && !opts.allowReserved;
  return db.$transaction(async (tx) => {
    // One company at a time: which one is first is decided under the lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7710001)`;
    const first = (await tx.shop.count()) === 0;
    if (opts.firstOnly && !first) throw new UserError("This program already has its company. Sign in instead.");
    if (reserved && !first) throw new UserError(RESERVED_EMAIL);
    const shop = await tx.shop.create({
      data: {
        name: input.shopName.trim(),
        ...modes,
        checklistItems: DEFAULT_CHECKLIST,
        users: { create: { email, name: input.name.trim(), role: "OWNER", passwordHash } },
        serviceItems: modes.doesRepair ? { create: DEFAULT_SERVICE_MENU.map((s, i) => ({ name: s.name, priceCents: 0, sortOrder: i })) } : undefined,
      },
      select: { id: true, name: true },
    });
    return { ...shop, first };
  });
}

export const RESERVED_EMAIL = "That email is reserved on this StitchBench.";

/** Whoever runs StitchBench itself (PLATFORM_ADMIN_EMAILS, comma-separated) can create companies for other shops. */
export function isPlatformAdmin(email: string | null | undefined) {
  if (!email) return false;
  const list = (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}
