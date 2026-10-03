import "server-only";
// Settings → Account (hub-accounts-billing-design.md 2.2): a company's StitchHub account, started from here with the
// owner's email (door 1), or an existing account connected with a link code (door 2); the standing the hub last gave;
// the reset opt-in. The action wrappers are src/actions/account.ts. Owners only (and the StitchBench administrator on a
// shared hosted install).
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { EMAIL_HELP, isValidEmail, normalizeEmail } from "@/lib/email";
import { str } from "@/lib/format";
import { adoptInstall, claimShopNow, formerInstall, hubDefaultUrl, hubFetch, hubReachable, hubRequest, hubState, hubStatus, syncHub } from "@/lib/hub";
import { applyStanding, type StandingAnswer } from "@/lib/hub-standing";
import type { ModuleState } from "@/lib/module-info";
import { getModules, isDesktop } from "@/lib/modules";
import type { CurrentUser } from "@/lib/session";
import { appName, isPlatformAdmin, programVersion, shopKindOf } from "@/lib/shops";

/**
 * The version of the hub's terms and privacy page this program names when it starts an account. The hub keeps its own
 * (settings.terms_version) and shows "we updated our terms" when a newer one is published (package terms-launch).
 */
export const TERMS_VERSION = "2026-10-02-draft";

/** Days after a company was made before Settings → Account nags a shop that never connected (decision 2). */
export const NAG_AFTER_DAYS = 60;

/** The owner of this company, or the StitchBench administrator (who may act for any company on a shared install). */
export function requireAccountOwner(user: CurrentUser) {
  if (user.role === "OWNER" || (user.role !== "TECH" && isPlatformAdmin(user.email))) return user;
  throw new UserError("Only the shop owner can change this company's StitchHub account.");
}

type StartAnswer = StandingAnswer & { ok?: boolean; shop?: StandingAnswer; installId?: string; installKey?: string; hubName?: string; scope?: string };

/** The hub's refusals in words for the page: 409 and 503 (hub-accounts-billing-design.md 2.2), the rest as they came. */
function explain(e: unknown): never {
  const status = hubStatus(e);
  const msg = e instanceof Error ? e.message : String(e);
  if (status === 503) throw new UserError(`StitchHub can't send account emails yet (${msg}). Ask the hub admin, or try again later.`);
  if (status === 409) throw new UserError(msg);
  throw e;
}

async function companyBody(shopId: string) {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true, doesRepair: true, sellsRetail: true } });
  if (!shop) throw new UserError("Company not found.");
  return { shop, body: { shopRef: shop.id, shopName: shop.name, kind: shopKindOf(shop), program: appName(), version: programVersion() } };
}

/**
 * Door 1: start the company's StitchHub account with the owner's email; the hub mails a link to set a password. Sent
 * again for the same unfinished account, the hub mails the link again ("Send it again"). An install on no hub yet
 * joins the community's hub this way (no join key): its install is "pending" until the email is opened, then a member.
 */
export async function startHubAccountFor(user: CurrentUser, fd: FormData): Promise<void> {
  requireAccountOwner(user);
  const email = normalizeEmail(fd.get("email"));
  if (!email || !isValidEmail(email)) throw new UserError(EMAIL_HELP);
  if (str(fd.get("terms")) !== "on") throw new UserError("Tick the box to accept the terms and the privacy policy.");
  const { shop, body } = await companyBody(user.shopId);
  const start = { ...body, email, termsVersion: TERMS_VERSION };
  const s = await hubState();
  let answer: StartAnswer;
  if (s?.url && s.installKey) {
    answer = await (async () => (await (await hubFetch("/v1/accounts/start", { method: "POST", json: start, shopRef: shop.id })).json()) as StartAnswer)().catch(explain);
  } else {
    // Joining a hub changes the whole install: the one company's owner, or the StitchBench administrator (the same rule
    // as requireInstallAdmin in session.ts, which this file doesn't import: the check scripts run outside Next).
    if (!isPlatformAdmin(user.email) && (await db.shop.count()) > 1) throw new UserError("Several companies share this program, so only its administrator can connect it to StitchHub.");
    const base = hubDefaultUrl();
    // Back on the hub this install left, while it still knows the install: the same install again, so what it had
    // there stays its own. Otherwise the account start gets it a new install there (scope "pending").
    const oldKey = s?.formerUrl === base ? s.formerInstallKey : null;
    const former = oldKey ? await formerInstall(base, oldKey) : null;
    if (former && oldKey) {
      answer = await hubRequest<StartAnswer>(base, "/v1/accounts/start", { json: start, key: oldKey, shopRef: shop.id }).catch(explain);
      await adoptInstall({ url: base, hubName: former.hubName, installId: former.installId, installKey: oldKey, scope: former.scope });
    } else {
      answer = await hubRequest<StartAnswer>(base, "/v1/accounts/start", { json: { ...start, contact: email }, shopRef: shop.id }).catch(explain);
      if (!answer.installId || !answer.installKey)
        throw new UserError("The hub started the account but gave this program no install key. Join the hub with an invite (Settings → Community hub), then try again.");
      await adoptInstall({ url: base, hubName: answer.hubName ?? null, installId: answer.installId, installKey: answer.installKey, scope: "pending" });
    }
  }
  await db.shop.update({ where: { id: shop.id }, data: { termsVersion: TERMS_VERSION } });
  const st = answer.shop ?? {};
  await applyStanding(shop.id, {
    account: answer.account ?? { email, verified: false },
    standing: st.standing,
    lastDay: st.lastDay,
    message: st.message,
    key: st.key ?? answer.key ?? null,
    revokeKeyIds: st.revokeKeyIds ?? answer.revokeKeyIds ?? [],
  });
  // Every company claims itself on the new connection; nobody waits for it.
  syncHub().catch(() => undefined);
}

/**
 * Door 2: a code the owner types in on the hub under "Connect a shop", good for 15 minutes. The hub needs the install
 * key for this, so an install on no hub yet starts with door 1 (which joins) or an invite.
 */
export async function linkCodeFor(user: CurrentUser): Promise<{ code: string; expiresAt: string; hubUrl: string }> {
  requireAccountOwner(user);
  const s = await hubState();
  if (!s?.url || !s.installKey) {
    throw new UserError(
      "This program isn't connected to StitchHub yet. Create the account from here with your email (the hub connects as part of it), or join the hub with an invite under Settings → Community hub first.",
    );
  }
  const { body } = await companyBody(user.shopId);
  try {
    const r = (await (await hubFetch("/v1/accounts/link-code", { method: "POST", json: body, shopRef: user.shopId })).json()) as { code?: string; expiresAt?: string };
    if (typeof r.code !== "string" || !r.code) throw new UserError("The hub answered without a code. Try again.");
    return { code: r.code, expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : new Date(Date.now() + 15 * 60_000).toISOString(), hubUrl: s.url };
  } catch (e) {
    if (hubStatus(e) === 409) {
      // Already connected: the page didn't know yet. Learn the standing now, then say so.
      await claimShopNow(user.shopId).catch(() => undefined);
      throw new UserError("This company is already connected to a StitchHub account. The page shows it now.");
    }
    return explain(e);
  }
}

/** Ask the hub again now ("Check again"): the same claim the sync sends, with its standing and key. */
export async function refreshStandingFor(user: CurrentUser): Promise<void> {
  requireAccountOwner(user);
  const s = await hubState();
  if (!s?.url || !s.installKey) throw new UserError("This program isn't connected to StitchHub yet.");
  await hubReachable();
  try {
    await claimShopNow(user.shopId);
  } catch (e) {
    if (hubStatus(e) === 404) throw new UserError("This hub doesn't keep shop accounts yet (it needs updating). Nothing changes here.");
    throw e;
  }
}

/** The owner allows (or stops allowing) a password reset from their StitchHub account. Windows program only; stored here, used by a later package. */
export async function setResetOptInFor(user: CurrentUser, on: boolean): Promise<void> {
  requireAccountOwner(user);
  if (!isDesktop()) throw new UserError("A reset from the StitchHub account is for the Windows program; the hosted version resets by email.");
  await db.shop.update({ where: { id: user.shopId }, data: { hubResetOptIn: on === true } });
}

/** A link code the page was just sent to (door 2), while it is still good and looks like one; else null. */
export function linkCodeShown(code: string | undefined, until: string | undefined): { code: string; until: Date } | null {
  if (!code || !until || !/^[A-Z0-9-]{10,12}$/.test(code)) return null;
  const at = new Date(until);
  return Number.isNaN(at.getTime()) || at.getTime() <= Date.now() ? null : { code, until: at };
}

export type AccountView = {
  shop: {
    id: string;
    name: string;
    createdAt: Date;
    timeZone: string;
    hubAccountEmail: string | null;
    hubAccountVerified: boolean;
    hubStanding: string | null;
    hubStandingAt: Date | null;
    hubStandingUntil: string | null;
    hubStandingNote: string | null;
    hubResetOptIn: boolean;
    termsVersion: string | null;
  };
  base: ModuleState;
  /** The hub this install is on (or would join): for the terms links and the "sign in on the hub" link. */
  hubUrl: string;
  hubName: string | null;
  connected: boolean;
  scope: "member" | "partner" | "pending" | null;
  /** Never connected to any hub and never heard a standing: the shop runs on its own (decision 2). */
  neverConnected: boolean;
  /** Days since the company was made, for the nag after NAG_AFTER_DAYS. */
  ageDays: number;
  ownerEmail: string;
  mayManage: boolean;
  desktop: boolean;
};

/** Everything Settings → Account shows for the signed-in user's company. */
export async function accountView(user: CurrentUser): Promise<AccountView> {
  const [shop, s, modules] = await Promise.all([
    db.shop.findUnique({
      where: { id: user.shopId },
      select: {
        id: true,
        name: true,
        createdAt: true,
        timeZone: true,
        hubAccountEmail: true,
        hubAccountVerified: true,
        hubStanding: true,
        hubStandingAt: true,
        hubStandingUntil: true,
        hubStandingNote: true,
        hubResetOptIn: true,
        termsVersion: true,
      },
    }),
    hubState(),
    getModules(user.shopId),
  ]);
  if (!shop) throw new UserError("Company not found.");
  const connected = Boolean(s?.url && s.installKey);
  const owner = await db.user.findFirst({ where: { shopId: shop.id, role: "OWNER", active: true }, orderBy: { createdAt: "asc" }, select: { email: true } });
  let mayManage = true;
  try {
    requireAccountOwner(user);
  } catch {
    mayManage = false;
  }
  return {
    shop,
    base: modules.states.base,
    hubUrl: (connected && s?.url) || hubDefaultUrl(),
    hubName: s?.hubName ?? null,
    connected,
    scope: connected ? (s?.scope === "partner" || s?.scope === "pending" ? s.scope : "member") : null,
    neverConnected: !connected && !shop.hubStandingAt,
    ageDays: Math.floor((Date.now() - shop.createdAt.getTime()) / 86_400_000),
    ownerEmail: owner?.email ?? user.email,
    mayManage,
    desktop: isDesktop(),
  };
}
