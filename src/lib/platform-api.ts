import "server-only";
// POST /api/platform/companies (hub-accounts-billing-design.md 4.4, package hosted-provisioning): StitchHub's "Start a
// hosted StitchShop / StitchBench" makes a company on this shared hosted service for a verified hub account. The hub
// sends Authorization: Bearer PLATFORM_API_TOKEN (a variable on both sides). The answer is the company's id, this
// install's place on the hub (so the hub ties the new company to the account at once and the company's first claim
// finds it there), and a link for the owner to choose a first password (24 hours, one use): never a password.
//
// The route exists only on a hosted service with a token of 32+ characters (404 otherwise, the Windows program never).
// Over https only (the token travels in a header): the proxy's X-Forwarded-Proto or the request's own scheme, or plain
// http to this machine for tests (secureRequest, as the move routes); the hub also refuses to call an http address.
// The token is compared in constant time; wrong ones are limited per address (10 an hour) and across the server (200 an
// hour), and the companies made are capped at 30 an hour, so a leaked token can't fill the database. The log names the
// company made and never the token or the link. A company made here never gets a reserved address
// (PLATFORM_ADMIN_EMAILS): the hub can't hand out the administrator's rights.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { clientAddress } from "@/lib/client-ip";
import { EMAIL_HELP, isValidEmail, normalizeEmail } from "@/lib/email";
import { hubState, syncHub } from "@/lib/hub";
import { isDesktop } from "@/lib/modules";
import { allow } from "@/lib/rate-limit";
import { appBaseUrl, issueResetLink, SETUP_HOURS } from "@/lib/password-reset";
import { createShopWithOwner, type ShopKind } from "@/lib/shops";
import { isUserError } from "@/lib/user-error";
import { secureRequest } from "@/lib/move/http";

const HOUR = 3600_000;
const MAX_BODY = 16 * 1024;
const KINDS = new Set(["repair", "retail", "both"]);

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The token, when the route is on: a hosted service with PLATFORM_API_TOKEN of 32+ characters. */
export function platformToken(): string | null {
  if (isDesktop()) return null;
  const t = (process.env.PLATFORM_API_TOKEN ?? "").trim();
  return t.length >= 32 ? t : null;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();
/** Constant time whatever the lengths: both sides hashed first. */
const sameToken = (given: string, want: string) => crypto.timingSafeEqual(sha(given), sha(want));

/** The body as JSON, at most 16 KB; null when it isn't. */
async function body(req: Request): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return null;
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** A time zone this server knows (America/Chicago), or null. */
function zone(v: unknown): string | null {
  const tz = text(v, 64);
  if (!tz || !tz.includes("/")) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

export async function handlePlatformCompanies(req: Request): Promise<Response> {
  const token = platformToken();
  if (!token) return json(404, { error: "Not found." });
  const ip = clientAddress(req);
  if (!secureRequest(req)) return json(403, { error: "Use https." });
  if (ip && wrongTries(`ip:${ip}`).length >= 10) return json(429, { error: "Too many wrong tokens from this address. Wait an hour." });
  if (wrongTries("all").length >= 200) return json(429, { error: "Too many wrong tokens lately. Try again in an hour." });
  const h = req.headers.get("authorization") ?? "";
  const given = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!given || !sameToken(given, token)) {
    noteWrong(ip);
    console.warn(`[platform] a company request with a ${given ? "wrong" : "missing"} token${ip ? ` from ${ip}` : ""}`);
    return json(401, { error: "Wrong token." });
  }
  const b = await body(req);
  if (!b) return json(400, { error: "Send a JSON object (16 KB at most)." });
  const shopName = text(b.shopName, 120);
  const ownerName = text(b.ownerName, 120);
  const ownerEmail = normalizeEmail(b.ownerEmail);
  const kind = typeof b.kind === "string" && KINDS.has(b.kind) ? (b.kind as ShopKind) : null;
  if (!shopName || !ownerName) return json(400, { error: "Send shopName and ownerName." });
  if (!ownerEmail || !isValidEmail(ownerEmail)) return json(400, { error: EMAIL_HELP });
  if (!kind) return json(400, { error: "Send kind: repair, retail or both." });
  if (!appBaseUrl()) return json(503, { error: "This service doesn't know its own address for the owner's link: set APP_URL." });
  if (!allow("platform:companies", 30, HOUR)) return json(429, { error: "Too many companies made in the last hour. Try again later." });
  let shop: { id: string; name: string };
  try {
    // Never a reserved address (PLATFORM_ADMIN_EMAILS): a company made from the hub can't hand out the administrator's rights.
    shop = await createShopWithOwner(
      { shopName, name: ownerName, email: ownerEmail, password: crypto.randomBytes(24).toString("base64url"), kind, timeZone: zone(b.timeZone) },
      { allowReserved: false },
    );
  } catch (e) {
    if (isUserError(e)) return json(/already has an account|reserved/i.test(e.message) ? 409 : 400, { error: e.message });
    throw e;
  }
  await db.shop.update({ where: { id: shop.id }, data: { startedFromHubAt: new Date() } });
  const owner = await db.user.findUniqueOrThrow({ where: { shopId_email: { shopId: shop.id, email: ownerEmail } }, select: { id: true } });
  const { link, expiresAt } = await issueResetLink(owner.id, "setup", SETUP_HOURS);
  const s = await hubState();
  const account = text(b.hubAccountId, 64);
  console.info(`[platform] company ${shop.id} (${kind}) made from StitchHub${account ? ` for hub account ${account}` : ""}`);
  // The company claims itself on the hub now rather than at the next sync; nobody waits for it.
  if (s?.url && s.installKey) syncHub().catch(() => undefined);
  return json(201, {
    shopId: shop.id,
    shopName: shop.name,
    setPasswordUrl: link,
    expiresAt: expiresAt.toISOString(),
    appUrl: appBaseUrl(),
    hub: s?.url && s.installKey && s.installId ? { url: s.url, installId: s.installId } : null,
  });
}

// Wrong tokens in the last hour, per address and across the server. Only wrong ones are counted, so the hub's own
// requests never use the allowance up. On globalThis, like rate-limit.ts, so every copy of this module shares one table.
type Tries = Map<string, number[]>;
const tries = ((globalThis as unknown as { __platformWrong?: Tries }).__platformWrong ??= new Map<string, number[]>());

function wrongTries(key: string): number[] {
  const now = Date.now();
  const list = (tries.get(key) ?? []).filter((t) => now - t < HOUR);
  if (list.length) tries.set(key, list);
  else tries.delete(key);
  return list;
}

function noteWrong(ip: string | null) {
  for (const key of ip ? [`ip:${ip}`, "all"] : ["all"]) tries.set(key, [...wrongTries(key), Date.now()]);
  while (tries.size > 10_000) tries.delete(tries.keys().next().value as string);
}

/** Check scripts only: forget the wrong tries counted so far. */
export function forgetWrongTokens() {
  tries.clear();
}
