import type { NextAuthConfig } from "next-auth";

// Browsers keep one set of cookies per host, whatever the port: StitchBench (:3100) and StitchShop (:3110) on one shop PC
// would overwrite each other's sign-in and be sent each other's. The Windows program passes AUTH_COOKIE_PREFIX (its own
// name), so each program has cookies of its own. Unset (hosted, tests): Auth.js' usual names. The program serves plain
// http, so no Secure flag.
const own = (process.env.AUTH_COOKIE_PREFIX ?? "").replace(/[^a-z0-9]/gi, "");
const ownCookie = (name: string) => ({ name: `${own}.${name}`, options: { httpOnly: true, sameSite: "lax" as const, path: "/", secure: false } });

// Edge-safe auth config shared by the proxy and the full auth setup.
// Do NOT import bcrypt or the Prisma client here.
export const authConfig = {
  // Self-hosted (Railway / local): trust the Host header the platform's proxy sets.
  trustHost: true,
  ...(own ? { cookies: { sessionToken: ownCookie("session-token"), callbackUrl: ownCookie("callback-url"), csrfToken: ownCookie("csrf-token") } } : {}),
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const path = nextUrl.pathname;
      // Customers' own pages (unsubscribe, estimate approval): no session, and no redirect for someone signed in.
      if (path.startsWith("/u/") || path.startsWith("/e/") || path.startsWith("/book/") || path.startsWith("/shop/")) return true;
      if (path.startsWith("/login") || path.startsWith("/signup")) {
        if (isLoggedIn) return Response.redirect(new URL("/", nextUrl));
        return true;
      }
      return isLoggedIn;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id ?? token.id;
        if ("role" in user && user.role) token.role = user.role;
        if ("shopId" in user && user.shopId) token.shopId = user.shopId;
        if ("sv" in user && typeof user.sv === "number") token.sv = user.sv;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        if (token.id) session.user.id = token.id as string;
        if (token.role) session.user.role = token.role;
        if (token.shopId) session.user.shopId = token.shopId as string;
        session.user.sv = typeof token.sv === "number" ? token.sv : 0;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
