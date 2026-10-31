import "server-only";
// A password reset from the owner's StitchHub account to the Windows program (hub-accounts-billing-design.md 4.3.4,
// package hosted-provisioning). Opt-in on the PC only: Settings → Account, "Allow a password reset from my StitchHub
// account" (Shop.hubResetOptIn, owners, Windows). The claim tells the hub (resetOptIn); the owner then asks on the hub's
// account page, and the hub signs a grant { shopRef, installId, email, nonce, expires in 1 hour } with its key.
//
// At each sync (and while the program's own window shows the sign-in page), every opted-in company asks the hub for its
// grants (GET /v1/shops/:ref/reset-grants). A grant counts only when:
//   - its signature verifies with a compiled hub key (license-keys.ts, scope "hub", not retired; while the hub1 line is
//     a placeholder nothing verifies and nothing happens), over its own context, so no license signature is a grant;
//   - it names this company and this install, has not expired and lives no longer than an hour;
//   - the company is still opted in here (the hub can't switch that on: it is stored on the PC);
//   - its email is an active OWNER login of that company;
//   - it was never answered here (its nonce, hashed, is a PasswordReset row once answered: one use, across restarts).
// It is then shown only in the program's own Electron window (desktop/main.mjs adds X-Stitch-Window with a secret it
// gave the server at start, on requests to the program's own address only), never on another device or a browser tab,
// never mailed: "StitchHub asks to reset <email>'s password: Allow / Refuse". Allow sets a new 12-character password,
// shown once there, and signs every device out of that login (sessionVersion + 1), and that window is known for the
// login from then on (src/lib/known-device.ts); both answers are told to the hub.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import type { PublicKeys } from "@/lib/license";
import { LICENSE_PUBLIC_KEYS } from "@/lib/license-keys";
import { hubFetch, hubId, hubState, hubStatus } from "@/lib/hub";
import { isLocalRequest } from "@/lib/messaging/settings";
import { isDesktop } from "@/lib/modules";

/** A grant's text: SBG1.<base64url payload JSON>.<base64url Ed25519 signature over CONTEXT + payload bytes>. */
export const GRANT_CONTEXT = "stitchhub-reset-grant-v1\n";
export const WINDOW_HEADER = "x-stitch-window";
export const WINDOW_ONLY = "Only the program's own window on the shop PC can answer this.";
const MAX_LIFE = 65 * 60_000; // an hour, and five minutes for the clocks
const PULL_GAP = 30_000;

export type GrantPayload = { v: 1; k: string; id: string; shopRef: string; installId: string; email: string; nonce: string; iat: string; exp: string };

// ---------- the signature ----------

let checkKeys: PublicKeys | null = null;
/** Check scripts only: verify with these keys instead of the compiled ones (a throwaway pair). Never called by the app. */
export function grantKeysForChecks(keys: PublicKeys | null) {
  checkKeys = keys;
}

/** The hub's public keys: scope "hub", not retired (a retired hub key signs no more resets). */
function hubKeys(): PublicKeys {
  return Object.fromEntries(Object.entries(checkKeys ?? LICENSE_PUBLIC_KEYS).filter(([, k]) => k.scope === "hub" && !k.retired));
}

export function verifyResetGrant(text: unknown, keys: PublicKeys = hubKeys()): { ok: true; payload: GrantPayload } | { ok: false; reason: string } {
  const m = typeof text === "string" ? /^SBG1\.([A-Za-z0-9_-]{20,2000})\.([A-Za-z0-9_-]{86})$/.exec(text.trim()) : null;
  if (!m) return { ok: false, reason: "not a grant" };
  const bytes = Buffer.from(m[1], "base64url");
  let p: GrantPayload;
  try {
    p = JSON.parse(bytes.toString("utf8")) as GrantPayload;
  } catch {
    return { ok: false, reason: "damaged" };
  }
  if (!p || typeof p !== "object" || p.v !== 1) return { ok: false, reason: "a format this program doesn't know" };
  const pk = typeof p.k === "string" && Object.hasOwn(keys, p.k) ? keys[p.k] : undefined;
  if (!pk) return { ok: false, reason: "signed with a key this program doesn't hold" };
  let good = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pk.x }, format: "jwk" });
    good = crypto.verify(null, Buffer.concat([Buffer.from(GRANT_CONTEXT, "utf8"), bytes]), key, Buffer.from(m[2], "base64url"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "the signature doesn't verify" };
  const id = /^[A-Za-z0-9_-]{8,64}$/;
  const shapeOk =
    typeof p.id === "string" &&
    id.test(p.id) &&
    typeof p.shopRef === "string" &&
    id.test(p.shopRef) &&
    typeof p.installId === "string" &&
    id.test(p.installId) &&
    typeof p.email === "string" &&
    isValidEmail(p.email) &&
    typeof p.nonce === "string" &&
    /^[A-Za-z0-9_-]{16,128}$/.test(p.nonce) &&
    typeof p.iat === "string" &&
    !Number.isNaN(Date.parse(p.iat)) &&
    typeof p.exp === "string" &&
    !Number.isNaN(Date.parse(p.exp));
  if (!shapeOk) return { ok: false, reason: "damaged" };
  return { ok: true, payload: p };
}

/** What a grant leaves behind once answered here: the nonce, hashed, as a PasswordReset row's tokenHash. */
export const grantHash = (nonce: string) => crypto.createHash("sha256").update(`hub-grant:${nonce}`).digest("hex");

// ---------- the program's own window ----------

/**
 * The request comes from the program's own Electron window on the shop PC: the Windows program, the secret
 * desktop/main.mjs gave the server at start (STITCH_WINDOW_SECRET) in X-Stitch-Window, addressed to the PC itself with
 * no proxy in between. A browser tab, a tablet, the links tunnel: none of them has the secret.
 */
export function inProgramWindow(h: Headers): boolean {
  if (!isDesktop()) return false;
  const secret = process.env.STITCH_WINDOW_SECRET ?? "";
  const given = h.get(WINDOW_HEADER) ?? "";
  if (secret.length < 32 || !given || !isLocalRequest(h)) return false;
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(sha(given), sha(secret));
}

// ---------- grants waiting for an answer ----------

type Pending = { id: string; shopId: string; shopName: string; email: string; userId: string; nonce: string; expiresAt: Date };
// In memory, shared by every copy of this module: a restart forgets them and the next sync asks the hub again.
const store = ((globalThis as unknown as { __hubResetGrants?: Map<string, Pending> }).__hubResetGrants ??= new Map<string, Pending>());
const pulling = globalThis as unknown as { __hubResetPullAt?: number };

async function tellHub(shopId: string, id: string, result: "allowed" | "refused", why?: string) {
  try {
    await hubFetch(`/v1/shops/${hubId(shopId)}/reset-grants/${hubId(id)}/done`, { method: "POST", json: { result, ...(why ? { why } : {}) }, shopRef: shopId });
  } catch (e) {
    // Asked again at the next sync: the grant is still listed there, and the answer here is kept (its PasswordReset row).
    console.error(`community hub: telling the hub about reset grant ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** One grant from the hub for `shop`, checked; kept when it may be shown. */
async function takeIn(shop: { id: string; name: string }, item: { id?: unknown; grant?: unknown }, installId: string): Promise<boolean> {
  const v = verifyResetGrant(item.grant);
  const now = Date.now();
  if (!v.ok) {
    console.error(`community hub: a reset grant for company ${shop.id} isn't usable (${v.reason}); ignored`);
    return false;
  }
  const p = v.payload;
  const exp = Date.parse(p.exp);
  if (p.id !== item.id || p.shopRef !== shop.id || p.installId !== installId || exp <= now || exp - now > MAX_LIFE || Date.parse(p.iat) > now + 5 * 60_000) {
    console.error(`community hub: reset grant ${String(item.id)} is for another company or install, expired, or too long-lived; ignored`);
    return false;
  }
  const answered = await db.passwordReset.findUnique({ where: { tokenHash: grantHash(p.nonce) }, select: { kind: true } });
  if (answered) {
    await tellHub(shop.id, p.id, answered.kind === "hub" ? "allowed" : "refused");
    return false;
  }
  const email = normalizeEmail(p.email);
  const owner = await db.user.findFirst({ where: { shopId: shop.id, email, role: "OWNER", active: true }, select: { id: true } });
  if (!owner) {
    await tellHub(shop.id, p.id, "refused", "no-owner");
    return false;
  }
  store.set(p.id, { id: p.id, shopId: shop.id, shopName: shop.name, email, userId: owner.id, nonce: p.nonce, expiresAt: new Date(exp) });
  return true;
}

/**
 * The sync's step (doSync, after the claims): every opted-in company on the Windows program asks the hub for its
 * grants. A hub without the route (404) or one that doesn't answer changes nothing; the sync carries on. Returns how
 * many grants wait for an answer now.
 */
export async function pullResetGrants(run: { installId: string | null }): Promise<number> {
  if (!isDesktop() || !run.installId) return 0;
  pulling.__hubResetPullAt = Date.now();
  const shops = await db.shop.findMany({ where: { hubResetOptIn: true, movedOutAt: null }, select: { id: true, name: true } });
  const optedIn = new Set(shops.map((s) => s.id));
  for (const [id, g] of store) if (!optedIn.has(g.shopId) || g.expiresAt.getTime() <= Date.now()) store.delete(id);
  for (const shop of shops) {
    let answer: { grants?: unknown };
    try {
      answer = (await (await hubFetch(`/v1/shops/${hubId(shop.id)}/reset-grants`, { shopRef: shop.id })).json()) as { grants?: unknown };
    } catch (e) {
      if (hubStatus(e) !== 404) console.error(`community hub: reset grants for company ${shop.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const items = Array.isArray(answer.grants) ? (answer.grants as { id?: unknown; grant?: unknown }[]).slice(0, 10) : [];
    for (const item of items) if (item && typeof item === "object") await takeIn(shop, item, run.installId);
  }
  return [...store.values()].filter((g) => optedIn.has(g.shopId)).length;
}

/**
 * The sign-in page in the program's window asks too, at most every 30 seconds and waiting at most 2.5 s, so an owner who
 * asked on the hub and walked to the PC needn't wait for the 10-minute sync.
 */
export async function pullResetGrantsSoon(): Promise<void> {
  if (!isDesktop() || Date.now() - (pulling.__hubResetPullAt ?? 0) < PULL_GAP) return;
  if (!(await db.shop.count({ where: { hubResetOptIn: true } }))) return;
  const s = await hubState();
  if (!s?.url || !s.installKey) return;
  pulling.__hubResetPullAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([pullResetGrants({ installId: s.installId }).catch(() => 0), new Promise((r) => (timer = setTimeout(r, 2500)))]);
  clearTimeout(timer);
}

export type GrantShown = { id: string; shopName: string; email: string; expiresAt: string };

/** Grants waiting for an answer in the program's window (the caller has checked inProgramWindow). */
export async function pendingResetGrants(): Promise<GrantShown[]> {
  if (!isDesktop()) return [];
  const now = Date.now();
  const live = [...store.values()].filter((g) => g.expiresAt.getTime() > now);
  if (!live.length) return [];
  const answered = new Set((await db.passwordReset.findMany({ where: { tokenHash: { in: live.map((g) => grantHash(g.nonce)) } }, select: { tokenHash: true } })).map((r) => r.tokenHash));
  return live.filter((g) => !answered.has(grantHash(g.nonce))).map((g) => ({ id: g.id, shopName: g.shopName, email: g.email, expiresAt: g.expiresAt.toISOString() }));
}

// No 0/O, 1/l/I: read off one screen and typed on another (the same alphabet as the tray's reset, desktop/reset-password.mjs).
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newPassword(length = 12): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < length) for (const b of crypto.randomBytes(length * 2)) if (b < limit && out.length < length) out += ALPHABET[b % ALPHABET.length];
  return out;
}

const isClash = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

/**
 * The answer from the program's window. Allow: a new password for the owner, returned to be shown once there, with the
 * owner's login (the window is known for it from then on: src/actions/hub-reset.ts); every device signed in as the owner
 * signs in again. Refuse: nothing changes (null). Either way the grant is spent here and the hub is told. Refused
 * (UserError) outside the program's window, for a grant that expired or was answered, and when the company stopped
 * allowing resets or the owner login changed.
 */
export async function answerResetGrant(id: unknown, allow: boolean, h: Headers): Promise<{ password: string; userId: string } | null> {
  if (!inProgramWindow(h)) throw new UserError(WINDOW_ONLY);
  const g = typeof id === "string" ? store.get(id) : undefined;
  if (!g || g.expiresAt.getTime() <= Date.now()) {
    if (g) store.delete(g.id);
    throw new UserError("That request from StitchHub has expired or was answered. Ask again from the StitchHub account if it's still needed.");
  }
  const [shop, owner] = await Promise.all([
    db.shop.findUnique({ where: { id: g.shopId }, select: { hubResetOptIn: true } }),
    db.user.findFirst({ where: { id: g.userId, shopId: g.shopId, email: g.email, role: "OWNER", active: true }, select: { id: true } }),
  ]);
  if (!shop?.hubResetOptIn) {
    store.delete(g.id);
    throw new UserError("This company doesn't allow a reset from StitchHub any more (Settings → Account).");
  }
  if (!owner) {
    store.delete(g.id);
    throw new UserError(`${g.email} isn't this company's owner login any more, so nothing was changed.`);
  }
  const now = new Date();
  const mark = { userId: owner.id, tokenHash: grantHash(g.nonce), expiresAt: g.expiresAt, usedAt: now };
  let password: string | null = null;
  try {
    if (allow) {
      password = newPassword();
      const hash = await bcrypt.hash(password, 10);
      await db.$transaction([db.passwordReset.create({ data: { ...mark, kind: "hub" } }), db.user.update({ where: { id: owner.id }, data: { passwordHash: hash, sessionVersion: { increment: 1 } } })]);
    } else {
      await db.passwordReset.create({ data: { ...mark, kind: "hub-refused" } });
    }
  } catch (e) {
    if (!isClash(e)) throw e;
    store.delete(g.id);
    throw new UserError("That request from StitchHub was answered already.");
  }
  store.delete(g.id);
  console.info(`[password] a StitchHub reset for the owner of company ${g.shopId} was ${allow ? "allowed" : "refused"} in the program's window`);
  await tellHub(g.shopId, g.id, allow ? "allowed" : "refused");
  return password ? { password, userId: owner.id } : null;
}
