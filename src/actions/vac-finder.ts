"use server";

// The finder's data actions (modules-design.md 10.b): what fits a vacuum, and a customer's vacuums for the register's
// picker. Bodies in src/lib/vac/finder.ts; both need the Vac Shop module on.
import { isUserError } from "@/lib/user-error";
import { requireModule } from "@/lib/modules";
import { requireUser } from "@/lib/session";
import { customerVacuumsFor, suppliesFor, type CustomerVacuum, type FinderQuery, type Supply } from "@/lib/vac/finder";

export async function vacSupplies(q: FinderQuery): Promise<{ supplies: Supply[]; truncated: boolean } | { error: string }> {
  try {
    const user = await requireUser();
    await requireModule(user, "vac");
    return await suppliesFor(user.shopId, q);
  } catch (e) {
    return {
      error: isUserError(e) ? e.message : "Couldn't look that up. Check the connection, then try again.",
    };
  }
}

export async function customerVacuums(customerId: string): Promise<CustomerVacuum[] | { error: string }> {
  try {
    const user = await requireUser();
    await requireModule(user, "vac");
    return await customerVacuumsFor(user.shopId, customerId);
  } catch (e) {
    return {
      error: isUserError(e) ? e.message : "Couldn't load the customer's vacuums. Check the connection, then try again.",
    };
  }
}
