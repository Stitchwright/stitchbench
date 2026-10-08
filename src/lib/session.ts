import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { isPlatformAdmin } from "@/lib/shops";

export type CurrentUser = {
  id: string;
  shopId: string;
  role: "OWNER" | "ADMIN" | "TECH";
  name: string;
  email: string;
  /**
   * The store this work is decided to happen at (more than one store, shop-features-round-2-design.md 7.1): set by code
   * that acts for a store (a live sale's pay links, a check); never by sign-in. Absent: the device's or person's store.
   */
  locationId?: string | null;
};

/**
 * The signed-in user as the database has them now, or null. The sign-in cookie only says who signed in; access that
 * was removed, a changed password (sessionVersion) or a moved account ends the session here, not 30 days later.
 */
export async function sessionUser(): Promise<CurrentUser | null> {
  const session = await auth();
  const u = session?.user;
  if (!u?.id) return null;
  const row = await db.user.findUnique({
    where: { id: u.id },
    select: { id: true, shopId: true, role: true, name: true, email: true, active: true, sessionVersion: true },
  });
  if (!row || !row.active || row.sessionVersion !== (u.sv ?? 0) || row.shopId !== u.shopId) return null;
  return { id: row.id, shopId: row.shopId, role: row.role, name: row.name, email: row.email };
}

/** The signed-in user, or off to sign in. Every business query filters by `shopId`. */
export async function requireUser(): Promise<CurrentUser> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const user = await sessionUser();
  // Still holding a cookie but no longer allowed in: clear it, then sign in again.
  if (!user) redirect("/api/session-end");
  return user;
}

export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (u.role === "TECH") throw new UserError("Only the shop owner or an admin can change this.");
  return u;
}

/** Whoever runs StitchBench itself: may create companies for other shops. */
export async function requirePlatformAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (!isPlatformAdmin(u.email)) throw new UserError("Only the StitchBench administrator can do this.");
  return u;
}

/**
 * Settings that belong to the whole install (the community hub connection, the manual library) rather than one company.
 * On an install with one company its owner or admin decides; with several, only the StitchBench administrator may.
 * `what` finishes the refusal: "only its administrator can <what>".
 */
export async function requireInstallAdmin(what = "change the community hub connection"): Promise<CurrentUser> {
  const u = await requireAdmin();
  if (isPlatformAdmin(u.email)) return u;
  if ((await db.shop.count()) > 1) {
    throw new UserError(`Several companies share this StitchBench, so only its administrator can ${what}.`);
  }
  return u;
}

export async function isInstallAdmin(u: CurrentUser) {
  if (u.role === "TECH") return false;
  return isPlatformAdmin(u.email) || (await db.shop.count()) <= 1;
}
