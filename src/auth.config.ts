import type { NextAuthConfig } from "next-auth";

// Edge-safe auth config shared by the proxy and the full auth setup.
// Do NOT import bcrypt or the Prisma client here.
export const authConfig = {
  // Self-hosted (Railway / local): trust the Host header the platform's proxy sets.
  trustHost: true,
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const path = nextUrl.pathname;
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
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        if (token.id) session.user.id = token.id as string;
        if (token.role) session.user.role = token.role;
        if (token.shopId) session.user.shopId = token.shopId as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
