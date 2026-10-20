import "server-only";
// The cutover's last step (docs/plan.md FA-5): once people sign in with their Foundry Accounts (FOUNDRY_SIGNIN=only), the local
// password of every login that has one linked is dead weight and a risk (a hash someone could try to crack). Retiring replaces it
// with a hash of something nobody knows. Logins with no Foundry Account linked keep theirs: they can't sign in with it any more,
// but it is how they could still prove who they are at /login/link, so it goes only when they have linked. Idempotent.
import { audit, systemActor } from "@/lib/audit";
import { db } from "@/lib/db";
import { foundrySignInMode } from "@/lib/foundry/switches";
import { unusablePasswordHash } from "@/lib/foundry/unusable";
import { UserError } from "@/lib/user-error";

export type RetireReport = {
  /** Logins linked to a Foundry Account. */
  linked: number;
  /** How many of those had their password retired (0 on a dry run). */
  retired: number;
  /** Active logins with no Foundry Account yet: they keep their passwords and can't sign in until they link. */
  waiting: { email: string; company: string; role: string }[];
};

/** `onlyShops` limits it to those companies (the check scripts share a dev database); the script leaves it out. */
export async function retirePasswords(o: { apply: boolean; onlyShops?: string[] }): Promise<RetireReport> {
  if (foundrySignInMode() !== "only") throw new UserError("Set FOUNDRY_SIGNIN=only first: until then people still sign in with their local passwords.");
  const scope = o.onlyShops ? { shopId: { in: o.onlyShops } } : {};
  const linked = await db.user.findMany({ where: { foundryId: { not: null }, ...scope }, select: { id: true, shopId: true, name: true, email: true } });
  const waiting = await db.user.findMany({ where: { foundryId: null, active: true, ...scope }, orderBy: [{ shopId: "asc" }, { createdAt: "asc" }], select: { email: true, role: true, shop: { select: { name: true } } } });
  let retired = 0;
  if (o.apply) {
    for (const u of linked) {
      await db.user.update({ where: { id: u.id }, data: { passwordHash: await unusablePasswordHash() } });
      await audit(db, systemActor(u.shopId, "Foundry cutover"), { action: "user.password_retired", subjectType: "User", subjectId: u.id, subjectLabel: `${u.name} (${u.email})` });
      retired += 1;
    }
  }
  return { linked: linked.length, retired, waiting: waiting.map((w) => ({ email: w.email, company: w.shop.name, role: w.role })) };
}
