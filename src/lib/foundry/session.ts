import "server-only";
// A browser signed in with a Foundry Account (docs/plan.md FA-2). The browser holds a random value in an httpOnly cookie;
// the table keeps its sha256 and the account service's session token, sealed. The token can spend the account's Foundry
// credits, so it is only ever read here, on the server, to make a request for the signed-in person (FA-4), and it is
// never put in a page, a log or an error. Which StitchBench login the browser is signed in as is still Auth.js' business;
// this only says "and this browser also holds a live Foundry session for account N".
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { db } from "@/lib/db";
import { seal, unseal } from "@/lib/messaging/secrets";
import { signOut as cloudSignOut } from "./cloud";

/** Same life as the sign-in cookie (Auth.js' default, 30 days). The account service's own token lasts 90 days unused. */
export const SESSION_DAYS = 30;
const SEAL_SHOP = "foundry"; // the seal is bound to a shop id and a field; this token belongs to no company

const hash = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

/** The cookie's name; the Windows program's AUTH_COOKIE_PREFIX as the other sign-in cookies do (the switch is off there). */
export function foundryCookieName(): string {
  const own = (process.env.AUTH_COOKIE_PREFIX ?? "").replace(/[^a-z0-9]/gi, "");
  return own ? `${own}.foundry-session` : "foundry-session";
}

/** The sealed token in the table; returns the random value the browser's cookie will hold (the table keeps only its hash). */
export async function storeFoundrySession(token: string, foundryId: number): Promise<string> {
  const id = crypto.randomBytes(24).toString("base64url");
  const idHash = hash(id);
  const now = Date.now();
  await db.foundrySession.deleteMany({ where: { expiresAt: { lt: new Date(now) } } }); // tidy as we go
  await db.foundrySession.create({
    data: { idHash, foundryId, token: seal(token, SEAL_SHOP, `foundryToken:${idHash}`), expiresAt: new Date(now + SESSION_DAYS * 86_400_000) },
  });
  return id;
}

/** Records a sign-in at the service: the sealed token in the table, the cookie in this browser. Call from a server action. */
export async function startFoundrySession(token: string, foundryId: number): Promise<void> {
  const id = await storeFoundrySession(token, foundryId);
  const proto = (await headers()).get("x-forwarded-proto")?.split(",")[0]?.trim();
  (await cookies()).set(foundryCookieName(), id, { httpOnly: true, sameSite: "lax", path: "/", secure: proto === "https", maxAge: SESSION_DAYS * 86_400 });
}

export type FoundrySessionInfo = { idHash: string; foundryId: number };

/** The live Foundry session this browser holds, or null (no cookie, unknown, or past its life). */
export async function currentFoundrySession(): Promise<FoundrySessionInfo | null> {
  const id = (await cookies()).get(foundryCookieName())?.value;
  if (!id || id.length > 200) return null;
  const row = await db.foundrySession.findUnique({ where: { idHash: hash(id) }, select: { idHash: true, foundryId: true, expiresAt: true } });
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  return { idHash: row.idHash, foundryId: row.foundryId };
}

/** The service's token for a live session, for a request made on that person's behalf; null if it can't be opened. */
export async function foundryTokenOf(s: Pick<FoundrySessionInfo, "idHash">): Promise<string | null> {
  const row = await db.foundrySession.findUnique({ where: { idHash: s.idHash }, select: { token: true } });
  return unseal(row?.token ?? null, SEAL_SHOP, `foundryToken:${s.idHash}`)?.plain ?? null;
}

/**
 * Signing out of Foundry in this browser: the service's session ends (best effort: offline is fine, the row is gone
 * either way), the row is deleted and the cookie cleared. Call from a server action or route handler.
 */
export async function endFoundrySession(): Promise<void> {
  const jar = await cookies();
  const id = jar.get(foundryCookieName())?.value;
  if (!id || id.length > 200) return;
  const idHash = hash(id);
  const row = await db.foundrySession.findUnique({ where: { idHash }, select: { token: true } });
  await db.foundrySession.deleteMany({ where: { idHash } });
  jar.delete(foundryCookieName());
  const token = unseal(row?.token ?? null, SEAL_SHOP, `foundryToken:${idHash}`)?.plain;
  if (token) {
    try {
      await cloudSignOut(token);
    } catch {
      // The service couldn't be reached or had already ended it; our copy is gone, which is what matters here.
    }
  }
}
