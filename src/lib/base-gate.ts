import "server-only";
// The program's own license, the "base" module (hub-accounts-billing-design.md 3.5): where it stands for a company, and
// the one refusal every write gets while it has lapsed. "off" (no key ever) is fully working: an install that never
// connects to a hub must keep working as it always has.
//
// The same gate freezes a company that is being moved to another install (company-move-design.md section 7): while
// Shop.movingAt is set this copy is read-only with the same allow-list, whatever the key says, and the refusal names the
// move ("This company is moving to <where>; it is read-only here since <date>"). Cancel (Settings → Company) lifts it.
import { UserError } from "@/lib/user-error";
import { baseWritable as writable, readOnlyMessage, type ModuleState, type Moving } from "@/lib/module-info";
import { getModules, isAdminWho, type Who } from "@/lib/modules";
import { movingMessage } from "@/lib/move/format";
import { fmtDate } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";

const shopIdOf = (who: Who) => (typeof who === "string" ? who : who.shopId);

/** Why a company is read-only: its program key lapsed, or it is being moved. Null when writes are allowed. */
export type ReadOnlyReason = { kind: "lapsed"; state: ModuleState } | { kind: "moving"; moving: Moving; state: ModuleState };

/** The base module's state for a company (per request, through getModules). */
export async function baseState(shopId: string): Promise<ModuleState> {
  return (await getModules(shopId)).states.base;
}

/** The reason the company is read-only right now, or null. A move wins over a lapsed key: it is what the owner did last and what they can undo. */
export async function readOnlyReason(shopId: string): Promise<ReadOnlyReason | null> {
  const m = await getModules(shopId);
  if (m.moving) return { kind: "moving", moving: m.moving, state: m.states.base };
  return writable(m.states.base.status) ? null : { kind: "lapsed", state: m.states.base };
}

/** The refusal's words for a reason. */
export async function readOnlyWords(shopId: string, r: ReadOnlyReason, admin: boolean): Promise<string> {
  if (r.kind === "lapsed") return readOnlyMessage(r.state, admin);
  return movingMessage(r.moving, fmtDate(r.moving.at, await shopTimeZone(shopId)), admin);
}

/** True unless the company's program key has lapsed or the company is being moved. */
export async function baseWritable(shopId: string): Promise<boolean> {
  return (await readOnlyReason(shopId)) == null;
}

/** Throws the read-only UserError while lapsed or moving; otherwise returns the base state. */
export async function requireBaseWritable(who: Who): Promise<ModuleState> {
  const shopId = shopIdOf(who);
  const r = await readOnlyReason(shopId);
  if (r) throw new UserError(await readOnlyWords(shopId, r, isAdminWho(who)));
  return (await getModules(shopId)).states.base;
}

/** Route handlers: a 403 Response with the read-only message, or null to go on. */
export async function baseResponse(shopId: string, admin = true): Promise<Response | null> {
  const r = await readOnlyReason(shopId);
  return r ? new Response(await readOnlyWords(shopId, r, admin), { status: 403 }) : null;
}
