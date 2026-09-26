import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { authConfig } from "@/auth.config";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Wrong passwords slow sign-in down, without letting anyone lock an owner out by guessing at their email:
// - per account: after 5 wrong in 15 minutes, tries are taken one at a time and each waits longer (up to 30 s), but
//   the right password still works;
// - per network address, only where a proxy we trust reports it (TRUST_PROXY=true on Railway; a shop PC has no proxy
//   and a device could claim any address): 50 wrong in 15 minutes, then refused.
// In memory: a restart forgets, which is fine for a shop PC or one hosted server.
const WINDOW = 15 * 60_000;
const MAX_KEYS = 50_000;
const failures = new Map<string, { n: number; since: number }>();

function count(key: string) {
  const f = failures.get(key);
  return !f || Date.now() - f.since > WINDOW ? 0 : f.n;
}

function fail(key: string) {
  const f = failures.get(key);
  const fresh = !f || Date.now() - f.since > WINDOW;
  failures.delete(key); // re-added last: when the map is full, the keys that failed longest ago go first
  failures.set(key, fresh ? { n: 1, since: Date.now() } : { n: f.n + 1, since: f.since });
  for (const k of failures.keys()) {
    if (failures.size <= MAX_KEYS) break;
    failures.delete(k);
  }
}

/** The address the attempt came from, as the proxy in front of us saw it (its own entry is the last one). */
function clientAddress(request?: Request) {
  if (process.env.TRUST_PROXY !== "true") return null;
  const hops = request?.headers?.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  return hops.at(-1) ?? null;
}

const waiting = new Map<string, { tail: Promise<unknown>; n: number }>();

/** Once an account is being guessed at, its tries run one at a time, each after a growing wait. */
async function paced<T>(email: string, fn: () => Promise<T>): Promise<T | null> {
  const n = count(`e:${email}`);
  if (n < 5) return fn();
  const q = waiting.get(email) ?? { tail: Promise.resolve(), n: 0 };
  if (q.n >= 20) return null; // a flood: the queue is already long enough
  const wait = Math.min(30_000, 1000 * 2 ** (n - 5));
  const run = q.tail.catch(() => {}).then(() => new Promise((r) => setTimeout(r, wait))).then(fn);
  q.tail = run;
  q.n++;
  waiting.set(email, q);
  try {
    return await run;
  } finally {
    if (--q.n === 0) waiting.delete(email);
  }
}

// Compared against when the email isn't known, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      async authorize(credentials, request) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;
        const email = parsed.data.email.toLowerCase();
        const ip = clientAddress(request);
        if (ip && count(`i:${ip}`) >= 50) return null;
        return paced(email, async () => {
          const user = await db.user.findUnique({ where: { email } });
          const ok = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
          if (!user || !user.active || !ok) {
            fail(`e:${email}`);
            if (ip) fail(`i:${ip}`);
            return null;
          }
          failures.delete(`e:${email}`);
          return { id: user.id, email: user.email, name: user.name, role: user.role, shopId: user.shopId, sv: user.sessionVersion };
        });
      },
    }),
  ],
});
