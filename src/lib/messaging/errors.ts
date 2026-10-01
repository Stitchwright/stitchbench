// Why a send didn't go, in a form the worker can act on (scheduling-messaging-design.md section 4.1). Pure.
export type SendErrorKind = "offline" | "retry" | "recipient" | "settings" | "quota" | "ambiguous";

/** A send that failed: `kind` says what to do next; `message` is plain words built from codes (never credentials). */
export class SendError extends Error {
  readonly sendError = true;
  constructor(
    msg: string,
    readonly kind: SendErrorKind,
    readonly code?: string,
  ) {
    super(msg);
    this.name = "SendError";
  }
}

/** A SendError from any copy of the code (pages, actions and timers each bundle their own). */
export function isSendError(e: unknown): e is SendError {
  return e instanceof SendError || (typeof e === "object" && e !== null && (e as { sendError?: unknown }).sendError === true);
}
