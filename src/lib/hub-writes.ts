import "server-only";
// Whether this company may write to the community hub (links, cross-references, shared posts), and the name its
// writes carry. The StitchBench administrator switches a company's writes off from Companies (Shop.hubWritesOff).
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";

/**
 * Throws when the company's hub writes are switched off. Otherwise returns the byName to send: "{user} ({company})"
 * on an install with more than one company, else the user's name.
 */
export async function requireHubWrites(user: { shopId: string; name: string }): Promise<string> {
  const [shop, companies] = await Promise.all([
    db.shop.findUnique({ where: { id: user.shopId }, select: { name: true, hubWritesOff: true, movingAt: true } }),
    db.shop.count(),
  ]);
  if (shop?.hubWritesOff) throw new UserError("Sharing to the community hub is switched off for this company. Ask StitchBench.");
  // Being moved (company-move-design.md section 7): nothing written to the hub from the copy that is leaving.
  if (shop?.movingAt) throw new UserError("This company is being moved to another install, so nothing is shared to the hub from here. Cancel the move in Settings → Company to carry on here.");
  return companies > 1 && shop ? `${user.name} (${shop.name})` : user.name;
}
