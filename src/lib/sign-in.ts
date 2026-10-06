import "server-only";
// Checking a password at sign-in (Auth.js' authorize(), src/auth.ts), here so the check script can drive it
// (scripts/checks/signin.check.ts). Wrong passwords slow sign-in down, without letting anyone lock an owner out by
// guessing at their email:
// - per account: after 5 wrong in 15 minutes, tries are taken one at a time and each waits longer (up to 30 s); past 20
//   waiting, more are refused, the right password included;
// - per browser that signed in as that login before (src/lib/known-device.ts, round 3 M44): its tries skip the account's
//   queue and cap, so a flood of guesses can't keep the owner out of their own browser; 5 wrong from it in 15 minutes and
//   it is paced like any other;
// - per network address, only where a proxy we trust reports it (TRUST_PROXY=true on Railway; a shop PC has no proxy
//   and a device could claim any address): 50 wrong in 15 minutes, then refused. A known browser too.
// A count is kept until 15 minutes pass with no wrong try (not 15 minutes from the first), so steady guessing never gets
// a fresh start. In memory, on globalThis: the sign-in page's action and Auth.js' own /api/auth route are separate
// bundles and must share one count (a restart forgets, which is fine for a shop PC or one hosted server).
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { clientAddress } from "@/lib/client-ip";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import { knownDeviceCookie, knownDeviceFor, requestCookie } from "@/lib/known-device";
import { choiceCookieName, readTicket, spendTicket } from "@/lib/sign-in-ticket";
import type { Role } from "@/generated/prisma/enums";

// The same email rule accounts are made with (lib/email): a stricter check here locked out logins like owner@myshop.
const credentialsSchema = z.object({
  email: z.string().transform(normalizeEmail).refine(isValidEmail),
  password: z.string().min(1),
});
// "Choose a company" (src/lib/sign-in-ticket.ts): the ticket a right password earned, and the login picked from it.
const ticketSchema = z.object({ ticket: z.string().min(1), userId: z.string().min(1) });

export const WINDOW = 15 * 60_000;
export const FREE_TRIES = 5;
export const QUEUE_CAP = 20;
export const PER_DEVICE = 5;
export const PER_ADDRESS = 50;
const MAX_KEYS = 50_000;

type State = {
  failures: Map<string, { n: number; last: number }>;
  /** Tries still being checked (the password compare takes a moment). They count from the moment they start, so a
   * burst sent all at once can't slip past the limits together before the first one has been written down as wrong. */
  underWay: Map<string, number>;
  waiting: Map<string, { tail: Promise<unknown>; n: number }>;
};
const state: State = ((globalThis as unknown as { __signIn?: State }).__signIn ??= { failures: new Map(), underWay: new Map(), waiting: new Map() });

function count(key: string) {
  const f = state.failures.get(key);
  return (!f || Date.now() - f.last > WINDOW ? 0 : f.n) + (state.underWay.get(key) ?? 0);
}

function begin(key: string) {
  state.underWay.set(key, (state.underWay.get(key) ?? 0) + 1);
}

function end(key: string) {
  const n = (state.underWay.get(key) ?? 1) - 1;
  if (n > 0) state.underWay.set(key, n);
  else state.underWay.delete(key);
}

function fail(key: string) {
  const f = state.failures.get(key);
  const fresh = !f || Date.now() - f.last > WINDOW;
  state.failures.delete(key); // re-added last: when the map is full, the keys that failed longest ago go first
  state.failures.set(key, { n: fresh ? 1 : f.n + 1, last: Date.now() });
  for (const k of state.failures.keys()) {
    if (state.failures.size <= MAX_KEYS) break;
    state.failures.delete(k);
  }
}

/** Once an account is being guessed at (`n` tries wrong or under way), its tries run one at a time, each after a growing wait. */
async function paced<T>(email: string, n: number, fn: () => Promise<T>): Promise<T | null> {
  if (n < FREE_TRIES) return fn();
  const q = state.waiting.get(email) ?? { tail: Promise.resolve(), n: 0 };
  if (q.n >= QUEUE_CAP) return null; // a flood: the queue is already long enough
  const wait = Math.min(30_000, 1000 * 2 ** (n - FREE_TRIES));
  const run = q.tail
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, wait)))
    .then(fn);
  q.tail = run;
  q.n++;
  state.waiting.set(email, q);
  try {
    return await run;
  } finally {
    if (--q.n === 0) state.waiting.delete(email);
  }
}

// Compared against when there are fewer logins than this, so one login and three cost the same (a fourth adds a compare).
const PAD_TO = 3;
// Compared against when the email isn't known, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export type SignedIn = { id: string; email: string; name: string; role: Role; shopId: string; sv: number };
/** A login the password fit, with its company's name (only ever shown after a right password). */
export type Matched = SignedIn & { shopName: string };

type Login = Matched & { hash: string; active: boolean };

/** Every login with this email (an email is unique inside one company, so there can be several). */
async function loginsFor(email: string): Promise<Login[]> {
  const rows = await db.user.findMany({ where: { email }, include: { shop: { select: { name: true } } }, orderBy: { createdAt: "asc" } });
  return rows.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, shopId: u.shopId, sv: u.sessionVersion, shopName: u.shop.name, hash: u.passwordHash, active: u.active }));
}

/** The active logins the password fits. Always at least PAD_TO bcrypt compares, so unknown, one and several cost the same. */
async function passwordMatches(logins: Login[], password: string): Promise<Matched[]> {
  const hashes = logins.map((l) => (l.active ? l.hash : DUMMY_HASH));
  while (hashes.length < PAD_TO) hashes.push(DUMMY_HASH);
  const out: Matched[] = [];
  for (let i = 0; i < hashes.length; i++) {
    const ok = await bcrypt.compare(password, hashes[i]);
    const l = logins[i];
    if (ok && l && l.active) out.push({ id: l.id, email: l.email, name: l.name, role: l.role, shopId: l.shopId, sv: l.sv, shopName: l.shopName });
  }
  return out;
}

/**
 * The password check with its limits. The logins the password fits: none (null), one, or several (the page then asks
 * which company: src/app/login/page.tsx). Limits are kept per email as before, however many logins it has; one try is one
 * try, not one per login compared.
 */
export async function signInStep(credentials: unknown, request: Request | Headers | undefined): Promise<Matched[] | null> {
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success) return null;
  const { email, password } = parsed.data;
  const ip = clientAddress(request);
  if (ip && count(`i:${ip}`) >= PER_ADDRESS) return null;

  const logins = await loginsFor(email);
  const run = async (): Promise<Matched[] | null> => {
    const found = await passwordMatches(logins, password);
    return found.length ? found : null;
  };

  // A browser one of these logins signed in on before: its own count, not the account's queue.
  const cookie = knownDeviceCookie(request);
  const now = Date.now();
  let device: string | null = null;
  if (cookie) for (const l of logins) device ??= knownDeviceFor(cookie, l.id, now, l.sv);
  if (device && count(`d:${device}`) < PER_DEVICE) {
    const keys = ip ? [`d:${device}`, `i:${ip}`] : [`d:${device}`];
    for (const k of keys) begin(k);
    try {
      const found = await run();
      if (!found) {
        for (const k of keys) fail(k);
        return null;
      }
      // The account's own count stays: whoever is guessing at it elsewhere gets no fresh start from the owner's sign-in.
      state.failures.delete(`d:${device}`);
      return found;
    } finally {
      for (const k of keys) end(k);
    }
  }

  // Counted, and this try marked as under way, before anything is awaited: no other try can slip in between.
  const n = count(`e:${email}`);
  const keys = ip ? [`e:${email}`, `i:${ip}`] : [`e:${email}`];
  for (const k of keys) begin(k);
  try {
    return await paced(email, n, async () => {
      const found = await run();
      if (!found) {
        for (const k of keys) fail(k);
        return null;
      }
      state.failures.delete(`e:${email}`);
      return found;
    });
  } finally {
    for (const k of keys) end(k);
  }
}

/**
 * A ticket a right password earned (src/lib/sign-in-ticket.ts) and the login picked from it: that login, only when the
 * ticket is genuine, fresh, unused, this browser's, lists the login, and the login is still active at the same
 * sessionVersion (a reset or sign-out since ends it). Used up even when the login fails the last checks.
 */
async function redeemTicket(credentials: unknown, request: Request | Headers | undefined): Promise<SignedIn | null> {
  const parsed = ticketSchema.safeParse(credentials);
  if (!parsed.success) return null;
  const p = readTicket(parsed.data.ticket, requestCookie(request, choiceCookieName()));
  const entry = p?.l.find((e) => e[0] === parsed.data.userId);
  if (!p || !entry || !spendTicket(p)) return null;
  const u = await db.user.findUnique({ where: { id: entry[0] } });
  if (!u || !u.active || u.sessionVersion !== entry[1]) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, shopId: u.shopId, sv: u.sessionVersion };
}

/**
 * Auth.js' authorize(): the login for these credentials, or null (wrong, unknown, switched off, held back by a limit, or
 * the password fits more than one company: only the sign-in page's "Choose a company" step signs in then). Either
 * { email, password }, which signs in only when exactly one login fits, or { ticket, userId }.
 */
export async function checkSignIn(credentials: unknown, request: Request | undefined): Promise<SignedIn | null> {
  if (credentials && typeof credentials === "object" && "ticket" in credentials) return redeemTicket(credentials, request);
  const found = await signInStep(credentials, request);
  if (!found || found.length !== 1) return null;
  const { shopName: _shop, ...login } = found[0];
  void _shop;
  return login;
}

/**
 * Signing out (the sidebar's Sign out, round 3 L42, decided 30 Sep 2026): every session of this login ends, on every
 * device, not just this browser's cookie, so a copy of the cookie (a shared tablet, the shop Wi-Fi) stops working too.
 */
export async function endEverySession(userId: string): Promise<void> {
  await db.user.updateMany({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
}
