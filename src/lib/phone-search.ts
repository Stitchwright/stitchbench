import { db } from "@/lib/db";

/**
 * Customers of this shop whose phone has the digits typed in a search box, whatever punctuation either was written
 * with: "(555) 123-4567" is found by 5551234567 and by 555-123-4567. Only for a box that looks like a phone number
 * (a name with a number in it isn't one), and from 4 digits. Ids only, to sit beside the other search fields.
 */
export async function customerIdsByPhone(shopId: string, typed: string): Promise<string[]> {
  if (!/^[\d\s().+-]+$/.test(typed)) return [];
  let digits = typed.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1); // +1 555 123 4567
  if (digits.length < 4 || digits.length > 20) return [];
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Customer"
    WHERE "shopId" = ${shopId} AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE ${`%${digits}%`}
    LIMIT 200`;
  return rows.map((r) => r.id);
}
