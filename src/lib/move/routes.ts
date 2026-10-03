import "server-only";
// What the hosted import's routes (src/app/api/move/upload/**) share: who may call them (the StitchBench administrator,
// signed in, over https or on the PC itself: the file is a whole company) and how an answer is written.
import { sessionUser, type CurrentUser } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/shops";
import { secureAddress } from "@/lib/secure-address";
import { isUserError } from "@/lib/user-error";
import { secureRequest } from "./http";
import { ONLY_ADMIN } from "./import";
import { IMPORT_NOT_FOUND } from "./upload";

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The signed-in StitchBench administrator, or the answer that refuses the request. */
export async function importer(req: Request): Promise<CurrentUser | Response> {
  const user = await sessionUser();
  if (!user) return json({ error: "Sign in first." }, 401);
  if (!isPlatformAdmin(user.email)) return json({ error: ONLY_ADMIN }, 403);
  if (!secureRequest(req)) {
    const https = secureAddress();
    return json({ error: `A move file holds a whole company, so it is uploaded only over https or on the program's own PC.${https ? ` Open ${https} and try again.` : ""}` }, 403);
  }
  return user;
}

/** A refusal in the person's words (404 for another's upload), anything else thrown on. */
export function refused(e: unknown): Response {
  if (!isUserError(e)) throw e;
  return json({ error: e.message }, e.message === IMPORT_NOT_FOUND ? 404 : 400);
}
