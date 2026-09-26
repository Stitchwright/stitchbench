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

// Wrong passwords slow down: 10 per email and 50 per network address in 15 minutes, then wait. (In memory: a restart
// forgets, which is fine for a shop PC or one hosted server.)
const WINDOW = 15 * 60_000;
const failures = new Map<string, { n: number; since: number }>();

function tooMany(key: string, limit: number) {
  const f = failures.get(key);
  if (!f || Date.now() - f.since > WINDOW) return false;
  return f.n >= limit;
}

function fail(key: string) {
  const f = failures.get(key);
  if (!f || Date.now() - f.since > WINDOW) failures.set(key, { n: 1, since: Date.now() });
  else f.n += 1;
  if (failures.size > 10_000) failures.clear();
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
        const ip = request?.headers?.get("x-forwarded-for")?.split(",")[0].trim() || "local";
        if (tooMany(`e:${email}`, 10) || tooMany(`i:${ip}`, 50)) return null;
        const user = await db.user.findUnique({ where: { email } });
        const ok = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
        if (!user || !user.active || !ok) {
          fail(`e:${email}`);
          fail(`i:${ip}`);
          return null;
        }
        failures.delete(`e:${email}`);
        return { id: user.id, email: user.email, name: user.name, role: user.role, shopId: user.shopId, sv: user.sessionVersion };
      },
    }),
  ],
});
