// The tray's "Reset a password..." (hub-accounts-billing-design.md 4.3.3): on the shop PC itself, with no email and no
// internet, the person at the PC picks one of the program's logins, gets a new 12-character password shown once on this
// screen, and every device signed in as that login is signed out (sessionVersion). Nothing here needs Electron, so the
// tests in test/reset-password.test.mjs run it against a scratch database.
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";

// No 0/O, 1/l/I: the password is read off one screen and typed on another.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PASSWORD_LENGTH = 12;
export const MAX_LISTED = 9; // the dialog is a message box: nine logins and Cancel fit on it

/** A fresh password of `length` characters from ALPHABET, each picked without bias. */
export function newPassword(length = PASSWORD_LENGTH) {
  let out = "";
  while (out.length < length) {
    // Rejection sampling: a byte over the largest multiple of the alphabet's size would favour its first letters.
    const limit = 256 - (256 % ALPHABET.length);
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < limit) out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * The program's logins, owners first, then admins, then techs, each with its company's name (an install may hold
 * several). Only active logins: a deactivated one is reactivated in the program's Settings by an owner.
 */
export async function listLogins(pool) {
  const r = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, s.name AS shop
       FROM "User" u JOIN "Shop" s ON s.id = u."shopId"
      WHERE u.active
      ORDER BY s.name, CASE u.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END, u.name`,
  );
  return r.rows;
}

/** One line per login for the dialog: "Pat Smith (pat@shop.com), owner". With several companies the company is named too. */
export function describeLogin(l, severalShops) {
  return `${l.name} (${l.email}), ${String(l.role).toLowerCase()}${severalShops ? `, ${l.shop}` : ""}`;
}

/**
 * Sets the login's password hash and signs every device out of it (sessionVersion + 1, which src/lib/session.ts checks on
 * every request). Returns true when the login was there.
 */
export async function setPassword(pool, userId, passwordHash) {
  const r = await pool.query(`UPDATE "User" SET "passwordHash" = $2, "sessionVersion" = "sessionVersion" + 1 WHERE id = $1`, [userId, passwordHash]);
  return r.rowCount === 1;
}

/**
 * bcryptjs from the packaged server's own modules (desktop/server/node_modules, unpacked at the first start), so the
 * tray hashes exactly as the program does (src/lib/shops.ts: bcrypt, 10 rounds). Throws a plain message when it isn't there.
 */
export function loadBcrypt(appDir) {
  try {
    const req = createRequire(path.join(appDir, "package.json"));
    return req("bcryptjs");
  } catch {
    throw new Error("The server's modules aren't unpacked yet. Start the program once, then try again.");
  }
}

/** A new password for the login, set and returned (shown once by the caller). */
export async function resetLogin(pool, bcrypt, userId) {
  const password = newPassword();
  const hash = await bcrypt.hash(password, 10);
  if (!(await setPassword(pool, userId, hash))) throw new Error("That login isn't there any more.");
  return password;
}
