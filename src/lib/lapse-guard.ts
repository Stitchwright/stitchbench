import "server-only";
// The rule safe() applies before every server action (hub-accounts-billing-design.md 3.5): while the signed-in
// company's program key has lapsed, a write is refused with the read-only message unless the action is on the
// allow-list (src/lib/lapse-allow.ts). With nobody signed in (a public page's action) there is no company to judge;
// the action's own checks decide, and the public routes pause themselves (online-booking.ts, online-shop.ts).
import { requireBaseWritable } from "@/lib/base-gate";

type LapseUser = { shopId: string; role: "OWNER" | "ADMIN" | "TECH" } | null;
let resolveUser: (() => Promise<LapseUser>) | null = null;

/**
 * Check scripts only: there is no request to read a session from, so they say who is acting. Never called by the app.
 */
export function lapseUserFrom(fn: () => Promise<LapseUser>) {
  resolveUser = fn;
}

/** Who is signed in for this action (null on a public page's action), from the session or a check script's say-so. */
export async function actingUser(): Promise<LapseUser> {
  // The session module (next-auth, next/navigation) is loaded only when an action really runs: action.ts is imported by
  // every lib and check script, and the check scripts run outside Next.
  const resolve = resolveUser ?? (await import("@/lib/session")).sessionUser;
  return resolve();
}

export async function lapseGuard(user?: LapseUser): Promise<void> {
  const u = user === undefined ? await actingUser() : user;
  if (!u) return;
  await requireBaseWritable(u);
}
