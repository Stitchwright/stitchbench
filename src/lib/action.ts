// Server actions return { error } for problems the user can fix, because Next.js
// hides thrown error messages in production. Anything else still throws.
export class UserError extends Error {}

export type ActionResult = { ok: true; error?: undefined } | { ok?: false; error: string };

export function safe<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A): Promise<ActionResult> => {
    try {
      await fn(...args);
      return { ok: true };
    } catch (e) {
      if (e instanceof UserError) return { error: e.message };
      throw e;
    }
  };
}
