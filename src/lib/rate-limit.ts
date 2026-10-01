import "server-only";
// In-memory sliding windows (scheduling-messaging-design.md section 4.1): enough to stop hammering, not a quota.
// On globalThis so the pages, actions and timers (separate bundles) share one table; at most 50 000 keys.
import { clientAddress } from "@/lib/client-ip";

type Table = Map<string, number[]>;
const table = ((globalThis as unknown as { __rate?: Table }).__rate ??= new Map());
const MAX_KEYS = 50_000;

/** True when this call is within `limit` calls per `windowMs` for the key (and counts it). */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const list = (table.get(key) ?? []).filter((t: number) => now - t < windowMs);
  if (list.length >= limit) {
    table.set(key, list);
    return false;
  }
  list.push(now);
  table.delete(key);
  table.set(key, list);
  if (table.size > MAX_KEYS) table.delete(table.keys().next().value as string);
  return true;
}

/** For public routes: the limit per address (or "anon"), and every public POST also counts against one shared cap. */
export function allowPublic(req: Request | Headers, key: string, limit: number, windowMs: number): boolean {
  const who = clientAddress(req) ?? "anon";
  const method = req instanceof Request ? req.method : "GET";
  if (method === "POST" && !allow("public-post", 300, 60_000)) return false;
  return allow(`${key}:${who}`, limit, windowMs);
}
