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
  /**
   * The login plan (a hub from the two-plan price list on): solo | shop, with the interval and founding for a
   * subscription. Not stored: the same plan rides in the signed key (payload l and fs), which is what src/lib/plan.ts
   * reads, offline too; the words above already name it for Settings → Account.
   */
  plan?: string | null;
  interval?: string | null;
  founding?: boolean | null;
  key?: string | null;
  revokeKeyIds?: string[] | null;
  /** The hub's terms version in force and the one the company's account accepted (a hub from package terms-launch on). */
  terms?: { version?: string | null; accepted?: string | null } | null;
};

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function applyStanding(shopId: string, a: StandingAnswer): Promise<void> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true } });
  if (!shop) return;
  const accepted = text(a.terms?.accepted, 40);
  await db.shop.update({
    where: { id: shopId },
    data: {
      hubStandingAt: new Date(),
      hubStanding: text(a.standing, 40),
      hubStandingUntil: validYmd(a.lastDay) ? a.lastDay : null,
      hubStandingNote: text(a.message, 500),
      hubAccountEmail: text(a.account?.email, 200),
      hubAccountVerified: a.account?.verified === true,
      // What the account accepted, as the hub keeps it (it may have accepted a newer version on the hub's own page). An
      // older hub, or an account that accepted nothing yet, leaves what this program sent when it started the account.
      ...(accepted ? { termsVersion: accepted } : {}),
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

/** Where a company went, as the hub says it to the install the company left (410 { moved, to, at }). */
export type MovedAway = { to: string | null; at: Date };

/**
 * The hub's "this company moved to another install" (company-move-design.md 5.5) from a refused claim or standing
 * call, or null for any other refusal. Read off the error's fields (hub.ts HubError keeps the hub's answer), so this
 * file needn't import hub.ts.
 */
export function movedAnswer(e: unknown): MovedAway | null {
  const x = e as { hubError?: unknown; status?: unknown; detail?: Record<string, unknown> | null } | null;
  if (!x || typeof x !== "object" || x.hubError !== true || x.status !== 410 || x.detail?.moved !== true) return null;
  const at = typeof x.detail.at === "string" && !Number.isNaN(Date.parse(x.detail.at)) ? new Date(x.detail.at) : new Date();
  return { to: text(x.detail.to, 120), at };
}

/**
 * The hub says the company moved: this copy is the old one. It stays read-only (movingAt, set now if the move was made
 * without this copy's "Prepare the move file", as the hub admin's move by hand is), says where it went and when
 * (movedOutAt, movedTo: the hub's name for the new install), and may be deleted by hand 30 days on. Its move token, if
 * one is still kept, goes. Once written it isn't changed by a later answer.
 */
export async function applyMovedOut(shopId: string, m: MovedAway): Promise<void> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { movingAt: true, movedOutAt: true } });
  if (!shop || shop.movedOutAt) return;
  await db.$transaction([
    db.shop.update({ where: { id: shopId }, data: { movedOutAt: m.at, movingAt: shop.movingAt ?? m.at, ...(m.to ? { movedTo: m.to } : {}) } }),
    db.companyMove.updateMany({ where: { shopId, direction: "export", hubTokenSealed: { not: null } }, data: { hubTokenSealed: null } }),
  ]);
  console.info(`[move] ${JSON.stringify({ company: shopId, movedOut: m.at.toISOString(), to: m.to })}`);
}
