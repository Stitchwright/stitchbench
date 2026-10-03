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
export const TRAY_WORDS = "On the Windows program, a password is reset on the shop PC: right-click the program's icon by the clock and choose Reset a password.";

export const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** An origin from a variable: https, or http for this machine (tests); nothing but scheme, host and port. */
function origin(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  try {
    const u = new URL(text);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * This service's own address, for the links it mails or hands out. Never taken from a request (a forged Host header
 * would send an owner a link to someone else's site): APP_URL, else PUBLIC_URL when it is the app itself (not a separate
 * links-only address), else Railway's public domain.
 */
export function appBaseUrl(): string | null {
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  return origin(process.env.APP_URL) ?? (process.env.PUBLIC_LINKS_ONLY === "true" ? null : origin(process.env.PUBLIC_URL)) ?? (railway ? origin(`https://${railway}`) : null);
}

/** Why "Forgot your password?" can't mail a link here, or null when it can. */
export function resetByEmailProblem(): string | null {
  if (isDesktop()) return TRAY_WORDS;
  const mail = platformMailProblem();
  if (mail) return mail;
  if (!appBaseUrl()) return "This server doesn't know its own address for the link: set APP_URL (https://your-site).";
  return null;
}

/** A new link for the login: every older link it had stops working. */
export async function issueResetLink(userId: string, kind: "reset" | "setup" | "admin", hours: number): Promise<{ link: string; expiresAt: Date }> {
  const base = appBaseUrl();
  if (!base) throw new UserError("This server doesn't know its own address for the link: set APP_URL (https://your-site).");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + hours * HOUR);
  await db.$transaction([
    db.passwordReset.updateMany({ where: { userId, kind: { in: LINK_KINDS }, usedAt: null }, data: { usedAt: new Date() } }),
    db.passwordReset.create({ data: { userId, tokenHash: tokenHash(token), kind, expiresAt } }),
  ]);
  return { link: `${base}/reset?t=${token}`, expiresAt };
}

/**
 * "Forgot your password?": the answer is the same whether or not the address has a login, and is given before anything
 * is looked up; `work` (the lookup, the link and the mail) carries on after it. Limits: 10 requests an hour from one
 * address (where the proxy reports it), 3 emails an hour to one login (more are dropped quietly: same answer), 300 an
 * hour on the whole server.
 */
export function requestResetFor(emailRaw: unknown, ip: string | null): { message: string; work: Promise<void> } {
  if (isDesktop()) throw new UserError(TRAY_WORDS);
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
    const user = await db.user.findUnique({ where: { email }, select: { id: true, name: true, active: true, shop: { select: { name: true } } } });
    if (!user || !user.active) return;
    const { link } = await issueResetLink(user.id, "reset", RESET_HOURS);
    const app = appName();
    await sendPlatformMail({
      to: email,
      subject: `Reset your ${app} password`,
      text: `Hello ${user.name},\n\nSomeone asked to reset the password of ${email} on ${app} (${user.shop.name}). If that was you, choose a new one here; the link works once, for ${RESET_HOURS} hour:\n\n${link}\n\nIf it wasn't you, ignore this email: your password hasn't changed.\n\n${app}`,
    });
    console.info(`[password] reset link mailed for login ${user.id}`);
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

/**
 * Uses the link: the new password is set, every device signed in as that login signs in again (sessionVersion + 1), and
 * every other link it had stops working. The link is taken under the row's own update, so two tries at once can't both
 * use it.
 */
export async function finishReset(token: unknown, password: unknown, again: unknown): Promise<{ email: string }> {
  if (isDesktop()) throw new UserError(TRAY_WORDS);
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
    return { email: user.email };
  });
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
  const { link } = await issueResetLink(owner.id, "admin", RESET_HOURS);
  console.info(`[password] reset link made for the owner of company ${shopId} by the administrator`);
  return link;
}
