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
import { knownDeviceCookie, knownDeviceFor } from "@/lib/known-device";
import type { Role } from "@/generated/prisma/enums";

// The same email rule accounts are made with (lib/email): a stricter check here locked out logins like owner@myshop.
const credentialsSchema = z.object({
  email: z.string().transform(normalizeEmail).refine(isValidEmail),
  password: z.string().min(1),
});

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

// Compared against when the email isn't known, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export type SignedIn = { id: string; email: string; name: string; role: Role; shopId: string; sv: number };

async function passwordOk(email: string, password: string): Promise<SignedIn | null> {
  const user = await db.user.findUnique({ where: { email } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.active || !ok) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role, shopId: user.shopId, sv: user.sessionVersion };
}

/** Auth.js' authorize(): the login for these credentials, or null (wrong, unknown, switched off, or held back by a limit). */
export async function checkSignIn(credentials: unknown, request: Request | undefined): Promise<SignedIn | null> {
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success) return null;
  const { email, password } = parsed.data;
  const ip = clientAddress(request);
  if (ip && count(`i:${ip}`) >= PER_ADDRESS) return null;

  // A browser this login signed in on before: its own count, not the account's queue.
  const cookie = knownDeviceCookie(request);
  const sv = cookie ? ((await db.user.findUnique({ where: { email }, select: { sessionVersion: true } }))?.sessionVersion ?? 0) : 0;
  const device = knownDeviceFor(cookie, email, Date.now(), sv);
  if (device && count(`d:${device}`) < PER_DEVICE) {
    const keys = ip ? [`d:${device}`, `i:${ip}`] : [`d:${device}`];
    for (const k of keys) begin(k);
    try {
      const user = await passwordOk(email, password);
      if (!user) {
        for (const k of keys) fail(k);
        return null;
      }
      // The account's own count stays: whoever is guessing at it elsewhere gets no fresh start from the owner's sign-in.
      state.failures.delete(`d:${device}`);
      return user;
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
      const user = await passwordOk(email, password);
      if (!user) {
        for (const k of keys) fail(k);
        return null;
      }
      state.failures.delete(`e:${email}`);
      return user;
    });
  } finally {
    for (const k of keys) end(k);
  }
}

/**
 * Signing out (the sidebar's Sign out, round 3 L42, decided 30 Sep 2026): every session of this login ends, on every
 * device, not just this browser's cookie, so a copy of the cookie (a shared tablet, the shop Wi-Fi) stops working too.
 */
export async function endEverySession(userId: string): Promise<void> {
  await db.user.updateMany({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
}
