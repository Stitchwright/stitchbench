import "server-only";
// Settings → People: adding a login and taking one's access away or giving it back, for the actions in
// src/actions/settings.ts and the check scripts. Every company may have as many logins as it needs.
import bcrypt from "bcryptjs";
import type { Role } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { EMAIL_HELP, isValidEmail, normalizeEmail } from "@/lib/email";
import { str } from "@/lib/format";
import { actorOf, audit } from "@/lib/audit";
import type { CurrentUser } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/shops";
import { UserError } from "@/lib/user-error";

// The platform-admin logins run every company on the install (Companies): only their holder changes them.
const ADMIN_LOGIN = "That login belongs to the StitchBench administrator. Only they can change it.";
export function protectAdminLogin(target: { id: string; email: string }, admin: { id: string }) {
  if (isPlatformAdmin(target.email) && target.id !== admin.id) throw new UserError(ADMIN_LOGIN);
}

/** "Add person": a new login for the admin's company. */
export async function addPersonAs(admin: CurrentUser, formData: FormData): Promise<void> {
  const email = normalizeEmail(formData.get("email"));
  const name = str(formData.get("name"));
  // Kept exactly as typed: sign-in compares it untrimmed.
  const password = String(formData.get("password") ?? "");
  if (!email || !name || password.length < 8) throw new UserError("Enter a name, email and a temporary password of 8+ characters.");
  if (!isValidEmail(email)) throw new UserError(EMAIL_HELP);
  const existing = await db.user.findUnique({ where: { shopId_email: { shopId: admin.shopId, email } } });
  if (existing && !existing.active) throw new UserError(`${existing.name} is already in People with access removed: use Restore access.`);
  // Only inside this company: the same address may have a login in another one (round 3 W1).
  if (existing) throw new UserError("That email already has an account.");
  // The StitchBench administrator's address carries install-wide rights: nobody else may take it for a login.
  if (isPlatformAdmin(email) && !isPlatformAdmin(admin.email)) throw new UserError("That email is reserved on this StitchBench.");
  const role = (str(formData.get("role")) ?? "TECH") as Role;
  if (role !== "ADMIN" && role !== "TECH") throw new UserError("Pick admin or tech.");
  const created = await db.user.create({ data: { shopId: admin.shopId, email, name, role, passwordHash: await bcrypt.hash(password, 10) } });
  await audit(db, actorOf(admin), { action: "user.add", subjectType: "User", subjectId: created.id, subjectLabel: `${name} (${email})`, changes: { role: [null, role] } });
}

/** "Remove access" / "Restore access". */
export async function setPersonActiveAs(admin: CurrentUser, userId: string, active: boolean): Promise<void> {
  const u = await db.user.findFirst({ where: { id: userId, shopId: admin.shopId } });
  if (!u) throw new UserError("User not found.");
  protectAdminLogin(u, admin);
  if (u.role === "OWNER") throw new UserError("The owner account can't be switched off.");
  // Switching someone off also signs them out everywhere, at once.
  await db.user.update({ where: { id: userId }, data: { active, ...(active ? {} : { sessionVersion: { increment: 1 } }) } });
  if (u.active !== active) await audit(db, actorOf(admin), { action: "user.active", subjectType: "User", subjectId: u.id, subjectLabel: `${u.name} (${u.email})`, changes: { active: [u.active, active] } });
}
