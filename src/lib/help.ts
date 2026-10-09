import "server-only";
// The Help button and the error alerts (docs/plans/help-feedback-design.md sections 1-3): what a person sends ("Something's
// wrong", "I have an idea", "Rate the program") and the errors the program notices go into HelpOutbox, and from there to
// the hub (POST /v1/feedback) with the background sync, or right away when the hub answers. Nothing here ever stops the
// work it reports on: recording an error never throws.
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { hubJoined, hubOfflineSince, hubFetch, hubStatus, inBackground } from "@/lib/hub";
import { isDesktop } from "@/lib/modules";
import { appName, programVersion } from "@/lib/shops";
import { UserError } from "@/lib/user-error";
import type { Prisma } from "@/generated/prisma/client";

export type HelpKind = "help" | "idea" | "rating" | "error";
export const HELP_TEXT_MAX = 4000;
/** The hub takes a picture up to 1 MB; the browser aims for 800 KB. */
export const HELP_PICTURE_MAX = 1024 * 1024;
const KEPT_DAYS = 30;
const GIVE_UP_TRIES = 5;
/** Distinct errors a company keeps a day (each counted, not repeated): a loop of new errors can't fill the database. */
const ERRORS_A_DAY = 100;

export type HelpContext = {
  program: string;
  version: string | null;
  path: string | null;
  role: string | null;
  desktop: boolean;
  userAgent: string | null;
  screen: string | null;
  shopName?: string | null;
};

// ---------- no customer data ----------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A card number: 13 to 19 digits, maybe in groups.
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const DIGITS_RE = /\b\d{7,}\b/g;

/** Email addresses, card and phone numbers and long digit runs out of a message or stack, before it is kept or sent. */
export function scrub(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(EMAIL_RE, "[email]")
    .replace(CARD_RE, "[number]")
    .replace(PHONE_RE, "[phone]")
    .replace(DIGITS_RE, "[number]");
}

/** A page path without its query string or hash, at most 300 characters. */
export function cleanPath(p: unknown): string | null {
  const s = String(p ?? "").split(/[?#]/)[0].trim();
  if (!s.startsWith("/")) return null;
  return scrub(s.slice(0, 300));
}

const short = (v: unknown, max: number) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** What goes with every item about where it came from (the person's role, not their name). */
export function helpContext(o: { path?: unknown; role?: string | null; userAgent?: unknown; screen?: unknown; shopName?: string | null }): HelpContext {
  return {
    program: appName(),
    version: programVersion(),
    path: cleanPath(o.path),
    role: o.role ?? null,
    desktop: isDesktop(),
    userAgent: short(o.userAgent, 300),
    screen: short(o.screen, 30)?.replace(/[^0-9x@.]/g, "") || null,
    shopName: o.shopName ?? null,
  };
}

// ---------- errors ----------

export type ErrorReport = { message?: unknown; stack?: unknown; digest?: unknown; action?: unknown };

/** The first "at ..." line of a stack: with the message, what says two errors are the same one. */
function firstFrame(stack: string): string {
  return (
    stack
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("at ")) ?? ""
  );
}

const ymd = (d = new Date()) => d.toISOString().slice(0, 10);

// What the server knew about an error a page showed (onRequestError, src/instrumentation.ts): in production the browser
// only gets the digest, so the message and stack are looked up here when the page reports it. A few minutes, 200 at most.
const seen = ((globalThis as unknown as { __helpDigests?: Map<string, { message: string; stack: string; at: number }> }).__helpDigests ??= new Map());

export function rememberDigest(digest: string | undefined, err: { message?: string; stack?: string }) {
  if (!digest || /^NEXT_|^BAILOUT_|^DYNAMIC_SERVER_USAGE/.test(digest)) return;
  seen.set(digest, { message: String(err.message ?? ""), stack: String(err.stack ?? ""), at: Date.now() });
  if (seen.size > 200) seen.delete(seen.keys().next().value as string);
}

function knownDigest(digest: string | null) {
  if (!digest) return null;
  const k = seen.get(digest);
  return k && Date.now() - k.at < 15 * 60_000 ? k : null;
}

/** Next's own control flow (redirect, notFound, dynamic rendering), not an error. */
export function isNextControl(e: unknown): boolean {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === "string" && /^(NEXT_|BAILOUT_TO_CLIENT_SIDE_RENDERING|DYNAMIC_SERVER_USAGE)/.test(d);
}

/**
 * Keeps an error for the hub: message and the first 20 stack lines, with customer data taken out; the same error on the
 * same day adds to its count. Never throws.
 */
export async function recordError(shopId: string, report: ErrorReport, ctx: HelpContext): Promise<void> {
  try {
    const digest = short(report.digest, 100);
    const known = knownDigest(digest);
    const message = scrub(short(known?.message || report.message, 1000) ?? "Unknown error");
    const stack = scrub(
      String(known?.stack || report.stack || "")
        .split("\n")
        .slice(0, 20)
        .join("\n")
        .slice(0, 6000),
    );
    const fingerprint = createHash("sha256").update(`${message}\n${firstFrame(stack)}`).digest("hex").slice(0, 32);
    const day = ymd();
    const payload = { context: ctx, error: { message, stack, digest, action: short(report.action, 100) } } as unknown as Prisma.InputJsonValue;
    const existing = await db.helpOutbox.findUnique({ where: { shopId_kind_fingerprint_day: { shopId, kind: "error", fingerprint, day } }, select: { id: true } });
    if (existing) {
      // Already sent: the hub adds this count to its own, so the row counts from 1 again and goes once more.
      await db.$executeRaw`UPDATE "HelpOutbox" SET "count" = CASE WHEN "sentAt" IS NULL THEN "count" + 1 ELSE 1 END, "sentAt" = NULL, "tries" = 0, "lastError" = NULL WHERE "id" = ${existing.id}`;
    } else {
      if ((await db.helpOutbox.count({ where: { shopId, kind: "error", day } })) >= ERRORS_A_DAY) return;
      await db.helpOutbox.create({ data: { shopId, kind: "error", payload, fingerprint, day } }).catch(async (e: unknown) => {
        // The same error twice at once: the other one made the row, so this one counts.
        if ((e as { code?: string }).code !== "P2002") throw e;
        await db.$executeRaw`UPDATE "HelpOutbox" SET "count" = "count" + 1 WHERE "shopId" = ${shopId} AND "kind" = 'error' AND "fingerprint" = ${fingerprint} AND "day" = ${day} AND "sentAt" IS NULL`;
      });
    }
    sendHelpSoon();
  } catch (e) {
    console.error("help: an error couldn't be recorded:", e instanceof Error ? e.message : e);
  }
}

/** An error thrown by a server action (safe(), src/lib/action.ts) that isn't one the person can fix. Never throws. */
export async function recordActionError(user: { shopId: string; role: string }, action: string, e: unknown): Promise<void> {
  if (isNextControl(e)) return;
  let path: string | null = null;
  let userAgent: string | null = null;
  try {
    // The page the action was sent from: the browser sends it as the Referer (its query string is dropped).
    const h = await (await import("next/headers")).headers();
    const ref = h.get("referer");
    path = ref ? new URL(ref).pathname : null;
    userAgent = h.get("user-agent");
  } catch {
    /* not in a request */
  }
  const err = e instanceof Error ? e : new Error(String(e));
  await recordError(user.shopId, { message: err.message, stack: err.stack, digest: (err as { digest?: string }).digest, action: action || null }, helpContext({ path, role: user.role, userAgent }));
}

// ---------- what a person sends ----------

export type HelpInput = {
  kind: "help" | "idea" | "rating";
  text: string | null;
  stars: number | null;
  quoteOk: boolean;
  replyTo: string | null;
  picture: Uint8Array | null;
};

/** Checks what the Help panel sent and keeps it for the hub. */
export async function addHelpItem(shopId: string, input: HelpInput, ctx: HelpContext): Promise<string> {
  const text = input.text?.trim().slice(0, HELP_TEXT_MAX + 1) || null;
  if (text && text.length > HELP_TEXT_MAX) throw new UserError(`Please keep it under ${HELP_TEXT_MAX.toLocaleString("en-US")} characters.`);
  if (input.kind === "help" && !text) throw new UserError("Please tell us what happened.");
  if (input.kind === "idea" && !text) throw new UserError("Please tell us your idea.");
  let stars: number | null = null;
  if (input.kind === "rating") {
    stars = Math.round(Number(input.stars));
    if (!(stars >= 1 && stars <= 5)) throw new UserError("Please pick 1 to 5 stars.");
  }
  let picture: Uint8Array | null = null;
  if (input.kind === "help" && input.picture?.length) {
    const p = input.picture;
    // A JPEG starts FF D8 FF; anything else, or too big, is left out rather than refused (the words matter most).
    if (p.length <= HELP_PICTURE_MAX && p[0] === 0xff && p[1] === 0xd8 && p[2] === 0xff) picture = p;
  }
  const payload: Record<string, unknown> = { context: ctx };
  if (text) payload.text = text;
  if (stars) payload.stars = stars;
  if (input.kind === "rating") payload.quoteOk = input.quoteOk;
  if (input.kind !== "rating" && input.replyTo) payload.replyTo = input.replyTo;
  const row = await db.helpOutbox.create({
    data: { shopId, kind: input.kind, payload: payload as Prisma.InputJsonValue, picture: picture ? new Uint8Array(picture) : null },
    select: { id: true },
  });
  sendHelpSoon();
  return row.id;
}

// ---------- sending ----------

/** Right away, in the background, when the hub is joined and not known to be down; otherwise the next sync sends it. */
export function sendHelpSoon() {
  if (hubOfflineSince()) return;
  void hubJoined()
    .then((on) => (on ? pushHelp() : 0))
    .catch((e: unknown) => console.error("help: sending:", e instanceof Error ? e.message : e));
}

const shared = globalThis as unknown as { __helpPush?: Promise<number> | null; __helpAgain?: boolean };

/**
 * Sends what's waiting, one push at a time across the copies of this module Next loads. Asked again while one runs (a
 * new item, an error counted again), it goes round once more when that one ends. Returns how many went.
 */
export function pushHelp(): Promise<number> {
  if (shared.__helpPush) {
    shared.__helpAgain = true;
    return shared.__helpPush;
  }
  const run = async () => {
    let n = 0;
    do {
      shared.__helpAgain = false;
      n += await sendWaiting();
    } while (shared.__helpAgain);
    return n;
  };
  shared.__helpPush = inBackground(run).finally(() => {
    shared.__helpPush = null;
  });
  return shared.__helpPush;
}

let prunedAt = 0;

async function sendWaiting(): Promise<number> {
  if (!(await hubJoined())) return 0;
  if (Date.now() - prunedAt > 3600_000) {
    prunedAt = Date.now();
    const old = new Date(Date.now() - KEPT_DAYS * 86400_000);
    await db.helpOutbox.deleteMany({ where: { OR: [{ sentAt: { lt: old } }, { sentAt: null, tries: { gte: GIVE_UP_TRIES }, createdAt: { lt: old } }] } }).catch(() => {});
  }
  const waiting = await db.helpOutbox.findMany({
    where: { sentAt: null, tries: { lt: GIVE_UP_TRIES } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
    take: 50,
  });
  let sent = 0;
  for (const w of waiting) {
    const row = await db.helpOutbox.findUnique({ where: { id: w.id } });
    if (!row || row.sentAt) continue;
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const item = {
      kind: row.kind,
      ...p,
      ...(row.kind === "error" ? { fingerprint: row.fingerprint, day: row.day, count: row.count } : {}),
    };
    const fd = new FormData();
    fd.set("item", JSON.stringify(item));
    if (row.picture?.length) fd.set("picture", new Blob([new Uint8Array(row.picture)], { type: "image/jpeg" }), "screen.jpg");
    try {
      await hubFetch("/v1/feedback", { method: "POST", body: fd, shopRef: row.shopId, signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      const status = hubStatus(e);
      // Busy (429), broken (5xx), out of reach (0), refusing this install (401, 403) or too old to know feedback (404):
      // nothing is this item's fault; everything waits for the next sync.
      if (status === 0 || status === 429 || status >= 500 || status === 401 || status === 403 || status === 404 || status === 408) break;
      await db.helpOutbox.update({ where: { id: row.id }, data: { tries: { increment: 1 }, lastError: scrub(e instanceof Error ? e.message : String(e)).slice(0, 500) } });
      continue;
    }
    // Sent. An error that happened again while it was on its way keeps those new counts, and goes again.
    const done = await db.helpOutbox.updateMany({ where: { id: row.id, count: row.count }, data: { sentAt: new Date(), picture: null, lastError: null } });
    if (!done.count) await db.helpOutbox.update({ where: { id: row.id }, data: { count: { decrement: row.count }, picture: null } });
    sent++;
  }
  return sent;
}

/** Help items not sent yet for a company (shown in the panel as "waiting to go"). */
export async function helpWaiting(shopId: string) {
  return db.helpOutbox.count({ where: { shopId, sentAt: null, kind: { not: "error" }, tries: { lt: GIVE_UP_TRIES } } });
}
