// Checks on what reaches the server from a browser.
import { UserError } from "@/lib/action";

/**
 * A row id passed to a server action. Actions can be posted to directly with any JSON, so an id may arrive as an
 * object; in a Prisma where that is a filter (e.g. { contains: "" }) that matches rows the caller doesn't own.
 */
export function assertId(v: unknown): string {
  if (typeof v !== "string" || !v || v.length > 100) throw new UserError("Not found.");
  return v;
}

/** Each of several ids (see assertId). */
export function assertIds(...vs: unknown[]) {
  vs.forEach(assertId);
}

/** A value for a SQL LIKE / ILIKE pattern that matches only itself: "_" and "%" are not wildcards. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/**
 * "The same text in any case" for a Prisma string filter. Prisma sends equals + insensitive as ILIKE without escaping
 * the value, so "Q_7" would also match "Q-7" and "Z%" anything starting with Z.
 */
export const sameText = (s: string) => ({ equals: escapeLike(s), mode: "insensitive" as const });
