import "server-only";
// Settings → People: adding a login and taking one's access away or giving it back, for the actions in
// src/actions/settings.ts and the check scripts. On the Solo plan a third active login, new or restored, is refused
// (src/lib/plan.ts); taking access away is always allowed.
import bcrypt from "bcryptjs";
import type { Role } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { EMAIL_HELP, isValidEmail, normalizeEmail } from "@/lib/email";
import { str } from "@/lib/format";
import { withLoginRoom } from "@/lib/plan";
import type { CurrentUser } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/shops";
import { UserError } from "@/lib/user-error";

// The platform-admin logins control paid access (Companies): only their holder changes them.
const ADMIN_LOGIN = "That login belongs to the StitchBench administrator. Only they can change it.";
export function protectAdminLogin(target: { id: string; email: string }, admin: { id: string }) {
  if (isPlatformAdmin(target.email) && target.id !== admin.id) throw new UserError(ADMIN_LOGIN);
}

/** "Add person": a new login for the admin's company (Solo: refused past two people signed in). */
export async function addPersonAs(admin: CurrentUser, formData: FormData): Promise<void> {
  const email = normalizeEmail(formData.get("email"));
  const name = str(formData.get("name"));
  // Kept exactly as typed: sign-in compares it untrimmed.
  const password = String(formData.get("password") ?? "");
  if (!email || !name || password.length < 8) throw new UserError("Enter a name, email and a temporary password of 8+ characters.");
  if (!isValidEmail(email)) throw new UserError(EMAIL_HELP);
  const existing = await db.user.findUnique({ where: { email } });
  if (existing?.shopId === admin.shopId && !existing.active) throw new UserError(`${existing.name} is already in People with access removed: use Restore access.`);
  if (existing) throw new UserError("That email already has an account.");
  // The StitchBench administrator's address carries install-wide rights: nobody else may take it for a login.
  if (isPlatformAdmin(email) && !isPlatformAdmin(admin.email)) throw new UserError("That email is reserved on this StitchBench.");
  const role = (str(formData.get("role")) ?? "TECH") as Role;
  if (role !== "ADMIN" && role !== "TECH") throw new UserError("Pick admin or tech.");
  const data = { shopId: admin.shopId, email, name, role, passwordHash: await bcrypt.hash(password, 10) };
  // The administrator's own login isn't one of the shop's people: it never needs room.
  if (isPlatformAdmin(email)) await db.user.create({ data });
  else await withLoginRoom(admin.shopId, (tx) => tx.user.create({ data }));
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
}
