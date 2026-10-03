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

/**
 * How many public POSTs a minute the whole instance takes, per pool: the customer forms (booking, estimates,
 * unsubscribe) share one budget as before; the shop's cart and checkout have their own, bigger one; Stripe's webhooks
 * their own again, so one shop's cart clicks can never hold up another shop's payment.
 */
const POST_POOLS = { forms: 300, shop: 3000, webhook: 1200 } as const;
export type PostPool = keyof typeof POST_POOLS;

/** For public routes: the limit per address (or "anon"), and every public POST also counts against its pool's shared cap. */
export function allowPublic(req: Request | Headers, key: string, limit: number, windowMs: number, pool: PostPool = "forms"): boolean {
  const who = clientAddress(req) ?? "anon";
  const method = req instanceof Request ? req.method : "GET";
  if (method === "POST" && !allow(`public-post:${pool}`, POST_POOLS[pool], 60_000)) return false;
  return allow(`${key}:${who}`, limit, windowMs);
}
