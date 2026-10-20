import "server-only";
// Settings → People: adding a login and taking one's access away or giving it back, for the actions in
// src/actions/settings.ts and the check scripts. On the Solo plan a third active login, new or restored, is refused
// (src/lib/plan.ts); taking access away is always allowed.
import bcrypt from "bcryptjs";
import type { Role } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { EMAIL_HELP, isValidEmail, normalizeEmail } from "@/lib/email";
import { str } from "@/lib/format";
import { foundrySignInMode } from "@/lib/foundry/switches";
import { unusablePasswordHash } from "@/lib/foundry/unusable";
import { issueResetLink, SETUP_HOURS } from "@/lib/password-reset";
import { withLoginRoom } from "@/lib/plan";
import { actorOf, audit } from "@/lib/audit";
import type { CurrentUser } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/shops";
import { UserError } from "@/lib/user-error";

// The platform-admin logins control paid access (Companies): only their holder changes them.
const ADMIN_LOGIN = "That login belongs to the StitchBench administrator. Only they can change it.";
export function protectAdminLogin(target: { id: string; email: string }, admin: { id: string }) {
  if (isPlatformAdmin(target.email) && target.id !== admin.id) throw new UserError(ADMIN_LOGIN);
}

/**
 * "Add person": a new login for the admin's company (Solo: refused past two people signed in). With FOUNDRY_SIGNIN=only there is
 * no password to give (docs/plan.md FA-5): the login is made with one nobody knows and the admin gets a one-time link, good
 * for 24 hours, that links the person's own Foundry Account the first time they use it.
 */
export async function addPersonAs(admin: CurrentUser, formData: FormData): Promise<{ link: string } | void> {
  const only = foundrySignInMode() === "only";
  const email = normalizeEmail(formData.get("email"));
  const name = str(formData.get("name"));
  // Kept exactly as typed: sign-in compares it untrimmed.
  const password = String(formData.get("password") ?? "");
  if (!email || !name || (!only && password.length < 8)) throw new UserError(only ? "Enter a name and an email." : "Enter a name, email and a temporary password of 8+ characters.");
  if (!isValidEmail(email)) throw new UserError(EMAIL_HELP);
  const existing = await db.user.findUnique({ where: { shopId_email: { shopId: admin.shopId, email } } });
  if (existing && !existing.active) throw new UserError(`${existing.name} is already in People with access removed: use Restore access.`);
  // Only inside this company: the same address may have a login in another one (round 3 W1).
  if (existing) throw new UserError("That email already has an account.");
  // The StitchBench administrator's address carries install-wide rights: nobody else may take it for a login.
  if (isPlatformAdmin(email) && !isPlatformAdmin(admin.email)) throw new UserError("That email is reserved on this StitchBench.");
  const role = (str(formData.get("role")) ?? "TECH") as Role;
  if (role !== "ADMIN" && role !== "TECH") throw new UserError("Pick admin or tech.");
  const data = { shopId: admin.shopId, email, name, role, passwordHash: only ? await unusablePasswordHash() : await bcrypt.hash(password, 10) };
  // The administrator's own login isn't one of the shop's people: it never needs room.
  const created = isPlatformAdmin(email) ? await db.user.create({ data }) : await withLoginRoom(admin.shopId, (tx) => tx.user.create({ data }));
  await audit(db, actorOf(admin), { action: "user.add", subjectType: "User", subjectId: created.id, subjectLabel: `${name} (${email})`, changes: { role: [null, role] } });
  if (only) return { link: (await issueResetLink(created.id, "setup", SETUP_HOURS)).link };
}

/**
 * FOUNDRY_SIGNIN=only: "Reset password" becomes "Make a sign-in link" (docs/plan.md FA-5). The person's Foundry Account link is
 * cleared and their sessions end, so the link can attach a different account if they lost the old one; the link works once, for
 * 24 hours. Owners are not reset by their admins (the platform administrator makes an owner's link, Companies).
 */
export async function staffSignInLinkAs(admin: CurrentUser, userId: string): Promise<string> {
  const u = await db.user.findFirst({ where: { id: userId, shopId: admin.shopId } });
  if (!u) throw new UserError("User not found.");
  if (u.id === admin.id) throw new UserError("You can't make a link for yourself: sign in with your Foundry Account.");
  protectAdminLogin(u, admin);
  if (u.role === "OWNER") throw new UserError("Only the StitchBench administrator can make the owner a link.");
  if (!u.active) throw new UserError(`${u.name} has no access: restore access first.`);
  await db.user.update({ where: { id: u.id }, data: { foundryId: null, sessionVersion: { increment: 1 } } });
  const { link } = await issueResetLink(u.id, "admin", SETUP_HOURS);
  await audit(db, actorOf(admin), { action: "user.password_reset", subjectType: "User", subjectId: u.id, subjectLabel: `${u.name} (${u.email})`, reason: "sign-in link made" });
  return link;
}

/** "Remove access" / "Restore access". Restoring counts as adding a login on Solo. */
export async function setPersonActiveAs(admin: CurrentUser, userId: string, active: boolean): Promise<void> {
  const u = await db.user.findFirst({ where: { id: userId, shopId: admin.shopId } });
  if (!u) throw new UserError("User not found.");
  protectAdminLogin(u, admin);
  if (u.role === "OWNER") throw new UserError("The owner account can't be switched off.");
  // Switching someone off also signs them out everywhere, at once.
  const data = { active, ...(active ? {} : { sessionVersion: { increment: 1 } }) };
  if (active && !u.active && !isPlatformAdmin(u.email)) await withLoginRoom(admin.shopId, (tx) => tx.user.update({ where: { id: userId }, data }));
  else await db.user.update({ where: { id: userId }, data });
  if (u.active !== active) await audit(db, actorOf(admin), { action: "user.active", subjectType: "User", subjectId: u.id, subjectLabel: `${u.name} (${u.email})`, changes: { active: [u.active, active] } });
}
