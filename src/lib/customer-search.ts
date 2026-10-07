import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { nameNear, prefixPatterns } from "@/lib/near-spelling";

/** Candidates looked at, newest customers first, and how much of a search is spelled against them: the work stays small. */
const MAX_CANDIDATES = 2000;
const MAX_TYPED = 60;

/**
 * Customers of this shop whose name is a near spelling of what was typed ("dorthy" finds Dorothy Miller), for a search
 * that found nothing as typed. The database narrows to names with a word starting with the same two letters, the name
 * split into words the same way words() does ("O'Brien" is one word, obrien; "Smith-Jones" and "Miller,Dorothy" two),
 * then the near-spelling check runs here. Ids, best first is not promised: the caller orders.
 */
export async function customerIdsBySpelling(shopId: string, typed: string, opts: { retailOnly?: boolean; take?: number } = {}): Promise<string[]> {
  const search = typed.slice(0, MAX_TYPED);
  const patterns = prefixPatterns(search);
  if (!patterns.length) return [];
  // ' ' + the name's words, lower case, apostrophes dropped, anything else not a letter or digit a space: what spacedWords() gives.
  const rows = await db.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`
    SELECT id, name FROM "Customer"
    WHERE "shopId" = ${shopId} ${opts.retailOnly ? Prisma.sql`AND "kind" = 'RETAIL'` : Prisma.empty}
      AND ' ' || regexp_replace(replace(lower(name), '''', ''), '[^[:alnum:]]+', ' ', 'g') LIKE ANY (${patterns})
    ORDER BY "createdAt" DESC
    LIMIT ${MAX_CANDIDATES}`);
  return rows
    .filter((r) => nameNear(r.name, search))
    .slice(0, opts.take ?? 50)
    .map((r) => r.id);
}
