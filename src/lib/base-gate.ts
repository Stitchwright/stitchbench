import "server-only";
// The program's own license, the "base" module (hub-accounts-billing-design.md 3.5): where it stands for a company, and
// the one refusal every write gets while it has lapsed. "off" (no key ever) is fully working: an install that never
// connects to a hub must keep working as it always has.
import { UserError } from "@/lib/user-error";
import { baseWritable as writable, readOnlyMessage, type ModuleState } from "@/lib/module-info";
import { getModules, isAdminWho, type Who } from "@/lib/modules";

const shopIdOf = (who: Who) => (typeof who === "string" ? who : who.shopId);

/** The base module's state for a company (per request, through getModules). */
export async function baseState(shopId: string): Promise<ModuleState> {
  return (await getModules(shopId)).states.base;
}

/** True unless the company's program key has lapsed. */
export async function baseWritable(shopId: string): Promise<boolean> {
  return writable((await baseState(shopId)).status);
}

/** Throws the read-only UserError while lapsed; otherwise returns the state. */
export async function requireBaseWritable(who: Who): Promise<ModuleState> {
  const s = await baseState(shopIdOf(who));
  if (!writable(s.status)) throw new UserError(readOnlyMessage(s, isAdminWho(who)));
  return s;
}

/** Route handlers: a 403 Response with the read-only message, or null to go on. */
export async function baseResponse(shopId: string, admin = true): Promise<Response | null> {
  const s = await baseState(shopId);
  return writable(s.status) ? null : new Response(readOnlyMessage(s, admin), { status: 403 });
}
