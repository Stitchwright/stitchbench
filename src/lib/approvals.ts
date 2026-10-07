import "server-only";
// Approvals for a refund or a discount over the store's limit (shop-features-round-2-design.md 7.5). The store's
// limits (Settings -> Stores: "refunds over $200", "discounts over 20%") stop the register with two ways on: a manager
// there enters her code (an owner or admin with an approval code set), or "Ask the owner": the owner gets an email with
// a link (she signs in), sees the sale and the reason, and taps Approve or Not this time; the register moves on by
// itself. An approval is used once, by the sale it was asked for (same kind, the amount no bigger).
import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { money } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import type { Store } from "@/lib/stores";
import { queueToAddress } from "@/lib/messaging/queue";
import { publicBaseUrl } from "@/lib/messaging/settings";
import { actorOf, audit } from "@/lib/audit";

type Tx = Prisma.TransactionClient;

/** How long an asked approval waits for the owner, and an approved one for its sale. */
export const ASK_MINUTES = 60;

export type Need = { kind: "REFUND" | "DISCOUNT"; amountCents: number; pct: number | null };

/** What a sale asks for, against the store's limits (pure): the first limit it goes over, or null. */
export function overLimit(store: Pick<Store, "approveRefundCents" | "approveDiscountPct"> | null, s: { refundCents: number; discountCents: number; grossCents: number }): Need | null {
  if (!store) return null;
  if (store.approveRefundCents != null && s.refundCents > store.approveRefundCents) return { kind: "REFUND", amountCents: s.refundCents, pct: null };
  if (store.approveDiscountPct != null && s.discountCents > 0 && s.grossCents > 0) {
    const pct = Math.round((s.discountCents / s.grossCents) * 1000) / 10;
    if (pct > store.approveDiscountPct) return { kind: "DISCOUNT", amountCents: s.discountCents, pct };
  }
  return null;
}

/** The words for what needs approving: "a refund of $250.00" / "a 25% discount ($40.00)". */
export function needWords(n: { kind: string; amountCents: number; pct: number | null }): string {
  return n.kind === "REFUND" ? `a refund of ${money(n.amountCents)}` : `a ${n.pct ?? 0}% discount (${money(n.amountCents)})`;
}

/**
 * The approval a sale over the limit uses (its id), or null when the sale is within the limits. Refused with the two
 * ways on when it needs one and has none that fits (approved, unused, not run out, this kind, at least this much).
 */
export async function approvalFor(user: CurrentUser, store: Store | null, s: { refundCents: number; discountCents: number; grossCents: number }, approvalId: string | null | undefined): Promise<string | null> {
  const need = overLimit(store, s);
  if (!need) return null;
  if (typeof approvalId === "string" && approvalId) {
    const a = await db.approval.findFirst({ where: { id: approvalId, shopId: user.shopId, status: "APPROVED", kind: need.kind, usedAt: null } });
    if (a && a.expiresAt > new Date() && a.amountCents >= need.amountCents - 1 && (need.pct == null || (a.pct ?? 0) + 0.05 >= need.pct)) return a.id;
  }
  throw new UserError(`This is ${needWords(need)}, over this store's limit. A manager can enter her code, or ask the owner.`);
}

/** The sale used its approval (once: two sales can't share one). */
export async function useApproval(tx: Tx, shopId: string, id: string, saleId: string): Promise<void> {
  const r = await tx.approval.updateMany({ where: { id, shopId, status: "APPROVED", usedAt: null }, data: { status: "USED", usedAt: new Date(), note: `Sale ${saleId}` } });
  if (!r.count) throw new UserError("That approval was used already. Ask again.");
}

function cleanNeed(n: unknown): Need {
  const x = (n ?? {}) as Partial<Need>;
  const kind = x.kind === "REFUND" ? "REFUND" : x.kind === "DISCOUNT" ? "DISCOUNT" : null;
  const amountCents = Math.round(Number(x.amountCents));
  if (!kind || !Number.isFinite(amountCents) || amountCents <= 0 || amountCents > 10_000_000) throw new UserError("Nothing to approve.");
  const pct = x.pct == null ? null : Math.round(Number(x.pct) * 10) / 10;
  return { kind, amountCents, pct: pct != null && Number.isFinite(pct) ? pct : null };
}

export type DraftLine = { description: string; qty: number; unitPriceCents: number; discountCents?: number };

function cleanDraft(d: unknown): { lines: DraftLine[]; customer: string | null; totalCents: number | null } {
  const x = (d ?? {}) as { lines?: unknown; customer?: unknown; totalCents?: unknown };
  const lines = (Array.isArray(x.lines) ? x.lines : []).slice(0, 40).map((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    return { description: String(o.description ?? "").slice(0, 120), qty: Number(o.qty) || 0, unitPriceCents: Math.round(Number(o.unitPriceCents) || 0), discountCents: Math.round(Number(o.discountCents) || 0) };
  });
  return { lines, customer: typeof x.customer === "string" ? x.customer.slice(0, 120) : null, totalCents: Number.isFinite(Number(x.totalCents)) ? Math.round(Number(x.totalCents)) : null };
}

const hashCode = (code: string, salt: string) => crypto.scryptSync(code, salt, 32).toString("hex");

/** A manager's approval code, stored hashed ("scrypt:salt:hash"). 6 to 8 digits (codes set before, 4 or 5, still work until changed). */
export function sealCode(code: string): string {
  const c = code.trim();
  if (!/^\d{6,8}$/.test(c)) throw new UserError("An approval code is 6 to 8 numbers.");
  const salt = crypto.randomBytes(12).toString("hex");
  return `scrypt:${salt}:${hashCode(c, salt)}`;
}

export function codeMatches(stored: string | null, code: string): boolean {
  if (!stored) return false;
  const [kind, salt, hash] = stored.split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const got = Buffer.from(hashCode(code.trim(), salt), "hex");
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Sets or clears the signed-in owner's or admin's own approval code. */
export async function setApproveCodeFor(user: CurrentUser, code: string | null): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin approves refunds and discounts.");
  await db.user.updateMany({ where: { id: user.id, shopId: user.shopId }, data: { approveCode: code ? sealCode(code) : null, approveCodeOld: false } });
}

/** Wrong codes in a row before the wait, and the wait. */
export const CODE_TRIES = 5;
export const CODE_LOCK_MINUTES = 15;

/**
 * One try at a code, counted in the database before the code is checked (so tries at the same moment all count), for
 * the person typing and for the store's register: false when either is waiting out a lock, or this try is past the
 * five (the lock starts now).
 */
async function takeTry(table: "User" | "Location", id: string, now: Date): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<{ n: number }[]>(
    `UPDATE "${table}" SET "approveFails" = "approveFails" + 1 WHERE "id" = $1 AND ("approveLockedUntil" IS NULL OR "approveLockedUntil" <= $2) RETURNING "approveFails" AS n`,
    id,
    now,
  );
  if (!rows.length) return false;
  if (rows[0].n > CODE_TRIES) {
    await db.$executeRawUnsafe(`UPDATE "${table}" SET "approveFails" = 0, "approveLockedUntil" = $2 WHERE "id" = $1`, id, new Date(now.getTime() + CODE_LOCK_MINUTES * 60_000));
    return false;
  }
  return true;
}

async function missed(table: "User" | "Location", id: string, now: Date): Promise<void> {
  // The fifth wrong code in a row starts the wait.
  await db.$executeRawUnsafe(`UPDATE "${table}" SET "approveFails" = 0, "approveLockedUntil" = $2 WHERE "id" = $1 AND "approveFails" >= $3`, id, new Date(now.getTime() + CODE_LOCK_MINUTES * 60_000), CODE_TRIES);
}

async function rightCode(table: "User" | "Location", id: string): Promise<void> {
  await db.$executeRawUnsafe(`UPDATE "${table}" SET "approveFails" = 0 WHERE "id" = $1`, id);
}

/** "A manager enters her code": approved at once, by the manager whose code it is (an owner or admin of this company). */
export async function approveWithCodeFor(user: CurrentUser, store: Store | null, needIn: unknown, code: string, reason: string | null, draft: unknown, now = new Date()): Promise<string> {
  const need = cleanNeed(needIn);
  // Five wrong codes in a row, by this person or at this store's register: a 15-minute wait (counted in the database).
  const counters: ["User" | "Location", string][] = [["User", user.id], ...(store ? [["Location", store.id] as ["Location", string]] : [])];
  for (const [t, id] of counters) {
    if (!(await takeTry(t, id, now))) throw new UserError(`Too many wrong codes. Wait ${CODE_LOCK_MINUTES} minutes and try again, or ask the owner.`);
  }
  const managers = await db.user.findMany({ where: { shopId: user.shopId, active: true, role: { in: ["OWNER", "ADMIN"] }, approveCode: { not: null } }, select: { id: true, name: true, role: true, approveCode: true } });
  const who = managers.find((u) => codeMatches(u.approveCode, String(code ?? "")));
  if (!who) {
    for (const [t, id] of counters) await missed(t, id, now);
    throw new UserError("That code isn't right.");
  }
  for (const [t, id] of counters) await rightCode(t, id);
  const a = await db.approval.create({
    data: { shopId: user.shopId, locationId: store?.id ?? null, kind: need.kind, amountCents: need.amountCents, pct: need.pct, reason: reason?.slice(0, 300) || null, draft: cleanDraft(draft) as Prisma.InputJsonValue, requestedById: user.id, status: "APPROVED", decidedById: who.id, decidedAt: now, note: "Manager's code", expiresAt: new Date(now.getTime() + ASK_MINUTES * 60_000) },
  });
  await audit(db, actorOf(user), { action: "approval.code", subjectType: "Approval", subjectId: a.id, subjectLabel: `Approved by ${who.name} at the register`, amountCents: need.amountCents, reason: reason?.slice(0, 200) || null });
  return a.id;
}

/** "Ask the owner": the request is saved and every owner gets an email with the link (she signs in to answer). */
export async function askOwnerFor(user: CurrentUser, store: Store | null, needIn: unknown, reason: string | null, draft: unknown, now = new Date()): Promise<{ id: string; told: number }> {
  const need = cleanNeed(needIn);
  const a = await db.approval.create({
    data: { shopId: user.shopId, locationId: store?.id ?? null, kind: need.kind, amountCents: need.amountCents, pct: need.pct, reason: reason?.slice(0, 300) || null, draft: cleanDraft(draft) as Prisma.InputJsonValue, requestedById: user.id, status: "ASKED", expiresAt: new Date(now.getTime() + ASK_MINUTES * 60_000) },
  });
  const owners = await db.user.findMany({ where: { shopId: user.shopId, active: true, role: "OWNER" }, select: { id: true, email: true } });
  const base = publicBaseUrl();
  const link = base ? `${base}/today/approvals/${a.id}` : null;
  let told = 0;
  for (const o of owners) {
    if (!o.email) continue;
    const body = [`${user.name}${store ? ` at ${store.name}` : ""} asks you to approve ${needWords(need)}.`, reason ? `Reason: ${reason}` : null, link ? `Approve or not: ${link}` : "Open StitchBench, Today, to approve or not.", `It waits ${ASK_MINUTES} minutes.`].filter(Boolean).join("\n\n");
    const q = await queueToAddress(db, { shopId: user.shopId, kind: "owner_notice", channel: "email", address: o.email, content: { subject: `Approve ${needWords(need)}?`, body }, dedupeKey: `approval:${a.id}:${o.id}`, refType: "approval", refId: a.id, byUserId: user.id }).catch(() => ({ id: null }));
    if (q.id) told += 1;
  }
  return { id: a.id, told };
}

/** Where an approval stands, for the register waiting on it (this company's only). */
export async function approvalState(user: CurrentUser, id: string, now = new Date()): Promise<{ status: string; by: string | null; note: string | null }> {
  const a = await db.approval.findFirst({ where: { id: String(id), shopId: user.shopId } });
  if (!a) throw new UserError("Approval not found.");
  if (a.status === "ASKED" && a.expiresAt <= now) {
    await db.approval.updateMany({ where: { id: a.id, status: "ASKED" }, data: { status: "EXPIRED" } });
    return { status: "EXPIRED", by: null, note: null };
  }
  const by = a.decidedById ? ((await db.user.findFirst({ where: { id: a.decidedById, shopId: user.shopId }, select: { name: true } }))?.name ?? null) : null;
  return { status: a.status, by, note: a.note };
}

/** The owner's answer: Approve or Not this time (an owner only; once). */
export async function decideApprovalFor(user: CurrentUser, id: string, yes: boolean, note: string | null, now = new Date()): Promise<void> {
  if (user.role !== "OWNER") throw new UserError("Only the owner answers these.");
  const a = await db.approval.findFirst({ where: { id: String(id), shopId: user.shopId } });
  if (!a) throw new UserError("Approval not found.");
  if (a.status !== "ASKED") throw new UserError(a.status === "EXPIRED" ? "That one ran out: the register can ask again." : "That one is answered already.");
  if (a.expiresAt <= now) {
    await db.approval.updateMany({ where: { id: a.id, status: "ASKED" }, data: { status: "EXPIRED" } });
    throw new UserError("That one ran out: the register can ask again.");
  }
  const r = await db.approval.updateMany({
    where: { id: a.id, shopId: user.shopId, status: "ASKED" },
    data: { status: yes ? "APPROVED" : "REFUSED", decidedById: user.id, decidedAt: now, note: note?.slice(0, 300) || null, expiresAt: yes ? new Date(now.getTime() + ASK_MINUTES * 60_000) : a.expiresAt },
  });
  if (!r.count) throw new UserError("That one is answered already.");
  await audit(db, actorOf(user), { action: yes ? "approval.yes" : "approval.no", subjectType: "Approval", subjectId: a.id, subjectLabel: needWords(a), amountCents: a.amountCents, reason: note?.slice(0, 200) || null });
}

export type ApprovalView = { id: string; kind: string; amountCents: number; pct: number | null; words: string; reason: string | null; status: string; storeId: string | null; askedBy: string | null; at: Date; expiresAt: Date; draft: ReturnType<typeof cleanDraft> };

/** Approvals waiting for the owner (Today page). */
export async function waitingApprovals(shopId: string, now = new Date()): Promise<ApprovalView[]> {
  const rows = await db.approval.findMany({ where: { shopId, status: "ASKED", expiresAt: { gt: now } }, orderBy: { createdAt: "asc" }, take: 50 });
  const names = new Map((await db.user.findMany({ where: { shopId, id: { in: rows.map((r) => r.requestedById).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return rows.map((r) => ({ id: r.id, kind: r.kind, amountCents: r.amountCents, pct: r.pct, words: needWords(r), reason: r.reason, status: r.status, storeId: r.locationId, askedBy: r.requestedById ? (names.get(r.requestedById) ?? null) : null, at: r.createdAt, expiresAt: r.expiresAt, draft: cleanDraft(r.draft) }));
}

export async function approvalView(shopId: string, id: string): Promise<ApprovalView | null> {
  const r = await db.approval.findFirst({ where: { id, shopId } });
  if (!r) return null;
  const by = r.requestedById ? ((await db.user.findFirst({ where: { id: r.requestedById, shopId }, select: { name: true } }))?.name ?? null) : null;
  return { id: r.id, kind: r.kind, amountCents: r.amountCents, pct: r.pct, words: needWords(r), reason: r.reason, status: r.status, storeId: r.locationId, askedBy: by, at: r.createdAt, expiresAt: r.expiresAt, draft: cleanDraft(r.draft) };
}
