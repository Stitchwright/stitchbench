import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { checkSignIn } from "@/lib/sign-in";
import { authConfig } from "@/auth.config";

// The password check, its limits (per account, per known browser, per address) and why: src/lib/sign-in.ts.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      authorize: (credentials, request) => checkSignIn(credentials, request),
    }),
  ],
});
