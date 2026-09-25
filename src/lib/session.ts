import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { UserError } from "@/lib/action";
import { isPlatformAdmin } from "@/lib/shops";

export type CurrentUser = { id: string; shopId: string; role: "OWNER" | "ADMIN" | "TECH"; name: string; email: string };

/** The signed-in user, or a redirect to /login. Every business query filters by `shopId`. */
export async function requireUser(): Promise<CurrentUser> {
  const session = await auth();
  const u = session?.user;
  if (!u?.id || !u.shopId) redirect("/login");
  return { id: u.id, shopId: u.shopId, role: u.role, name: u.name ?? "", email: u.email ?? "" };
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
