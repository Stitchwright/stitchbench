import "server-only";
// The shop's side of StitchHub's v2 queue for MakerFoundry orders (docs/plans/makerfoundry-orders-plan.md package 1; the hub's side is
// StitchHub src/sync.mjs, docs/hub-sync-design.md). Polling, nothing reachable from outside, so a shop on a PC behind a router works:
//   hello    says which message types this program understands (and learns the hub's minimum version: 426 = please update);
//   poll     takes what the hub holds for the company after the stored cursor, KEEPS each message in SyncIn, then tells the hub;
//   apply    applies the kept messages one conversation at a time in seq order (a later one waits for an earlier one, a day at most);
//   send     the company's own messages (SyncOut) go with the ids and seqs they were made with, again and again until the hub takes them.
// A message is acknowledged once it is stored here, not once it is applied: a held message must not make the hub give up on it and tell
// MakerFoundry the shop never answered. Duplicates are dropped by message id; an old copy of a seq already applied is acknowledged and ignored.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { HubError, hubJoined, hubStatus, inBackground } from "@/lib/hub";
import { backoff, plain, v2, clientVersion } from "@/lib/shop-orders/hubv2";
import { withLease } from "@/lib/lease";
import { parseBody, UNDERSTOOD } from "@/lib/shop-orders/contract";
import { clearShippedAddresses } from "@/lib/shop-orders/handover";
import { retryPendingFiles } from "@/lib/shop-orders/intake";
import { parseEnvelope, planApply, senderKind } from "@/lib/shop-orders/protocol";
import { handlerFor, type Applied } from "@/lib/shop-orders/handlers";

import { SERVICE } from "@/lib/shop-orders/outbox";
const PAGE = 50;
const MAX_PAGES = 10;
const HELLO_EVERY_MS = 6 * 3600_000;

export async function ordersSyncRow(shopId: string) {
  return db.shopOrdersSync.upsert({ where: { shopId }, create: { shopId }, update: {} });
}

// ---------------------------------------------------------------------------------------------------------------
// hello

/** Tells the hub what this program understands. A 426 is kept for the owner to read and stops sending until an update. */
export async function sayHello(shopId: string): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    await v2(shopId, "/v2/hello", { method: "POST", json: { app: "stitchshop", version: clientVersion(), types: UNDERSTOOD } });
    await db.shopOrdersSync.update({ where: { shopId }, data: { helloAt: new Date(), upgradeNeeded: null } });
    return { ok: true };
  } catch (e) {
    if (hubStatus(e) === 426) {
      const why = `StitchHub needs a newer StitchShop to take MakerFoundry orders. ${plain(e)}`.slice(0, 300);
      await db.shopOrdersSync.update({ where: { shopId }, data: { upgradeNeeded: why } });
      return { ok: false, why };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// poll: store, then tell the hub

/** Takes what the hub holds for the company into SyncIn (and moves the cursor in the same transaction). Returns how many new messages. */
export async function pollShop(shopId: string): Promise<number> {
  let fresh = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const row = await ordersSyncRow(shopId);
    let j: { messages?: unknown; next?: unknown };
    try {
      j = (await (await v2(shopId, `/v2/messages?after=${encodeURIComponent(row.cursor)}&limit=${PAGE}`)).json()) as typeof j;
    } catch (e) {
      // 409 hello_first: the hub forgot this program (a restored backup, a new hub): say hello again and try the next run.
      if (hubStatus(e) === 409) await db.shopOrdersSync.update({ where: { shopId }, data: { helloAt: null } });
      throw e;
    }
    const raw = Array.isArray(j.messages) ? j.messages.slice(0, PAGE) : [];
    const envs = raw.map(parseEnvelope).filter((e): e is NonNullable<typeof e> => e !== null);
    const next = typeof j.next === "string" && /^\d{1,18}$/.test(j.next) ? j.next : row.cursor;
    await db.$transaction(async (tx) => {
      for (const e of envs) {
        const made = await tx.syncIn.createMany({
          data: [{ shopId, messageId: e.id, sender: e.from, conversation: e.conversation, seq: e.seq, type: e.type, version: e.version, body: (e.body ?? {}) as Prisma.InputJsonValue, sentAt: e.createdAt, expiresAt: e.expiresAt }],
          skipDuplicates: true,
        });
        fresh += made.count;
      }
      // Never go backwards (a hub restored from a backup could answer with a smaller cursor; the dedupe above makes a repeat harmless).
      if (BigInt(next) > BigInt(row.cursor)) await tx.shopOrdersSync.update({ where: { shopId }, data: { cursor: next } });
    });
    await ackStored(shopId);
    if (raw.length < PAGE) break;
  }
  return fresh;
}

/** Tells the hub about every stored message it hasn't been told of (a failed ack is tried again next run, not forgotten). */
export async function ackStored(shopId: string): Promise<void> {
  for (;;) {
    const rows = await db.syncIn.findMany({ where: { shopId, ackedAt: null }, select: { id: true, messageId: true }, orderBy: { receivedAt: "asc" }, take: 100 });
    if (!rows.length) return;
    await v2(shopId, "/v2/messages/ack", { method: "POST", json: { ids: rows.map((r) => r.messageId) } });
    await db.syncIn.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { ackedAt: new Date() } });
    if (rows.length < 100) return;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// apply, in order

/**
 * Applies the kept messages, one conversation of one sender at a time, in seq order. A message whose handler says "defer" (what it needs
 * hasn't been applied yet, such as a status for an order not created) waits and is tried again later; one whose type or body can't be
 * understood is skipped with a reason, so one bad message never stops the ones behind it.
 */
export async function applyWaiting(shopId: string, now = Date.now()): Promise<{ applied: number; skipped: number; waiting: number }> {
  const out = { applied: 0, skipped: 0, waiting: 0 };
  const groups = await db.syncIn.groupBy({ by: ["sender", "conversation"], where: { shopId, appliedAt: null }, _count: true });
  for (const g of groups) {
    for (let guard = 0; guard < 200; guard++) {
      const rows = await db.syncIn.findMany({ where: { shopId, sender: g.sender, conversation: g.conversation, appliedAt: null }, orderBy: [{ seq: "asc" }, { receivedAt: "asc" }], take: 200 });
      if (!rows.length) break;
      const track = await db.syncInSeq.upsert({ where: { shopId_sender_conversation: { shopId, sender: g.sender, conversation: g.conversation } }, create: { shopId, sender: g.sender, conversation: g.conversation }, update: {} });
      const plan = planApply(track.nextSeq, rows.map((r) => ({ id: r.id, seq: r.seq, receivedAt: r.receivedAt.getTime() })), now);
      const byId = new Map(rows.map((r) => [r.id, r]));
      // An old copy of a seq already applied (or a second message claiming one seq): nothing to apply.
      for (const s of plan.stale) {
        await db.syncIn.update({ where: { id: s.id }, data: { appliedAt: new Date(), result: "skipped", error: "A message with this seq was already applied." } });
        out.skipped += 1;
      }
      let progressed = plan.stale.length > 0;
      let blocked = false;
      for (const d of plan.due) {
        const row = byId.get(d.id);
        if (!row) continue;
        const r = await applyOne(shopId, row, plan.gapped);
        if (r === "defer") {
          // Later messages of this conversation wait for it (their seq comes after).
          blocked = true;
          out.waiting += 1;
          break;
        }
        out[r === "applied" ? "applied" : "skipped"] += 1;
        progressed = true;
      }
      if (blocked || !progressed) {
        out.waiting += rows.length - plan.due.length - plan.stale.length;
        break;
      }
    }
  }
  return out;
}

async function applyOne(shopId: string, row: { id: string; sender: string; conversation: string; seq: number; type: string; version: number; body: unknown; messageId: string; sentAt: Date; tries: number }, gapped: boolean): Promise<Applied | "skipped"> {
  const finish = async (result: "applied" | "skipped", error: string | null) => {
    await db.$transaction([
      db.syncIn.update({ where: { id: row.id }, data: { appliedAt: new Date(), result, error, nextTryAt: null } }),
      db.syncInSeq.upsert({
        where: { shopId_sender_conversation: { shopId, sender: row.sender, conversation: row.conversation } },
        create: { shopId, sender: row.sender, conversation: row.conversation, nextSeq: row.seq + 1, gapped },
        update: { nextSeq: row.seq + 1, gapped },
      }),
    ]);
  };
  const handler = handlerFor(row.type, row.version);
  if (!handler) {
    // A type or version this program doesn't know: the hub shouldn't have sent it (it holds what a recipient didn't list), so say so and move on.
    await finish("skipped", `This program doesn't know ${row.type} version ${row.version}.`);
    return "skipped";
  }
  const parsed = parseBody(row.type, row.version, row.body, senderKind(row.sender));
  if (!parsed.ok) {
    await finish("skipped", `${parsed.code}: ${parsed.error}`.slice(0, 300));
    return "skipped";
  }
  try {
    const r = await handler({ shopId, messageId: row.messageId, sender: row.sender, conversation: row.conversation, seq: row.seq, sentAt: row.sentAt, body: parsed.body });
    if (r === "defer") {
      await db.syncIn.update({ where: { id: row.id }, data: { tries: { increment: 1 }, nextTryAt: backoff(row.tries + 1), error: "Waiting for something that hasn't arrived yet." } });
      return "defer";
    }
    await finish("applied", null);
    return "applied";
  } catch (e) {
    // A failure here is this program's (a database error, a file that couldn't be fetched): keep it, try again later, and keep the order.
    await db.syncIn.update({ where: { id: row.id }, data: { tries: { increment: 1 }, nextTryAt: backoff(row.tries + 1), error: plain(e) } });
    return "defer";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// send

/** Sends what is due, oldest first, one conversation's messages in seq order (a message the hub hasn't taken holds back the ones after it). */
export async function flushOutbox(shopId: string): Promise<{ sent: number; dead: number }> {
  const out = { sent: 0, dead: 0 };
  const now = new Date();
  const rows = await db.syncOut.findMany({ where: { shopId, sentAt: null, deadAt: null, expiredAt: null, expiresAt: { gt: now }, OR: [{ nextTryAt: null }, { nextTryAt: { lte: now } }] }, orderBy: [{ conversation: "asc" }, { seq: "asc" }], take: 200 });
  const stopped = new Set<string>();
  for (const r of rows) {
    if (stopped.has(r.conversation)) continue;
    const env = { id: r.id, type: r.type, version: r.version, conversation: r.conversation, seq: r.seq, to: SERVICE, created_at: new Date().toISOString(), expires_at: r.expiresAt.toISOString(), body: r.body };
    try {
      await v2(shopId, "/v2/messages", { method: "POST", json: env });
      await db.syncOut.update({ where: { id: r.id }, data: { sentAt: new Date(), error: null } });
      out.sent += 1;
    } catch (e) {
      const status = hubStatus(e);
      if (status === 426) {
        await db.shopOrdersSync.update({ where: { shopId }, data: { upgradeNeeded: plain(e) } });
        break;
      }
      if (status === 409 && /hello/i.test(plain(e))) {
        await db.shopOrdersSync.update({ where: { shopId }, data: { helloAt: null } });
        break;
      }
      // Refused for good (bad body, not opted in, a closed order): kept and shown, never retried. 429 and 5xx and no answer are retried.
      const forGood = status >= 400 && status < 500 && status !== 429 && status !== 408;
      await db.syncOut.update({ where: { id: r.id }, data: forGood ? { deadAt: new Date(), error: plain(e) } : { tries: { increment: 1 }, nextTryAt: backoff(r.tries + 1), error: plain(e) } });
      if (forGood) out.dead += 1;
      stopped.add(r.conversation); // keep the order: nothing after it goes first
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// one company, and every company

export type ShopRun = { polled: number; applied: number; sent: number; skipped?: string };

/** One round for one company: hello when due, poll, apply, send. One at a time per company, even with several server processes (a lease). */
export async function syncShop(shopId: string): Promise<ShopRun | { busy: true }> {
  const r = await withLease(`orders-sync:${shopId}`, 2 * 60_000, async () => {
    const row = await ordersSyncRow(shopId);
    if (row.upgradeNeeded && row.helloAt && Date.now() - row.helloAt.getTime() < HELLO_EVERY_MS) return { polled: 0, applied: 0, sent: 0, skipped: row.upgradeNeeded };
    try {
      if (!row.helloAt || Date.now() - row.helloAt.getTime() > HELLO_EVERY_MS) {
        const h = await sayHello(shopId);
        if (!h.ok) return { polled: 0, applied: 0, sent: 0, skipped: h.why };
      }
      const polled = await pollShop(shopId);
      await ackStored(shopId);
      const a = await applyWaiting(shopId);
      await retryPendingFiles(shopId);
      await clearShippedAddresses(shopId);
      const s = await flushOutbox(shopId);
      await db.shopOrdersSync.update({ where: { shopId }, data: { lastPollAt: new Date(), lastOkAt: new Date(), lastError: null } });
      return { polled, applied: a.applied, sent: s.sent };
    } catch (e) {
      // Out of reach (the internet is down) is normal for a shop on a PC: say so quietly, and keep what is stored.
      await db.shopOrdersSync.update({ where: { shopId }, data: { lastPollAt: new Date(), lastError: plain(e) } });
      // Still apply what is already stored: a message held for a gap may be due now, and nothing needs the hub for that.
      await applyWaiting(shopId).catch(() => {});
      throw e;
    }
  });
  return r ?? { busy: true };
}

const shared = globalThis as unknown as { __ordersSync?: Promise<void> | null };

/** A round for every company that takes MakerFoundry orders (or still has messages in flight). One run at a time in this process. */
export function syncOrders(): Promise<void> {
  shared.__ordersSync ??= inBackground(async () => {
    if (!(await hubJoined())) return;
    const ids = new Set<string>();
    // Every company that ever touched the feature: one that stopped taking new orders still hears about the orders it has open.
    for (const r of await db.shopOrdersSync.findMany({ where: { OR: [{ optedIn: true }, { catalogPublishedAt: { not: null } }] }, select: { shopId: true } })) ids.add(r.shopId);
    for (const r of await db.syncOut.findMany({ where: { sentAt: null, deadAt: null, expiredAt: null }, select: { shopId: true }, distinct: ["shopId"] })) ids.add(r.shopId);
    for (const r of await db.syncIn.findMany({ where: { appliedAt: null }, select: { shopId: true }, distinct: ["shopId"] })) ids.add(r.shopId);
    for (const shopId of ids) {
      try {
        await syncShop(shopId);
      } catch (e) {
        if (!(e instanceof HubError) && hubStatus(e) === 0) console.error("orders sync:", plain(e));
      }
    }
  }).finally(() => {
    shared.__ordersSync = null;
  });
  return shared.__ordersSync;
}
