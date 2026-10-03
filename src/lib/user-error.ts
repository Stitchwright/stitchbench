// The error a user can fix, and how to recognise one. Pure: safe in client components (src/lib/action.ts re-exports
// both for the server side and adds safe()).
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
