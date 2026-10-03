// Server actions return { error } for problems the user can fix, because Next.js
// hides thrown error messages in production. Anything else still throws.
//
// Server side only since the read-only rule (safe() below asks who is signed in): client components may import the
// types from here, never a value. UserError and isUserError live in "@/lib/user-error", which is safe anywhere.
import { asCompany } from "@/lib/acting-company";
import { actingUser, lapseGuard } from "@/lib/lapse-guard";
import type { WhileLapsed } from "@/lib/lapse-allow";
import { isUserError, UserError } from "@/lib/user-error";

export { UserError, isUserError };

/** `note`: shown instead of the form's fixed success words; `warn`: it worked, but says what staff must still do. */
export type ActionResult = { ok: true; error?: undefined; note?: string; warn?: string } | { ok?: false; error: string; note?: undefined; warn?: undefined };

/**
 * Wraps a server action. While the signed-in company's program key has lapsed (hub-accounts-billing-design.md 3.5),
 * every wrapped action is refused with the read-only message, except one wrapped with safe.whileLapsed("<its name>")
 * (the allow-list in src/lib/lapse-allow.ts: payments, closing, the account page, sync). The action runs as the
 * signed-in person's company (src/lib/acting-company.ts): every hub call it makes names that company (X-Shop-Ref), so
 * on a hosted install each company acts on the hub under its own name and can't touch another's rows.
 */
export function safe<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, opts: { whileLapsed?: WhileLapsed } = {}) {
  return async (...args: A): Promise<ActionResult> => {
    try {
      const user = await actingUser();
      if (!opts.whileLapsed) await lapseGuard(user);
      await asCompany(user?.shopId, () => fn(...args));
      return { ok: true };
    } catch (e) {
      if (isUserError(e)) return { error: e.message };
      throw e;
    }
  };
}

/** The same wrapper for an action on the allow-list: it names itself, and TypeScript holds the name to the list. */
safe.whileLapsed =
  (name: WhileLapsed) =>
  <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
    safe(fn, { whileLapsed: name });
