import "server-only";
// Settings → Account (hub-accounts-billing-design.md 2.2): a company's StitchHub account, started from here with the
// owner's email (door 1), or an existing account connected with a link code (door 2); the standing the hub last gave;
// the reset opt-in. The action wrappers are src/actions/account.ts. Owners only (and the StitchBench administrator on a
// shared hosted install).
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { EMAIL_HELP, isValidEmail, normalizeEmail } from "@/lib/email";
import { str } from "@/lib/format";
import { adoptInstall, checkHubUrl, claimShopNow, formerInstall, hubDefaultUrl, hubFetch, hubReachable, hubRequest, hubState, hubStatus, syncHub } from "@/lib/hub";
import { applyStanding, type StandingAnswer } from "@/lib/hub-standing";
import type { ModuleState } from "@/lib/module-info";
import { getModules, isDesktop } from "@/lib/modules";
import { activeLogins, companyPlan, type CompanyPlan } from "@/lib/plan";
import type { CurrentUser } from "@/lib/session";
import { appName, isPlatformAdmin, programVersion, shopKindOf } from "@/lib/shops";
import { compareTermsVersions, validTermsVersion } from "@/lib/terms-version";

/**
 * The version of the hub's Terms of Service and Privacy Policy this program falls back on when the hub doesn't say (an
 * older hub, or out of reach). The version shown and sent is the hub's own, from GET /v1/terms/current (hubTermsVersion),
 * so a new version needs no program release (package terms-launch).
 */
export const TERMS_VERSION = "2026-10-03-draft";

const TERMS_FRESH_MS = 10 * 60_000; // the hub's answer is good for 10 minutes
const TERMS_RETRY_MS = 60_000; // no answer: asked again after a minute, the last answer (or TERMS_VERSION) meanwhile
const termsCache = ((globalThis as unknown as { __hubTerms?: Map<string, { version: string; until: number }> }).__hubTerms ??= new Map());

/**
 * The terms version in force on the hub at `base` (the tick in Settings → Account names it, and the account start sends
 * it): GET /v1/terms/current, kept for 10 minutes; TERMS_VERSION when the hub doesn't answer with one.
 */
export async function hubTermsVersion(base: string): Promise<string> {
  let url: string;
  try {
    url = checkHubUrl(base);
  } catch {
    return TERMS_VERSION;
  }
  const had = termsCache.get(url);
  if (had && had.until > Date.now()) return had.version;
  let version: string | null = null;
  try {
    const r = await fetch(`${url}/v1/terms/current`, { redirect: "manual", signal: AbortSignal.timeout(2500) });
    if (!r.ok) await r.body?.cancel().catch(() => undefined);
    const v = r.ok ? ((await r.json()) as { version?: unknown } | null)?.version : undefined;
    if (validTermsVersion(v)) version = v;
  } catch {
    version = null;
  }
  const answer = version ?? had?.version ?? TERMS_VERSION;
  termsCache.set(url, { version: answer, until: Date.now() + (version ? TERMS_FRESH_MS : TERMS_RETRY_MS) });
  return answer;
}

/** The account accepted an older version than the hub's (or one that isn't a version): the hub asks it to accept again. */
export function termsBehind(accepted: string | null | undefined, current: string): boolean {
  return Boolean(accepted) && compareTermsVersions(accepted, current) < 0;
}

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
  const s = await hubState();
  // The version the page showed next to the tick; else the one in force on the hub the account starts on.
  const shown = str(fd.get("termsVersion"));
  const termsVersion = validTermsVersion(shown) ? shown : await hubTermsVersion(s?.url && s.installKey ? s.url : hubDefaultUrl());
  const start = { ...body, email, termsVersion };
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
  await db.shop.update({ where: { id: shop.id }, data: { termsVersion } });
  const st = answer.shop ?? {};
  await applyStanding(shop.id, {
    account: answer.account ?? { email, verified: false },
    standing: st.standing,
    lastDay: st.lastDay,
    message: st.message,
    key: st.key ?? answer.key ?? null,
    revokeKeyIds: st.revokeKeyIds ?? answer.revokeKeyIds ?? [],
    moduleKeys: st.moduleKeys ?? answer.moduleKeys ?? null,
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

/**
 * The owner allows (or stops allowing) a password reset from their StitchHub account. Windows program only. Stored here
 * (a hub can't switch it on); the hub learns it from the claim, sent now so its account page offers the reset (or stops
 * offering it) at once (src/lib/hub-reset-grants.ts). The page waits a few seconds for that at most; the sync repeats it.
 */
export async function setResetOptInFor(user: CurrentUser, on: boolean): Promise<void> {
  requireAccountOwner(user);
  if (!isDesktop()) throw new UserError("A reset from the StitchHub account is for the Windows program; the hosted version resets by email.");
  await db.shop.update({ where: { id: user.shopId }, data: { hubResetOptIn: on === true } });
  const s = await hubState();
  if (!s?.url || !s.installKey) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([claimShopNow(user.shopId).catch(() => undefined), new Promise((r) => (timer = setTimeout(r, 4000)))]);
  clearTimeout(timer);
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
  /** The login plan the program's key names (Solo or Shop; null: none named, no limit), and the active logins now. */
  plan: CompanyPlan | null;
  logins: number;
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
  /** The hub's terms version in force (for the tick), and whether the account accepted an older one. */
  terms: { current: string; behind: boolean };
};

/** Everything Settings → Account shows for the signed-in user's company. */
export async function accountView(user: CurrentUser): Promise<AccountView> {
  const [shop, s, modules, plan, logins] = await Promise.all([
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
    companyPlan(user.shopId),
    activeLogins(user.shopId),
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
  const hubUrl = (connected && s?.url) || hubDefaultUrl();
  const current = await hubTermsVersion(hubUrl);
  return {
    shop,
    base: modules.states.base,
    plan,
    logins,
    hubUrl,
    hubName: s?.hubName ?? null,
    connected,
    scope: connected ? (s?.scope === "partner" || s?.scope === "pending" ? s.scope : "member") : null,
    neverConnected: !connected && !shop.hubStandingAt,
    ageDays: Math.floor((Date.now() - shop.createdAt.getTime()) / 86_400_000),
    ownerEmail: owner?.email ?? user.email,
    mayManage,
    desktop: isDesktop(),
    terms: { current, behind: Boolean(shop.hubAccountEmail) && termsBehind(shop.termsVersion, current) },
  };
}
