import NextAuth from "next-auth";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { authConfig } from "@/auth.config";
import { linksHostDecision } from "@/lib/links-host";

const { auth } = NextAuth(authConfig);
const authProxy = auth as unknown as (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined>;

// The public links address (PUBLIC_URL with PUBLIC_LINKS_ONLY=true: a tunnel on the Windows program, or a separate links
// domain on the hosted app) serves only the customer pages: estimate approval, unsubscribe, their API routes and static
// files. Everything else there, server actions included, is 404 whatever the path (scheduling-messaging-design.md 14.2).
const linksHost = (() => {
  try {
    return process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).host.toLowerCase() : null;
  } catch {
    return null;
  }
})();

// Next 16: the file convention is `proxy.ts` (formerly middleware).
export default async function proxy(req: NextRequest, ev: NextFetchEvent) {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (process.env.PUBLIC_LINKS_ONLY === "true" && linksHost && host === linksHost) {
    return linksHostDecision(req.method, req.nextUrl.pathname, req.headers) === "pass" ? NextResponse.next() : new NextResponse("Not found", { status: 404 });
  }
  // API routes check their own session, as before.
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();
  return authProxy(req, ev);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico|woff2?|mjs)$).*)"],
};
