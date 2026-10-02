import "server-only";
// The cross-reference's local rules (modules-design.md 10.b): which synced entry already owns a (brand, number) pair,
// the hub's own rule, so the form can say so before sending. Here rather than in the action file so the check scripts
// can drive it ("use server" files may export only async functions, and this is one, but the actions wrap requireUser).
import { db } from "@/lib/db";
import { brandKey } from "@/lib/format";
import { numberKey, type XNumber } from "@/lib/parts";

/**
 * The local entry that already has one of these numbers under the same brand (besides `except`). The same number from
 * another maker is another part ("Hoover, Type Y" and "Kenmore, Type Y"), and a one- or two-character number says too
 * little to tell parts apart.
 */
export async function numberOwner(numbers: XNumber[], except?: string): Promise<{ id: string; name: string } | null> {
  const want = numbers.map((n) => ({ brand: brandKey(n.brand), key: numberKey(n.number) })).filter((w) => w.key.length >= 3);
  if (!want.length) return null;
  const near = await db.xPart.findMany({
    where: {
      numberKeys: { hasSome: want.map((w) => w.key) },
      ...(except ? { id: { not: except } } : {}),
    },
    select: { id: true, name: true, numbers: true },
    take: 200,
  });
  const hit = near.find((x) => (x.numbers as XNumber[]).some((xn) => want.some((w) => w.key === numberKey(xn.number) && w.brand === brandKey(xn.brand))));
  return hit ? { id: hit.id, name: hit.name } : null;
}
