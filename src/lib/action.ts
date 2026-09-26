// Server actions return { error } for problems the user can fix, because Next.js
// hides thrown error messages in production. Anything else still throws.
export class UserError extends Error {
  // Next bundles the pages, the actions and the background timers as separate copies of this code, and an error thrown
  // in one copy is not `instanceof` the class in another: this mark says what it is wherever it's caught.
  readonly userError = true;
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

/** A UserError from any copy of the code. */
export function isUserError(e: unknown): e is UserError {
  return e instanceof UserError || (typeof e === "object" && e !== null && (e as { userError?: unknown }).userError === true);
}

export type ActionResult = { ok: true; error?: undefined } | { ok?: false; error: string };

export function safe<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A): Promise<ActionResult> => {
    try {
      await fn(...args);
      return { ok: true };
    } catch (e) {
      if (isUserError(e)) return { error: e.message };
      throw e;
    }
  };
}
