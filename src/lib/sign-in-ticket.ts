import "server-only";
// The "Choose a company" ticket (round 3 W1, docs/plans/email-per-company-design.md section 3). One email can have a login in
// several companies; when the password fits two or more of them, the sign-in page asks which one, and this ticket carries
// that answer back so the password is not sent again or kept in the page. It is only ever made AFTER a right password
// (src/lib/sign-in.ts signInStep), and it holds:
//   - the logins the password fit (id and sessionVersion), so a password reset or a sign-out since ends it;
//   - an expiry (5 minutes) and an id that works once (kept in memory on globalThis, like the sign-in counts: a restart
//     forgets, and by then the 5 minutes are nearly over);
//   - for the chooser, a hash of a random value kept in an httpOnly cookie of the browser that typed the password, so the
//     ticket does not work from another browser even if its text leaks (the page address carries it).
// It is signed (HMAC-SHA256 keyed from AUTH_SECRET), so it can't be made or changed by anyone else. A ticket without a
// browser binding (b = null) is made and used inside one server action and never leaves the server (a single match).
import crypto from "node:crypto";

export const TICKET_MINUTES = 5;
const LIFE = TICKET_MINUTES * 60_000;
const MAX_USED = 10_000;

export type TicketPayload = { v: 1; exp: number; jti: string; b: string | null; l: [string, number][] };

/** The cookie that binds a chooser ticket to the browser: the Windows program's AUTH_COOKIE_PREFIX, as known-device does. */
export function choiceCookieName(): string {
  const own = (process.env.AUTH_COOKIE_PREFIX ?? "").replace(/[^a-z0-9]/gi, "");
  return own ? `${own}.signin-choice` : "signin-choice";
}

function key(): Buffer | null {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update("stitchbench signin-choice v1").digest();
}

const sign = (k: Buffer, body: string) => crypto.createHmac("sha256", k).update(body).digest("base64url");
export const bindingOf = (nonce: string) => crypto.createHash("sha256").update(nonce).digest("base64url");
export const newNonce = () => crypto.randomBytes(24).toString("base64url");

const used: Map<string, number> = ((globalThis as unknown as { __signInTickets?: Map<string, number> }).__signInTickets ??= new Map());

/** A signed ticket for these logins, or null without AUTH_SECRET. `nonce` is the browser's cookie value, or null (never leaves the server). */
export function mintTicket(logins: { id: string; sv: number }[], nonce: string | null, now = Date.now()): string | null {
  const k = key();
  if (!k || logins.length === 0) return null;
  const payload: TicketPayload = { v: 1, exp: now + LIFE, jti: crypto.randomBytes(16).toString("base64url"), b: nonce ? bindingOf(nonce) : null, l: logins.map((l) => [l.id, l.sv]) };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(k, body)}`;
}

/**
 * The ticket's contents when it is genuine, not expired, not used, and (for a bound one) this browser's cookie `nonce`
 * fits; otherwise null. Does not use it up (the chooser page reads it to show the company names).
 */
export function readTicket(ticket: unknown, nonce: string | null | undefined, now = Date.now()): TicketPayload | null {
  const k = key();
  if (!k || typeof ticket !== "string" || ticket.length > 4000) return null;
  const dot = ticket.indexOf(".");
  if (dot < 1) return null;
  const body = ticket.slice(0, dot);
  const want = Buffer.from(sign(k, body));
  const got = Buffer.from(ticket.slice(dot + 1));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let p: TicketPayload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!p || p.v !== 1 || typeof p.exp !== "number" || typeof p.jti !== "string" || !Array.isArray(p.l)) return null;
  if (!(p.exp > now) || p.exp > now + LIFE + 60_000) return null;
  if (!p.l.every((e) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number")) return null;
  if (p.b !== null) {
    if (typeof p.b !== "string" || !nonce) return null;
    const a = Buffer.from(bindingOf(nonce));
    const b = Buffer.from(p.b);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  }
  if (used.has(p.jti)) return null;
  return p;
}

/** Uses the ticket up: true the first time, false for a second use. */
export function spendTicket(p: TicketPayload, now = Date.now()): boolean {
  if (used.has(p.jti)) return false;
  for (const [j, exp] of used) {
    if (exp <= now || used.size >= MAX_USED) used.delete(j);
    else break; // oldest first: the rest are newer
  }
  used.set(p.jti, p.exp);
  return true;
}
