import "server-only";
// What the hub says about a company's standing, written down (hub-accounts-billing-design.md 2.4 and 3.5). The words
// (standing, last day, message, the account's email) go to the Shop row for Settings → Account to show. Only the key
// changes what the program allows: it is verified like a pasted one and kept as the company's single "hub" License row,
// replaced by the hub's next key; a key the hub revokes goes, and only if the hub issued it (never a pasted one).
import { db } from "@/lib/db";
import { validYmd } from "@/lib/license";
import { verifyFor } from "@/lib/modules";

/** The hub's answer to POST /v1/shops/claim, GET /v1/shops/:ref/standing, or the shop part of POST /v1/accounts/start. */
export type StandingAnswer = {
  account?: { email?: string | null; verified?: boolean } | null;
  standing?: string | null;
  lastDay?: string | null;
  message?: string | null;
  key?: string | null;
  revokeKeyIds?: string[] | null;
};

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function applyStanding(shopId: string, a: StandingAnswer): Promise<void> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true } });
  if (!shop) return;
  await db.shop.update({
    where: { id: shopId },
    data: {
      hubStandingAt: new Date(),
      hubStanding: text(a.standing, 40),
      hubStandingUntil: validYmd(a.lastDay) ? a.lastDay : null,
      hubStandingNote: text(a.message, 500),
      hubAccountEmail: text(a.account?.email, 200),
      hubAccountVerified: a.account?.verified === true,
    },
  });
  // Keys the hub took back (a refund, a chargeback): only rows the hub itself issued.
  const revoke = (Array.isArray(a.revokeKeyIds) ? a.revokeKeyIds : []).filter((k): k is string => typeof k === "string" && /^[0-9A-Z]{6,20}$/.test(k)).slice(0, 100);
  if (revoke.length) await db.license.deleteMany({ where: { shopId, source: "hub", keyId: { in: revoke } } });
  // The key: it must verify with a compiled public key, be for this company and carry the program itself. One hub row
  // per company: the hub's newest key replaces whatever hub key came before. A hub that sends none leaves the stored
  // key where it is; its last day plus grace is then the limit (an offline PC, a hub that went away).
  const key = typeof a.key === "string" ? a.key.trim() : "";
  if (!key) return;
  const v = verifyFor(key, "pasted");
  if (!v.ok || v.payload.s !== shopId || !v.payload.m.includes("base")) {
    console.error(`community hub: the key it sent for company ${shopId} isn't usable here (${v.ok ? "for another company or not the program's own key" : v.reason})`);
    return;
  }
  const keyId = v.payload.id;
  await db.$transaction([
    db.license.deleteMany({ where: { shopId, source: "hub", keyId: { not: keyId } } }),
    db.license.upsert({ where: { shopId_keyId: { shopId, keyId } }, create: { shopId, keyId, key, source: "hub", addedBy: "StitchHub" }, update: { key, source: "hub" } }),
  ]);
}
