import "server-only";
// Password links on the hosted service (hub-accounts-billing-design.md 4.3.2 and 4.4, package hosted-provisioning):
//   - "Forgot your password?" on /login: a link by email (PLATFORM_SMTP_URL), one use, one hour; the same answer whether
//     or not the address has a login, and the mail goes out after the answer, so the time taken says nothing either;
//   - a company started from StitchHub: its owner chooses a first password through a link the hub shows once (24 hours);
//   - the StitchBench administrator's "Reset link" on Companies, for an owner, when mail isn't set up (or as well).
// Every link is /reset?t=<token>; only the token's sha256 is kept (PasswordReset). Using one sets the password, ends every
// session of that login (sessionVersion + 1) and cancels every other link it had. Never on the Windows program: it resets
// from the tray (desktop/reset-password.mjs) or, opted in, from the StitchHub account (src/lib/hub-reset-grants.ts).
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { EMAIL_HELP, isValidEmail, normalizeEmail } from "@/lib/email";
import { appBaseUrl } from "@/lib/app-origin";
import { foundrySignInMode } from "@/lib/foundry/switches";
import { isDesktop } from "@/lib/modules";
import { allow } from "@/lib/rate-limit";
import { platformMailProblem, sendPlatformMail } from "@/lib/platform-mail";
import { appName, isPlatformAdmin } from "@/lib/shops";
import type { CurrentUser } from "@/lib/session";

export const RESET_HOURS = 1;
export const SETUP_HOURS = 24;
const HOUR = 3600_000;
/** Kinds that are links someone follows (the hub grants are kept in the same table but are not links). */
const LINK_KINDS = ["reset", "setup", "admin"];

export const SAME_ANSWER = "If that address has a login here, the email is on its way. The link in it works once, for an hour.";
/** FOUNDRY_SIGNIN=only: there is no local password to reset (docs/plan.md FA-5). */
export const ONLY_WORDS = "Sign-in here is with your Foundry Account, so there is no password to reset. If you forgot your Foundry Account's password, use “Forgot your password?” on the sign-in page.";
export const TRAY_WORDS = "On the Windows program, a password is reset on the shop PC: right-click the program's icon by the clock and choose Reset a password.";

export const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export { appBaseUrl };

/** Why "Forgot your password?" can't mail a link here, or null when it can. */
export function resetByEmailProblem(): string | null {
  if (isDesktop()) return TRAY_WORDS;
  if (foundrySignInMode() === "only") return ONLY_WORDS;
  const mail = platformMailProblem();
  if (mail) return mail;
  if (!appBaseUrl()) return "This server doesn't know its own address for the link: set APP_URL (https://your-site).";
  return null;
}

/**
 * A new link for the login: the older links it had stop working, except that a reset the person asked for themselves only
 * replaces their own older reset links (it must not kill an administrator's link or a 24-hour setup link).
 */
export async function issueResetLink(userId: string, kind: "reset" | "setup" | "admin", hours: number): Promise<{ link: string; token: string; expiresAt: Date }> {
  const base = appBaseUrl();
  if (!base) throw new UserError("This server doesn't know its own address for the link: set APP_URL (https://your-site).");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + hours * HOUR);
  await db.$transaction([
    db.passwordReset.updateMany({ where: { userId, kind: kind === "reset" ? "reset" : { in: LINK_KINDS }, usedAt: null }, data: { usedAt: new Date() } }),
    db.passwordReset.create({ data: { userId, tokenHash: tokenHash(token), kind, expiresAt } }),
  ]);
  // FOUNDRY_SIGNIN=only: a setup or administrator's link proves the login so it can link a Foundry Account; there is no password to set.
  const path = foundrySignInMode() === "only" && kind !== "reset" ? "/login/link" : "/reset";
  return { link: `${base}${path}?t=${token}`, token, expiresAt };
}

/** A company's name on one plain line (another company's admin chose it): no line breaks, control characters or web addresses, 80 characters at most. */
const plain = (name: string) => name.replace(/(?:https?|ftp):\/\/\S*/gi, "").replace(/\p{C}|\p{Zl}|\p{Zp}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "(no name)";

/** The reset mail's words: one login (the usual case), or one link per company when the address has logins in several. */
export function resetMailText(app: string, email: string, items: { company: string; name: string; link: string }[]): string {
  if (items.length === 1) {
    const [i] = items;
    return `Hello ${plain(i.name)},\n\nSomeone asked to reset the password of ${email} on ${app} (${plain(i.company)}). If that was you, choose a new one here; the link works once, for ${RESET_HOURS} hour:\n\n${i.link}\n\nIf it wasn't you, ignore this email: your password hasn't changed.\n\n${app}`;
  }
  const list = items.map((i) => `${plain(i.company)}\n${i.link}`).join("\n\n");
  return `Hello,\n\nSomeone asked to reset the password of ${email} on ${app}. This address has a login in ${items.length} companies, each with its own password and its own link. Each link works once, for ${RESET_HOURS} hour, and changes only the login of the company named above it:\n\n${list}\n\nChoose only the link for the company you asked for. A company's name is chosen by that company, not by ${app}. If it wasn't you, ignore this email: no password has changed.\n\n${app}`;
}

/**
 * "Forgot your password?": the answer is the same whether or not the address has a login, and is given before anything
 * is looked up; `work` (the lookup, the link and the mail) carries on after it. Limits: 10 requests an hour from one
 * address (where the proxy reports it), 3 emails an hour to one address, however many logins it has (more are dropped quietly: same answer), 300 an
 * hour on the whole server.
 */
export function requestResetFor(emailRaw: unknown, ip: string | null): { message: string; work: Promise<void> } {
  if (isDesktop()) throw new UserError(TRAY_WORDS);
  if (foundrySignInMode() === "only") throw new UserError(ONLY_WORDS);
  const problem = resetByEmailProblem();
  if (problem) {
    console.error(`[password] a reset was asked for, but: ${problem}`);
    throw new UserError(
      `This server can't email a reset link yet. Ask the ${appName()} administrator, who can make you one from the Companies page. Staff: your shop's owner or an admin can set a new password in Settings → People.`,
    );
  }
  const email = normalizeEmail(emailRaw);
  if (!email || !isValidEmail(email)) throw new UserError(EMAIL_HELP);
  if (ip && !allow(`pwreset:ip:${ip}`, 10, HOUR)) throw new UserError("Too many reset requests from here. Wait an hour, then try again.");
  if (!allow("pwreset:all", 300, HOUR)) throw new UserError("Too many reset requests on this server right now. Try again in an hour.");
  if (!allow(`pwreset:e:${email}`, 3, HOUR)) return { message: SAME_ANSWER, work: Promise.resolve() };
  const work = (async () => {
    // An email can have a login in several companies (round 3 W1): one link per login, one mail naming each company. Each
    // link resets only its own login, so no company's owner gets the power to change another company's login.
    const users = await db.user.findMany({ where: { email, active: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, shop: { select: { name: true } } } });
    if (!users.length) return;
    const app = appName();
    const items: { company: string; name: string; link: string }[] = [];
    for (const u of users) items.push({ company: u.shop.name, name: u.name, link: (await issueResetLink(u.id, "reset", RESET_HOURS)).link });
    const one = items.length === 1;
    const text = resetMailText(app, email, items);
    await sendPlatformMail({ to: email, subject: `Reset your ${app} password`, text });
    console.info(`[password] reset ${one ? "link" : `links (${items.length})`} mailed for ${users.map((u) => `login ${u.id}`).join(", ")}`);
  })().catch((e) => console.error(`[password] reset mail: ${e instanceof Error ? e.message : String(e)}`));
  return { message: SAME_ANSWER, work };
}

export type LinkState = { ok: true; email: string; name: string; kind: string; expiresAt: Date } | { ok: false; reason: string };

/** What a link is, without using it: for the page to show the form, or why not. */
export async function checkResetLink(token: unknown): Promise<LinkState> {
  if (isDesktop()) return { ok: false, reason: TRAY_WORDS };
  const t = typeof token === "string" ? token.trim() : "";
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(t)) return { ok: false, reason: "That link isn't right. Ask for a new one." };
  const row = await db.passwordReset.findUnique({ where: { tokenHash: tokenHash(t) }, include: { user: { select: { email: true, name: true, active: true } } } });
  if (!row || !LINK_KINDS.includes(row.kind) || !row.user.active) return { ok: false, reason: "That link isn't right. Ask for a new one." };
  if (row.usedAt) return { ok: false, reason: "That link was used already, or a newer one replaced it. Ask for a new one." };
  if (row.expiresAt <= new Date()) return { ok: false, reason: "That link has expired. Ask for a new one." };
  return { ok: true, email: row.user.email, name: row.user.name, kind: row.kind, expiresAt: row.expiresAt };
}

export type LinkTokenState = { ok: true; rowId: string; userId: string; sv: number; email: string; name: string } | { ok: false; reason: string };

/**
 * A setup or administrator's link as proof of who a login is, for linking a Foundry Account without an old password
 * (docs/plan.md FA-5). Not a "reset" link (that one only proves an email address was reachable once, and in `only` none is
 * sent). Not used up here: linkFoundryAccount takes it, in the same transaction that writes the link.
 */
export async function checkLinkToken(token: unknown): Promise<LinkTokenState> {
  if (isDesktop()) return { ok: false, reason: TRAY_WORDS };
  const t = typeof token === "string" ? token.trim() : "";
  const bad = "That link isn't right. Ask for a new one.";
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(t)) return { ok: false, reason: bad };
  const row = await db.passwordReset.findUnique({ where: { tokenHash: tokenHash(t) }, include: { user: { select: { id: true, email: true, name: true, active: true, sessionVersion: true } } } });
  if (!row || (row.kind !== "setup" && row.kind !== "admin") || !row.user.active) return { ok: false, reason: bad };
  if (row.usedAt) return { ok: false, reason: "That link was used already, or a newer one replaced it. Ask for a new one." };
  if (row.expiresAt <= new Date()) return { ok: false, reason: "That link has expired. Ask for a new one." };
  return { ok: true, rowId: row.id, userId: row.user.id, sv: row.user.sessionVersion, email: row.user.email, name: row.user.name };
}

/**
 * Uses the link: the new password is set, every device signed in as that login signs in again (sessionVersion + 1), and
 * every other link it had stops working. The link is taken under the row's own update, so two tries at once can't both
 * use it.
 */
export async function finishReset(token: unknown, password: unknown, again: unknown): Promise<{ email: string; userId: string }> {
  if (isDesktop()) throw new UserError(TRAY_WORDS);
  if (foundrySignInMode() === "only") throw new UserError(ONLY_WORDS);
  const pw = typeof password === "string" ? password : "";
  if (pw.length < 8) throw new UserError("Use at least 8 characters.");
  if (pw.length > 200) throw new UserError("That password is too long (200 characters at most).");
  if (pw !== again) throw new UserError("The two passwords aren't the same.");
  const state = await checkResetLink(token);
  if (!state.ok) throw new UserError(state.reason);
  const hash = await bcrypt.hash(pw, 10);
  const th = tokenHash(String(token).trim());
  return db.$transaction(async (tx) => {
    const now = new Date();
    const row = await tx.passwordReset.findUnique({ where: { tokenHash: th }, select: { id: true, userId: true } });
    const took = row ? await tx.passwordReset.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } }) : { count: 0 };
    if (!row || took.count !== 1) throw new UserError("That link was used already, or a newer one replaced it. Ask for a new one.");
    const user = await tx.user.update({ where: { id: row.userId }, data: { passwordHash: hash, sessionVersion: { increment: 1 } }, select: { id: true, email: true } });
    await tx.passwordReset.updateMany({ where: { userId: row.userId, kind: { in: LINK_KINDS }, usedAt: null }, data: { usedAt: now } });
    console.info(`[password] new password set from a link for login ${user.id}`);
    return { email: user.email, userId: user.id };
  });
}

/** A first-sign-in link for a company's owner, just made (FOUNDRY_SIGNIN=only): it links the owner's Foundry Account; 24 hours, one use. */
export async function ownerSetupLink(shopId: string, email: string): Promise<{ link: string; token: string }> {
  const owner = await db.user.findUnique({ where: { shopId_email: { shopId, email: normalizeEmail(email) } }, select: { id: true } });
  if (!owner) throw new UserError("That company has no owner login.");
  const { link, token } = await issueResetLink(owner.id, "setup", SETUP_HOURS);
  return { link, token };
}

/**
 * The StitchBench administrator's "Reset link" for a company's owner (Companies): one hour, one use, shown once to the
 * administrator to pass on. Hosted only; the Windows program has the tray.
 */
export async function ownerResetLinkFor(admin: CurrentUser, shopId: string): Promise<string> {
  if (!isPlatformAdmin(admin.email)) throw new UserError("Only the StitchBench administrator can do this.");
  if (isDesktop()) throw new UserError(TRAY_WORDS);
  const owner = await db.user.findFirst({ where: { shopId, role: "OWNER", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!owner) throw new UserError("That company has no owner login.");
  // FOUNDRY_SIGNIN=only: the link can attach a different Foundry Account (an owner who lost theirs), so the old attachment is cleared
  // and the owner's sessions end; the link itself is the proof, and the administrator is who makes it.
  const only = foundrySignInMode() === "only";
  if (only) await db.user.update({ where: { id: owner.id }, data: { foundryId: null, sessionVersion: { increment: 1 } } });
  const { link } = await issueResetLink(owner.id, "admin", only ? SETUP_HOURS : RESET_HOURS);
  console.info(`[password] reset link made for the owner of company ${shopId} by the administrator`);
  return link;
}
