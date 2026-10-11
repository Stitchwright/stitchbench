import "server-only";
// Settings → Features (free-software-design.md section 7, decision 6): an owner or admin switches each add-on on or off
// for the company, free. Switching one off deletes nothing: its records stay to look at and export, and the work that
// came in before can be finished (src/lib/modules.ts). The action wrapper is src/actions/features.ts.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { actorOf, audit } from "@/lib/audit";
import { isFeatureId, MODULES } from "@/lib/module-info";
import { loadModules } from "@/lib/modules";
import type { CurrentUser } from "@/lib/session";

/** One add-on on or off for the user's company. Owners and admins only. Switching to what it already is changes nothing. */
export async function setFeatureFor(user: CurrentUser, id: string, on: boolean): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can switch features on or off.");
  if (!isFeatureId(id)) throw new UserError("Pick one of the features on the list.");
  // A company from before 1.8 has its Features worked out from its keys first, so this switch lands on top of them.
  const now = (await loadModules(user.shopId)).states[id];
  if (now.active === on) return;
  await db.$transaction(async (tx) => {
    await tx.shopFeature.upsert({
      where: { shopId_module: { shopId: user.shopId, module: id } },
      create: { shopId: user.shopId, module: id, enabled: on, byName: user.name },
      update: { enabled: on, changedAt: new Date(), byName: user.name },
    });
    await audit(tx, actorOf(user), { action: "feature.switch", subjectType: "Shop", subjectId: user.shopId, subjectLabel: MODULES[id].label, changes: { on: [!on, on] } });
  });
  // The menu, check-in and every page follow the module.
  revalidatePath("/", "layout");
}
