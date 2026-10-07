import "server-only";
// What happens when stock arrives (shop-features-round-2-design.md 1.2 and 1.4): an order received or stock received by
// hand marks the oldest special orders for the item here (held, the customer told), and want lists that match show
// "Here now". Returns the words for the person receiving ("" when nothing was waiting).
import type { CurrentUser } from "@/lib/session";
import { arrivedFor } from "@/lib/special-orders";
import { matchWantsFor } from "@/lib/want-lists";

export async function afterArrival(user: CurrentUser, arrivals: { partId: string; qty: number }[], now = new Date()): Promise<string> {
  const words: string[] = [];
  try {
    const so = await arrivedFor(user, arrivals, now);
    if (so) words.push(so);
  } catch (e) {
    // The stock is in either way; a special order can still be marked here by hand.
    console.error("special orders on arrival:", e instanceof Error ? e.message : e);
  }
  try {
    const n = await matchWantsFor(
      user.shopId,
      arrivals.map((a) => a.partId),
      now,
    );
    if (n) words.push(`${n} want list ${n === 1 ? "line matches" : "lines match"}: see Want lists to let ${n === 1 ? "her" : "them"} know.`);
  } catch (e) {
    console.error("want lists on arrival:", e instanceof Error ? e.message : e);
  }
  return words.join(" ");
}
