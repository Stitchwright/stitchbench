import "server-only";
// The company's outbox for MakerFoundry (see sync.ts): a message is made once, with its id and its seq in its conversation, in the same
// transaction as the change it reports.
import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { isDemo } from "@/lib/demo-mode";
import { parseBody, type SENDS } from "@/lib/shop-orders/contract";

/** The hub address of a service (the name a shop opted in to). */
export const serviceAddress = (service: string) => `service:${service}`;
/** The default service: production MakerFoundry. */
export const DEFAULT_SERVICE = "makerfoundry";
/** How long the hub is asked to keep an undelivered message of each kind of ours (it clamps to its own longest). */
const TTL_DAYS: Record<string, number> = { catalog: 14, "order.status": 14, "proof.sent": 14, "order.cancel": 14 };

export type OutMessage = { conversation: string; type: (typeof SENDS)[number]; body: unknown };

/**
 * Puts a message in the company's outbox with the next seq of its conversation (the same transaction as the change it reports, so a
 * status is never sent for something that didn't happen, nor lost for something that did). The body is checked first.
 */
export async function enqueue(tx: Prisma.TransactionClient, shopId: string, m: OutMessage): Promise<{ id: string; seq: number }> {
  const parsed = parseBody(m.type, 1, m.body, "shop");
  if (!parsed.ok) throw new Error(`Not queued: ${parsed.error}`);
  const seq = await tx.$queryRaw<{ nextSeq: number }[]>`
    INSERT INTO "SyncOutSeq" ("shopId", "conversation", "nextSeq") VALUES (${shopId}, ${m.conversation}, 2)
    ON CONFLICT ("shopId", "conversation") DO UPDATE SET "nextSeq" = "SyncOutSeq"."nextSeq" + 1
    RETURNING "nextSeq" - 1 AS "nextSeq"`;
  const n = seq[0]?.nextSeq;
  if (typeof n !== "number") throw new Error("Not queued: no sequence number.");
  const id = crypto.randomUUID();
  await tx.syncOut.create({ data: { id, shopId, conversation: m.conversation, seq: n, type: m.type, version: 1, body: parsed.body as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + (TTL_DAYS[m.type] ?? 7) * 86_400_000), ...(isDemo() ? { sentAt: new Date() } : {}) } });
  return { id, seq: n };
}

