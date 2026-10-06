import "server-only";
// The known-device cookie (round 3 M44). Wrong passwords for one login queue its tries and, past 20 waiting, refuse them
// all (src/lib/sign-in.ts), the right password too, so someone guessing at the owner's email every 30 seconds would keep
// the owner out. A browser that has signed in as that login before (or used a reset link for it) carries proof of it in
// this cookie, and its tries skip that login's queue and cap; it has a small failure count of its own instead
// (5 wrong in 15 minutes, then it is treated like any other browser). The per-address limit still applies to it.
//
// The cookie holds up to 10 entries, newest first, one per login signed in on this browser (a shared counter tablet has
// several): "<issued, base 36>.<mac>" joined by "~", where mac = the first 16 bytes of HMAC-SHA256 over the login's id, its
// sessionVersion and the issue time, keyed from AUTH_SECRET. An email can now have a login in several companies (round 3
// W1), so the entry is per login, not per email; key text v3 means every browser is unknown once after that release. No email is in it, and it opens nothing by itself: it never signs anyone in, only
// lets this browser's own tries at the password through while a flood is queued. An entry lasts 180 days from the last
// sign-in. The login's sessionVersion is in the mac, so a password change or reset (which bumps it) ends every device's
// standing at once; the browser the reset link was used in gets a fresh entry at the new version, so the owner can get
// back in during a flood. Changing AUTH_SECRET cancels them all. Without AUTH_SECRET it is simply off.
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { db } from "@/lib/db";

export const KNOWN_DEVICE_DAYS = 180;
const LIFE = KNOWN_DEVICE_DAYS * 86_400_000;
const SKEW = 5 * 60_000; // an entry "from the future" is refused beyond this (a server clock put right)
const MAX_ENTRIES = 10;

/** One cookie per program: the Windows program's AUTH_COOKIE_PREFIX, as src/auth.config.ts uses for the session. */
export function knownDeviceCookieName(): string {
  const own = (process.env.AUTH_COOKIE_PREFIX ?? "").replace(/[^a-z0-9]/gi, "");
  return own ? `${own}.known-device` : "known-device";
}

function key(): Buffer | null {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update("stitchbench known-device v3").digest();
}

function mac(k: Buffer, userId: string, t: number, sv: number): string {
  return crypto.createHmac("sha256", k).update(`${userId}\n${sv}\n${t}`).digest().subarray(0, 16).toString("base64url");
}

type Entry = { t: number; mac: string };

function entries(value: string | null | undefined): Entry[] {
  return (value ?? "")
    .split("~")
    .slice(0, MAX_ENTRIES)
    .flatMap((e) => {
      const m = /^([0-9a-z]{1,11})\.([A-Za-z0-9_-]{22})$/.exec(e);
      return m ? [{ t: parseInt(m[1], 36), mac: m[2] }] : [];
    });
}

const live = (e: Entry, now: number) => now - e.t <= LIFE && e.t <= now + SKEW;

/**
 * The entry of this cookie value that proves this browser signed in as the login `userId` in the last 180 days, as its
 * mac (which names the browser's own failure count), or null. `sv` is the login's sessionVersion.
 */
export function knownDeviceFor(value: string | null | undefined, userId: string, now = Date.now(), sv = 0): string | null {
  const k = key();
  if (!k || !userId) return null;
  for (const e of entries(value)) {
    if (!live(e, now)) continue;
    const want = Buffer.from(mac(k, userId, e.t, sv));
    const got = Buffer.from(e.mac);
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return e.mac;
  }
  return null;
}

/** The cookie value with a fresh entry for the login `userId` first: its older entry and expired ones dropped, 10 at most. Null without AUTH_SECRET. */
export function withKnownDevice(value: string | null | undefined, userId: string, now = Date.now(), sv = 0): string | null {
  const k = key();
  if (!k || !userId) return null;
  const mine = knownDeviceFor(value, userId, now, sv);
  const keep = entries(value).filter((e) => e.mac !== mine && live(e, now));
  return [{ t: now, mac: mac(k, userId, now, sv) }, ...keep]
    .slice(0, MAX_ENTRIES)
    .map((e) => `${e.t.toString(36)}.${e.mac}`)
    .join("~");
}

/** One cookie's value from a request's Cookie header (what Auth.js hands authorize()), or null. */
export function requestCookie(req: Request | Headers | undefined, name: string): string | null {
  const h = req instanceof Headers ? req : req?.headers;
  const raw = h?.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** This cookie's value from a request's Cookie header, or null. */
export function knownDeviceCookie(req: Request | Headers | undefined): string | null {
  return requestCookie(req, knownDeviceCookieName());
}

/**
 * After a right password (the sign-in page) or a reset link used (/reset): this browser is known for that login from now
 * on. Server actions only (it sets a cookie). httpOnly, SameSite=Lax, Secure when the request came over https.
 */
export async function rememberThisDevice(userId: unknown): Promise<void> {
  if (typeof userId !== "string" || !userId) return;
  const jar = await cookies();
  const name = knownDeviceCookieName();
  // The login's current sessionVersion (after a reset it is the new one), so a password change ends older entries.
  const sv = (await db.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } }))?.sessionVersion ?? 0;
  const value = withKnownDevice(jar.get(name)?.value, userId, Date.now(), sv);
  if (!value) return;
  const proto = (await headers()).get("x-forwarded-proto")?.split(",")[0]?.trim();
  jar.set(name, value, { httpOnly: true, sameSite: "lax", path: "/", secure: proto === "https", maxAge: KNOWN_DEVICE_DAYS * 86_400 });
}
