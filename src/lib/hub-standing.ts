import "server-only";
// What the hub says about a company's standing, written down (hub-accounts-billing-design.md 2.4 and 3.5). The words
// (standing, last day, message, the account's email) go to the Shop row for Settings → Account to show. Only the keys
// change what the program allows, and since 1.8 only two things: the Assistant, and the program itself
// (src/lib/modules.ts). The program's key is verified like a pasted one and kept as the company's single "hub" License
// row, replaced by the hub's next key; a key the hub revokes goes, and only if the hub issued it (never a pasted one).
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
  /**
   * Keys for add-on modules from the hub (the Assistant: its own subscription, module "assistant"; an older hub also
   * sold Vac Shop, Small Appliance Repair, Scheduling, Marketing and Maker Shop, alone or as the bundle's one key). Verified
   * like the base key and kept as hub rows of their own: the hub's newest replaces the older one, and the base key's
   * arrival never takes them away (nor theirs the base key). Only the Assistant's still counts; the trade modules' keys
   * are kept as the hub sent them and decide nothing (Settings → Features does).
   */
  moduleKeys?: string[] | null;
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
  await applyModuleKeys(shopId, a.moduleKeys);
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
    db.license.deleteMany({ where: { shopId, source: "hub", keyId: { not: keyId }, NOT: { keyId: { in: await moduleKeyIds(shopId) } } } }),
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

/**
 * The add-on modules the hub may send keys for (the hub's src/addons.mjs: the Assistant, and from an older hub Vac Shop,
 * Small Appliance Repair, Scheduling, Marketing and Maker Shop, each alone or all five in the bundle's one key).
 */
const ADDON_MODULES = ["assistant", "vac", "appliance", "scheduling", "marketing", "maker"] as const;

/** A hub-issued key that is an add-on's (carries an add-on module and not "base"), as opposed to the program's own. */
function isModuleOnly(key: string, shopId: string): { keyId: string } | null {
  const v = verifyFor(key, "pasted");
  if (!v.ok || v.payload.s !== shopId || v.payload.m.includes("base")) return null;
  if (!v.payload.m.some((m) => (ADDON_MODULES as readonly string[]).includes(m))) return null;
  return { keyId: v.payload.id };
}

/** The key ids of this company's hub rows that are add-on keys (the base key's replacement must leave them). */
async function moduleKeyIds(shopId: string): Promise<string[]> {
  const rows = await db.license.findMany({ where: { shopId, source: "hub" }, select: { key: true } });
  return rows.flatMap((r) => isModuleOnly(r.key, shopId)?.keyId ?? []);
}

/**
 * The add-on keys the hub sent (moduleKeys): each must verify, be for this company and carry the module. The newest
 * replaces an older hub add-on key; none sent leaves what is stored (an ended subscription's key runs out on its own last
 * day plus grace, like the base key's). Only rows the hub issued are ever replaced.
 */
async function applyModuleKeys(shopId: string, sent: string[] | null | undefined): Promise<void> {
  if (!Array.isArray(sent)) return;
  const good = sent
    .filter((k): k is string => typeof k === "string")
    // The Assistant's, up to four single add-ons (the hub's MAX_SINGLES) or the bundle, and the hub admin's comp key.
    .slice(0, 8)
    .flatMap((k) => {
      const m = isModuleOnly(k.trim(), shopId);
      return m ? [{ keyId: m.keyId, key: k.trim() }] : [];
    });
  if (!good.length) {
    if (sent.length) console.error(`community hub: an add-on key it sent for company ${shopId} isn't usable here`);
    return;
  }
  const keep = good.map((g) => g.keyId);
  const old = await moduleKeyIds(shopId);
  const stale = old.filter((id) => !keep.includes(id));
  await db.$transaction([
    ...(stale.length ? [db.license.deleteMany({ where: { shopId, source: "hub", keyId: { in: stale } } })] : []),
    ...good.map((g) => db.license.upsert({ where: { shopId_keyId: { shopId, keyId: g.keyId } }, create: { shopId, keyId: g.keyId, key: g.key, source: "hub", addedBy: "StitchHub" }, update: { key: g.key, source: "hub" } })),
  ]);
}
