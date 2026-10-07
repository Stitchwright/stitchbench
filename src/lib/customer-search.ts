import { db } from "@/lib/db";
import { nameNear, searchPrefixes } from "@/lib/near-spelling";

/**
 * Customers of this shop whose name is a near spelling of what was typed ("dorthy" finds Dorothy Miller), for a search
 * that found nothing as typed. The database narrows to names with a word starting with the same two letters (a plain
 * ILIKE, no extension), then the near-spelling check runs here. Ids, best first is not promised: the caller orders.
 */
export async function customerIdsBySpelling(shopId: string, typed: string, opts: { retailOnly?: boolean; take?: number } = {}): Promise<string[]> {
  const prefixes = searchPrefixes(typed);
  if (!prefixes.length) return [];
  const rows = await db.customer.findMany({
    where: {
      shopId,
      ...(opts.retailOnly ? { kind: "RETAIL" as const } : {}),
      OR: prefixes.flatMap((p) => [{ name: { startsWith: p, mode: "insensitive" as const } }, { name: { contains: ` ${p}`, mode: "insensitive" as const } }]),
    },
    select: { id: true, name: true },
    take: 3000,
  });
  return rows
    .filter((r) => nameNear(r.name, typed))
    .slice(0, opts.take ?? 50)
    .map((r) => r.id);
}
