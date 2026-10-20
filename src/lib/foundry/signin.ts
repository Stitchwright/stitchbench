import "server-only";
// Signing in to StitchBench / StitchShop with a Foundry Account, and linking a login to one (docs/plan.md FA-2).
//
// Who a person is comes from the account's lasting id, never from its email: the account service doesn't verify email at
// sign-up yet, so anyone could make an account for someone else's address. A login is linked to an account only by someone
// who proves both: the old email and password of that login AND the Foundry Account's own password. After that the id
// alone opens it. Nothing here reads a role or a company from the service; those stay in this database.
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { clientAddress } from "@/lib/client-ip";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import { checkLinkToken } from "@/lib/password-reset";
import { signInStep } from "@/lib/sign-in";
import { forgotPassword as cloudForgot, isFoundryError, signIn as cloudSignIn, signOut as cloudSignOut, signUp as cloudSignUp, type CloudOptions, type FoundryFailure, type SignedIn } from "./cloud";
import { startFoundrySession } from "./session";

const WINDOW = 15 * 60_000;
export const FOUNDRY_PER_ADDRESS = 30;
const MAX_KEYS = 50_000;

// Wrong Foundry sign-ins per address (the service also locks an email after five wrong). In memory, like sign-in.ts.
const wrong: Map<string, { n: number; last: number }> = ((globalThis as unknown as { __foundrySignIn?: Map<string, { n: number; last: number }> }).__foundrySignIn ??= new Map());
const countOf = (key: string) => {
  const f = wrong.get(key);
  return !f || Date.now() - f.last > WINDOW ? 0 : f.n;
};
function miss(key: string) {
  const n = countOf(key) + 1;
  wrong.delete(key);
  wrong.set(key, { n, last: Date.now() });
  for (const k of wrong.keys()) {
    if (wrong.size <= MAX_KEYS) break;
    wrong.delete(k);
  }
}

const credentialsSchema = z.object({
  email: z.string().transform(normalizeEmail).refine(isValidEmail),
  password: z.string().min(1).max(1000),
});

/** Why a Foundry sign-in didn't happen; the page turns each into words. */
export type FoundryRefusal =
  | "wrong" //     the email and password don't match a Foundry Account (or the form was malformed)
  | "wait" //      too many wrong tries (the service's lock, or this address's)
  | "offline" //   the service can't be reached
  | "down" //      the service answered something odd
  | "unlinked"; // a right Foundry sign-in, but no login here is linked to it

const refusalOf = (kind: FoundryFailure): FoundryRefusal =>
  kind === "signed-out" || kind === "refused" ? "wrong" : kind === "wait" ? "wait" : kind === "offline" ? "offline" : "down";

export type FoundryLogin = { id: string; sv: number };

/** What the functions below need besides the account service's address: how a browser's session is started (the tests replace it, since cookies need a request). */
export type FoundryDeps = CloudOptions & { start?: (token: string, foundryId: number) => Promise<void> };

/**
 * Sign in with a Foundry Account: the service checks the password; the logins linked to that account's id are the ones
 * that fit. Starts the browser's Foundry session (cookie + sealed token) when at least one fits. Call from a server action.
 * `o` is for tests (the stand-in service's address).
 */
export async function foundrySignInStep(credentials: unknown, request: Request | Headers | undefined, o: FoundryDeps = {}): Promise<{ ok: true; logins: FoundryLogin[]; foundryId: number } | { ok: false; reason: FoundryRefusal }> {
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success) return { ok: false, reason: "wrong" };
  const ip = clientAddress(request);
  const key = ip ? `i:${ip}` : null;
  if (key && countOf(key) >= FOUNDRY_PER_ADDRESS) return { ok: false, reason: "wait" };
  let signed: SignedIn;
  try {
    signed = await cloudSignIn(parsed.data.email, parsed.data.password, o);
  } catch (e) {
    if (!isFoundryError(e)) throw e;
    if (key && (e.kind === "signed-out" || e.kind === "refused")) miss(key);
    return { ok: false, reason: refusalOf(e.kind) };
  }
  const users = await db.user.findMany({ where: { foundryId: signed.account.id, active: true }, select: { id: true, sessionVersion: true } });
  if (!users.length) {
    await endAtService(signed.token, o);
    return { ok: false, reason: "unlinked" };
  }
  await (o.start ?? startFoundrySession)(signed.token, signed.account.id);
  return { ok: true, logins: users.map((u) => ({ id: u.id, sv: u.sessionVersion })), foundryId: signed.account.id };
}

async function endAtService(token: string, o: CloudOptions) {
  try {
    await cloudSignOut(token, o);
  } catch {
    // Offline or already ended: nothing more to do.
  }
}

/** Why a link didn't happen. */
export type LinkRefusal = "old" | "link" | "several" | "foundry-wrong" | "foundry-taken" | "wait" | "offline" | "down" | "other-account" | "taken" | "short";

export type LinkInput = {
  email?: unknown;
  password?: unknown;
  /** A setup or administrator's link (docs/plan.md FA-5): proves the login by itself, instead of its old email and password. */
  token?: unknown;
  /**
   * The login that is signed in right now (its id and sessionVersion), from server code that has already checked the session
   * (Settings → Foundry Account). The session is the proof: it is how a login that is one of several with the same email
   * and password links its own account, one company at a time.
   */
  signedIn?: { id: string; sv: number };
  foundryEmail: unknown;
  foundryPassword: unknown;
  create: boolean;
};

/** A link taken by someone else between the check and the write. */
class LinkGone extends Error {}

/**
 * Link a login to a Foundry Account (or make the account first). The login is proved by its old email and password (with
 * that password's usual limits); the account by its own password. Exactly one login must fit the old password: with the
 * same email in several companies, link from Settings once signed in (not built yet: FA-2 follow-up).
 */
export async function linkFoundryAccount(input: LinkInput, request: Request | Headers | undefined, o: FoundryDeps = {}): Promise<{ ok: true; login: FoundryLogin; foundryId: number } | { ok: false; reason: LinkRefusal }> {
  // Who the login is: a one-time link says so by itself; otherwise its old email and password do (with their usual limits).
  let who: { id: string; sv: number };
  let tokenRowId: string | null = null;
  if (input.signedIn) {
    who = input.signedIn;
  } else if (typeof input.token === "string" && input.token.trim()) {
    const t = await checkLinkToken(input.token);
    if (!t.ok) return { ok: false, reason: "link" };
    who = { id: t.userId, sv: t.sv };
    tokenRowId = t.rowId;
  } else {
    const found = await signInStep({ email: input.email, password: input.password }, request);
    if (!found) return { ok: false, reason: "old" };
    if (found.length !== 1) return { ok: false, reason: "several" };
    who = found[0];
  }

  const parsed = credentialsSchema.safeParse({ email: input.foundryEmail, password: input.foundryPassword });
  if (!parsed.success) return { ok: false, reason: input.create ? "short" : "foundry-wrong" };
  const ip = clientAddress(request);
  const key = ip ? `i:${ip}` : null;
  if (key && countOf(key) >= FOUNDRY_PER_ADDRESS) return { ok: false, reason: "wait" };
  let signed: SignedIn;
  try {
    signed = input.create ? await cloudSignUp(parsed.data.email, parsed.data.password, o) : await cloudSignIn(parsed.data.email, parsed.data.password, o);
  } catch (e) {
    if (!isFoundryError(e)) throw e;
    if (key && (e.kind === "signed-out" || e.kind === "refused")) miss(key);
    if (input.create && e.status === 409) return { ok: false, reason: "foundry-taken" };
    if (input.create && e.status === 400) return { ok: false, reason: "short" };
    const r = refusalOf(e.kind);
    return { ok: false, reason: r === "wrong" ? "foundry-wrong" : r === "wait" ? "wait" : r === "offline" ? "offline" : "down" };
  }

  const user = await db.user.findUnique({ where: { id: who.id }, select: { id: true, name: true, email: true, role: true, shopId: true, foundryId: true, sessionVersion: true, active: true } });
  if (!user || !user.active || user.sessionVersion !== who.sv) {
    await endAtService(signed.token, o);
    return { ok: false, reason: "old" };
  }
  if (user.foundryId !== null && user.foundryId !== signed.account.id) {
    await endAtService(signed.token, o);
    return { ok: false, reason: "other-account" };
  }
  if (user.foundryId === null && (await db.user.findFirst({ where: { shopId: user.shopId, foundryId: signed.account.id }, select: { id: true } }))) {
    // Another login of this company already holds the account: say so without letting the database raise it.
    await endAtService(signed.token, o);
    return { ok: false, reason: "taken" };
  }
  try {
    await db.$transaction(async (tx) => {
      // The link is taken under its own update, in the same transaction as the write: two tries can't both use it, and a write
      // that fails gives it back. A used link also cancels the login's other links (as setting a password from one does).
      if (tokenRowId) {
        const took = await tx.passwordReset.updateMany({ where: { id: tokenRowId, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
        if (took.count !== 1) throw new LinkGone();
      }
      if (user.foundryId === null) await tx.user.update({ where: { id: user.id }, data: { foundryId: signed.account.id } });
      if (tokenRowId) await tx.passwordReset.updateMany({ where: { userId: user.id, kind: { in: ["reset", "setup", "admin"] }, usedAt: null }, data: { usedAt: new Date() } });
    });
  } catch (e) {
    await endAtService(signed.token, o);
    // Two links at the same moment: the unique rule (shopId, foundryId) is the last word.
    return { ok: false, reason: e instanceof LinkGone ? "link" : "taken" };
  }
  if (user.foundryId === null) {
    try {
      await audit(db, { shopId: user.shopId, id: user.id, name: user.name, role: user.role }, { action: "foundry.link", subjectType: "User", subjectId: user.id, subjectLabel: `${user.name} (${user.email})` });
    } catch (e) {
      console.error("audit foundry link:", e instanceof Error ? e.message : e);
    }
  }
  await (o.start ?? startFoundrySession)(signed.token, signed.account.id);
  return { ok: true, login: { id: user.id, sv: user.sessionVersion }, foundryId: signed.account.id };
}

/** The password-reset email is the account service's: ask it, say nothing about whether the address has an account. */
export async function sendFoundryReset(email: unknown, o: CloudOptions = {}): Promise<"sent" | "offline" | "down" | "wait"> {
  const e = z.string().transform(normalizeEmail).refine(isValidEmail).safeParse(email);
  if (!e.success) return "sent"; // the same answer for anything
  try {
    await cloudForgot(e.data, o);
    return "sent";
  } catch (err) {
    if (!isFoundryError(err)) throw err;
    return err.kind === "offline" ? "offline" : err.kind === "wait" ? "wait" : err.kind === "not-open" || err.kind === "broken" ? "down" : "sent";
  }
}
