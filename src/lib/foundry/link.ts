import "server-only";
// The desktop program's optional link to a Foundry Account (docs/plan.md FA-3). One link per company, kept in the database
// with the account service's token sealed, so it is there with no internet: the program (tickets, the register, stock,
// printing, manuals) never needs the link or the service, online or not. What needs the link, when FOUNDRY_LINK=required
// (src/lib/foundry/mode.ts), is the community hub, partner shops and the Assistant, and `foundryGate()` is how they ask.
//
// The service's email and balance are kept only to be shown; who may do what is decided here, from this database. The link
// is the account's lasting id, never its email.
import { z } from "zod";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import { seal, unseal } from "@/lib/messaging/secrets";
import { UserError } from "@/lib/user-error";
import { getAccount, isFoundryError, signIn as cloudSignIn, signOut as cloudSignOut, signUp as cloudSignUp, type CloudOptions } from "./cloud";
import { foundryLinkMode } from "./mode";

const FIELD = "foundryLink" as const;
/** A link is checked with the service at most this often (when the PC is online and something asks). */
const RECHECK_MS = 24 * 3_600_000;
/** After a try that couldn't reach the service, the next waits this long, so an offline PC isn't asking all day. */
const RETRY_MS = 10 * 60_000;

export const NOT_LINKED = "Link your Foundry Account (Settings → Foundry Account) to use the community hub, partner shops and the Assistant. Everything else works without it.";
export const SIGNED_OUT = "Your Foundry Account sign-in has ended. Sign in again under Settings → Foundry Account. Everything else keeps working.";

export type Gate = { ok: true } | { ok: false; why: "not-linked" | "signed-out"; message: string };

const tried: Map<string, number> = ((globalThis as unknown as { __foundryLinkTried?: Map<string, number> }).__foundryLinkTried ??= new Map());

/**
 * Whether the hub, partner shops and the Assistant may be used on this install. Open unless FOUNDRY_LINK=required. Then at
 * least one company must hold a link the service still accepts (a desktop install is one company; with several, one linked
 * company opens the install's hub traffic: the sync is the install's, not a company's). Reads only the database, so a PC
 * that is offline answers the same as one that is online; when the last check is old it asks the service in the background.
 */
export async function foundryGate(): Promise<Gate> {
  if (foundryLinkMode() !== "required") return { ok: true };
  const rows = await db.foundryLink.findMany({ select: { shopId: true, state: true, checkedAt: true } });
  if (!rows.length) return { ok: false, why: "not-linked", message: NOT_LINKED };
  if (!rows.some((r) => r.state === "ok")) return { ok: false, why: "signed-out", message: SIGNED_OUT };
  const now = Date.now();
  for (const r of rows) {
    const stale = !r.checkedAt || now - r.checkedAt.getTime() > RECHECK_MS;
    if (stale && now - (tried.get(r.shopId) ?? 0) > RETRY_MS) {
      tried.set(r.shopId, now);
      // Never makes anyone wait, and never fails a page: the answer is only kept for next time.
      void verifyLink(r.shopId, { timeoutMs: 5000 }).catch(() => undefined);
    }
  }
  return { ok: true };
}

/** Throws the gate's words as a UserError when the hub or Assistant may not be used (hub.ts calls this before any hub traffic). */
export async function requireFoundryGate(): Promise<void> {
  const g = await foundryGate();
  if (!g.ok) throw new UserError(g.message);
}

export type LinkCheck = { state: "ok" | "signed-out" | "unreachable" | "none"; creditsLeft: number | null };

/** Asks the service whether this company's link still works, and keeps the answer. Offline or odd answers change nothing. */
export async function verifyLink(shopId: string, o: CloudOptions = {}): Promise<LinkCheck> {
  const row = await db.foundryLink.findUnique({ where: { shopId } });
  if (!row) return { state: "none", creditsLeft: null };
  const token = unseal(row.token, shopId, FIELD)?.plain;
  if (!token) {
    await db.foundryLink.update({ where: { shopId }, data: { state: "signed-out", checkedAt: new Date() } });
    return { state: "signed-out", creditsLeft: row.creditsLeft };
  }
  try {
    const a = await getAccount(token, o);
    // The id is what the link is; if the service now answers another id for this token, something is wrong: treat as signed out.
    if (a.id !== row.foundryId) {
      await db.foundryLink.update({ where: { shopId }, data: { state: "signed-out", checkedAt: new Date() } });
      return { state: "signed-out", creditsLeft: row.creditsLeft };
    }
    await db.foundryLink.update({ where: { shopId }, data: { state: "ok", email: a.email, creditsLeft: a.credits, checkedAt: new Date() } });
    return { state: "ok", creditsLeft: a.credits };
  } catch (e) {
    if (isFoundryError(e) && e.kind === "signed-out") {
      await db.foundryLink.update({ where: { shopId }, data: { state: "signed-out", checkedAt: new Date() } });
      return { state: "signed-out", creditsLeft: row.creditsLeft };
    }
    return { state: "unreachable", creditsLeft: row.creditsLeft };
  }
}

type Actor = { id: string; shopId: string; name: string; role: "OWNER" | "ADMIN" | "TECH" };

const credentialsSchema = z.object({
  email: z.string().transform(normalizeEmail).refine(isValidEmail, "Type the email address of the Foundry Account."),
  password: z.string().min(1, "Type the Foundry Account password.").max(1000),
});

/** Link this company to a Foundry Account (or make one first). Owners and admins; needs the internet this once. */
export async function linkFoundry(user: Actor, input: { email: unknown; password: unknown; create: boolean }, o: CloudOptions = {}): Promise<{ email: string; creditsLeft: number }> {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can link a Foundry Account.");
  const parsed = credentialsSchema.safeParse({ email: input.email, password: input.password });
  if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Check the email and password.");
  const have = await db.foundryLink.findUnique({ where: { shopId: user.shopId }, select: { foundryId: true } });
  // FoundryError is a UserError: the service's own words (wrong password, locked for 15 minutes, can't be reached) reach the page.
  const signed = input.create ? await cloudSignUp(parsed.data.email, parsed.data.password, o) : await cloudSignIn(parsed.data.email, parsed.data.password, o);
  if (have && have.foundryId !== signed.account.id) {
    await endAtService(signed.token, o);
    throw new UserError("This company is already linked to a different Foundry Account. Unlink it first, then link the other one.");
  }
  const data = { foundryId: signed.account.id, email: signed.account.email, token: seal(signed.token, user.shopId, FIELD), state: "ok", creditsLeft: signed.account.credits, checkedAt: new Date() };
  await db.foundryLink.upsert({ where: { shopId: user.shopId }, create: { shopId: user.shopId, ...data }, update: data });
  tried.delete(user.shopId);
  await audit(db, { shopId: user.shopId, id: user.id, name: user.name, role: user.role }, { action: "foundry.link", subjectType: "Shop", subjectId: user.shopId, subjectLabel: signed.account.email });
  return { email: signed.account.email, creditsLeft: signed.account.credits };
}

/** Unlink: the service's session ends (if it can be reached; the link is gone here either way). Owners and admins. */
export async function unlinkFoundry(user: Actor, o: CloudOptions = {}): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can unlink the Foundry Account.");
  const row = await db.foundryLink.findUnique({ where: { shopId: user.shopId } });
  if (!row) return;
  await db.foundryLink.delete({ where: { shopId: user.shopId } });
  tried.delete(user.shopId);
  const token = unseal(row.token, user.shopId, FIELD)?.plain;
  if (token) await endAtService(token, o);
  await audit(db, { shopId: user.shopId, id: user.id, name: user.name, role: user.role }, { action: "foundry.unlink", subjectType: "Shop", subjectId: user.shopId, subjectLabel: row.email });
}

async function endAtService(token: string, o: CloudOptions) {
  try {
    await cloudSignOut(token, o);
  } catch {
    // Offline or already ended: our copy is what matters, and it is gone or never kept.
  }
}

/** The service's token for this company, for a request made for it (FA-4); null when not linked or signed out. */
export async function foundryTokenFor(shopId: string): Promise<string | null> {
  const row = await db.foundryLink.findUnique({ where: { shopId }, select: { token: true, state: true } });
  if (!row || row.state !== "ok") return null;
  return unseal(row.token, shopId, FIELD)?.plain ?? null;
}

export type LinkView = { mode: "offer" | "required"; linked: boolean; email: string | null; state: "ok" | "signed-out" | null; creditsLeft: number | null; checkedAt: Date | null; reachable: boolean | null };

/** What Settings → Foundry Account shows. Asks the service (briefly) so the balance is fresh; offline shows the last known one. */
export async function foundryLinkView(shopId: string, o: CloudOptions = {}): Promise<LinkView | null> {
  const mode = foundryLinkMode();
  if (mode === "off") return null;
  const before = await db.foundryLink.findUnique({ where: { shopId } });
  if (!before) return { mode, linked: false, email: null, state: null, creditsLeft: null, checkedAt: null, reachable: null };
  const c = await verifyLink(shopId, { timeoutMs: 4000, ...o });
  const row = (await db.foundryLink.findUnique({ where: { shopId } })) ?? before;
  return { mode, linked: true, email: row.email, state: row.state === "ok" ? "ok" : "signed-out", creditsLeft: row.creditsLeft, checkedAt: row.checkedAt, reachable: c.state !== "unreachable" };
}
