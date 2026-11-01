// Server actions return { error } for problems the user can fix, because Next.js
// hides thrown error messages in production. Anything else still throws.
//
// Server side only since the read-only rule (safe() below asks who is signed in): client components may import the
// types from here, never a value. UserError and isUserError live in "@/lib/user-error", which is safe anywhere.
import { asCompany } from "@/lib/acting-company";
import { actingUser, lapseGuard } from "@/lib/lapse-guard";
import type { WhileLapsed } from "@/lib/lapse-allow";
import { isUserError, UserError } from "@/lib/user-error";
import { DEMO_REFUSAL, demoRefuses } from "@/lib/demo-mode";

export { UserError, isUserError };

/**
 * `note`: shown instead of the form's fixed success words; `warn`: it worked, but says what staff must still do; `shown`:
 * something the person sees once and nowhere else (a new password, a reset link), from an action that returned shownOnce().
 */
export type ActionResult =
  | { ok: true; error?: undefined; note?: string; warn?: string; shown?: string; undo?: UndoOffer }
  | { ok?: false; error: string; note?: undefined; warn?: undefined; shown?: undefined; undo?: undefined };

/** A removal that can be taken back for a few seconds: the words for the bar ("Line removed.") and the token its restore action takes. */
export type UndoOffer = { text: string; token: string };

const SHOWN = Symbol.for("stitchbench.shownOnce");
type ShownOnce = { [SHOWN]: string };

/**
 * What a safe() action hands back to the page that called it, once: a new password, a reset link. Only a value made here
 * passes through safe() (anything else an action returns is dropped as before), and it is never logged or kept.
 */
export function shownOnce(text: string): ShownOnce {
  return { [SHOWN]: text };
}

const NOTED = Symbol.for("stitchbench.noted");
type Noted = { [NOTED]: string };

/** What a safe() action returns to give the person a plain note instead of the form's fixed success words (not an error). */
export function noted(text: string): Noted {
  return { [NOTED]: text };
}

const UNDO = Symbol.for("stitchbench.undoable");
type Undoable = { [UNDO]: UndoOffer };

/** What a removal action returns (safe() passes it on): the bar says `text` with an Undo button that calls the restore action with `token`. */
export function undoable(text: string, token: string): Undoable {
  return { [UNDO]: { text, token } };
}

const isUndoable = (v: unknown): v is Undoable => typeof v === "object" && v !== null && typeof (v as Record<symbol, unknown>)[UNDO] === "object";

const isNoted = (v: unknown): v is Noted => typeof v === "object" && v !== null && typeof (v as Record<symbol, unknown>)[NOTED] === "string";

const isShownOnce = (v: unknown): v is ShownOnce => typeof v === "object" && v !== null && typeof (v as Record<symbol, unknown>)[SHOWN] === "string";

/**
 * Wraps a server action. While the signed-in company's program key has lapsed (hub-accounts-billing-design.md 3.5),
 * every wrapped action is refused with the read-only message, except one wrapped with safe.whileLapsed("<its name>")
 * (the allow-list in src/lib/lapse-allow.ts: payments, closing, the account page, sync). The action runs as the
 * signed-in person's company (src/lib/acting-company.ts): every hub call it makes names that company (X-Shop-Ref), so
 * on a hosted install each company acts on the hub under its own name and can't touch another's rows.
 */
export function safe<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, opts: { whileLapsed?: WhileLapsed } = {}) {
  return async (...args: A): Promise<ActionResult> => {
    let user: Awaited<ReturnType<typeof actingUser>> = null;
    try {
      // An action on the lapse allow-list carries its own name (safe.whileLapsed); the others are named functions.
      if (demoRefuses(opts.whileLapsed ?? fn.name)) throw new UserError(DEMO_REFUSAL);
      user = await actingUser();
      if (!opts.whileLapsed) await lapseGuard(user);
      const out = await asCompany(user?.shopId, () => fn(...args));
      if (isUndoable(out)) return { ok: true, undo: out[UNDO] };
      return isShownOnce(out) ? { ok: true, shown: out[SHOWN] } : isNoted(out) ? { ok: true, note: out[NOTED] } : { ok: true };
    } catch (e) {
      if (isUserError(e)) return { error: e.message };
      // Anything else is a fault in the program: kept for the hub's error alerts (help-feedback-design.md 2), then thrown
      // as before. Loaded only when it happens (check scripts import this file outside Next).
      if (user) await import("@/lib/help").then((h) => h.recordActionError(user!, fn.name, e)).catch(() => {});
      throw e;
    }
  };
}

/** The same wrapper for an action on the allow-list: it names itself, and TypeScript holds the name to the list. */
safe.whileLapsed =
  (name: WhileLapsed) =>
  <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
    safe(fn, { whileLapsed: name });
