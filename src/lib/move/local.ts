import "server-only";
// The Windows program's door for a move file (company-move-design.md section 8): the tray's file dialog picks the file
// and the server reads it from disk (no upload, no size limit but the disk's), then imports it as every door does.
//
// Why a route the program calls, and not a command line: the installed program has neither tsx nor the scripts folder
// (the standalone build leaves them out), and the importer needs the server's own Prisma client and table list; the
// server already has both. Why it is safe: the route answers only a request that carries a token made by the program
// itself (desktop/main.mjs moveToken): an HMAC, under a secret the program hands the server at each start
// (MOVE_LOCAL_SECRET, never sent to a page or over the network), of a fresh nonce, an expiry two minutes on and the
// file's path. Each token is good once and for that file only, so nothing on the shop's network (which can reach the
// server's port) can start an import, and a token seen in a log can't be used again. On top of that the route takes
// only requests addressed to the PC itself, and the import is allowed only while the PC has no company or is set up to
// host several (platformAdminEmails; design decision 13).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { hostsMany, ONE_COMPANY } from "./import";
import { startImportJob } from "./import-jobs";

/** Said (403) to a request without a good token: the door is only the program's own. */
export const DOOR_SHUT = "Only the program on this PC can bring in a company from a file. Use its tray icon: Restore a company from a move file.";
const TOKEN_LIFE = 2 * 60_000;

/** The token desktop/main.mjs makes for one file (the same sum, kept here for the check script). */
export function moveToken(secret: string, file: string, now = Date.now()): string {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const until = String(now + TOKEN_LIFE);
  const mac = crypto.createHmac("sha256", secret).update(`${nonce}.${until}.${file}`).digest("base64url");
  return `${nonce}.${until}.${mac}`;
}

function usedNonces(): Map<string, number> {
  const g = globalThis as unknown as { __moveNonces?: Map<string, number> };
  return (g.__moveNonces ??= new Map());
}

/** The token is the program's, for this file, not expired and not used before (it is used up here). */
export function takeMoveToken(token: unknown, file: string, now = Date.now()): boolean {
  const secret = process.env.MOVE_LOCAL_SECRET;
  if (!secret || typeof token !== "string") return false;
  const [nonce, until, mac, ...rest] = token.split(".");
  if (!nonce || !until || !mac || rest.length) return false;
  const exp = Number(until);
  if (!Number.isSafeInteger(exp) || exp < now || exp > now + TOKEN_LIFE + 60_000) return false;
  const want = Buffer.from(crypto.createHmac("sha256", secret).update(`${nonce}.${until}.${file}`).digest("base64url"));
  const got = Buffer.from(mac);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  const used = usedNonces();
  for (const [k, t] of used) if (t < now) used.delete(k);
  if (used.has(nonce)) return false;
  used.set(nonce, exp);
  return true;
}

/** Whether this install takes a company from a move file at the PC: it has none yet, or it is set up to host several. */
export async function pcImportOpen(): Promise<boolean> {
  return hostsMany() || (await db.shop.count()) === 0;
}

/** The tray's request: the token checked and spent, the file there, the PC allowed to take a company; then the job's id. */
export async function startPcImport(file: unknown, token: unknown): Promise<string> {
  if (typeof file !== "string" || !file || !path.isAbsolute(file)) throw new UserError(DOOR_SHUT);
  if (!takeMoveToken(token, file)) throw new UserError(DOOR_SHUT);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new UserError("That file isn't there any more. Choose it again.");
  }
  if (!stat.isFile()) throw new UserError("Choose the move file itself, not a folder.");
  if (!(await pcImportOpen())) throw new UserError(ONE_COMPANY);
  return startImportJob({ file, by: "operator", door: "pc" });
}
