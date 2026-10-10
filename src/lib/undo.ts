import "server-only";
// "Undo" after a removal (ease-of-use: a calm bar instead of an "Are you sure?" box). A removal action keeps what it took
// away here, under a random token that only the person who removed it can use, and hands the token back to the page
// (safe() carries it as `undo`). The restore action takes the snapshot out again and puts the rows back with their own ids.
//
// Kept in this server's memory, not the database: no schema change, nothing to clean up, and a photo's bytes never land in
// the audit log. It is held a couple of minutes (the bar shows for ten seconds); a restart in between loses it, and the
// restore then says so plainly instead of guessing. The snapshot never comes from the browser, so it can't be forged.
import { randomBytes } from "node:crypto";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";

const HOLD_MS = 2 * 60_000;
const MAX_HELD = 100;

type Held = { shopId: string; userId: string; kind: string; data: unknown; until: number };

// One map per process, kept across dev reloads.
const g = globalThis as unknown as { __undoHeld?: Map<string, Held> };
const held = (g.__undoHeld ??= new Map<string, Held>());

function sweep() {
  const now = Date.now();
  for (const [k, v] of held) if (v.until < now) held.delete(k);
  // A flood of removals can't grow it without bound: the oldest go first.
  while (held.size > MAX_HELD) held.delete(held.keys().next().value as string);
}

/** Keeps `data` for this person's Undo; returns the token. */
export function stashUndo(user: Pick<CurrentUser, "shopId" | "id">, kind: string, data: unknown): string {
  sweep();
  const token = randomBytes(18).toString("base64url");
  held.set(token, { shopId: user.shopId, userId: user.id, kind, data, until: Date.now() + HOLD_MS });
  return token;
}

/** Takes the snapshot out (once). Only the same person, in the same company, for the same kind of removal. */
export function takeUndo<T>(user: Pick<CurrentUser, "shopId" | "id">, kind: string, token: string): T {
  sweep();
  const h = typeof token === "string" ? held.get(token) : undefined;
  if (!h || h.shopId !== user.shopId || h.userId !== user.id || h.kind !== kind) {
    throw new UserError("Sorry, that was too long ago to put back. Please add it again.");
  }
  held.delete(token);
  return h.data as T;
}
