import "server-only";
// The audit log's writer and reader (later-round-1-design.md section 4.2). audit() is called inside the change's
// transaction wherever there is one (a void and its entry commit together or not at all), else straight after the write
// in the same request. shopId comes from the actor, never from input. Entries are never edited: the table has a trigger
// that refuses UPDATE and DELETE unless the transaction says it is pruning (withPrune, used only by pruneAudit and the
// removal of a whole company).
import { headers } from "next/headers";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { clientAddress } from "@/lib/client-ip";
import type { CurrentUser } from "@/lib/session";
import { AUDIT_ACTIONS, KEEP_SIGNIN_YEARS, KEEP_YEARS, type AuditAction } from "@/lib/audit-list";

type Db = Prisma.TransactionClient | typeof db;

export type Actor = { shopId: string; id?: string | null; name: string; role?: string | null; kind?: "user" | "platform-admin" | "customer" | "system" };

export const actorOf = (u: Pick<CurrentUser, "shopId" | "id" | "name" | "role">): Actor => ({ shopId: u.shopId, id: u.id, name: u.name, role: u.role, kind: "user" });
/** Work the program does by itself (a worker, a restore) rather than a person. */
export const systemActor = (shopId: string, name = "StitchBench"): Actor => ({ shopId, name, kind: "system" });

export type AuditInput = {
  action: AuditAction;
  subjectType: string;
  subjectId?: string | null;
  /** The subject as it was named then ("Sale #1042"): the record may be gone later. */
  subjectLabel?: string | null;
  changes?: Record<string, [unknown, unknown]> | null;
  amountCents?: number | null;
  reason?: string | null;
  /** Leave the sender's address out (a sign-in try that may have been meant for another company's login). */
  noIp?: boolean;
};

/** Which of `fields` differ: { field: [before, after] }, or null when nothing changed. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>, fields: (keyof T & string)[]): Record<string, [unknown, unknown]> | null {
  const out: Record<string, [unknown, unknown]> = {};
  for (const f of fields) {
    if (!(f in after)) continue;
    const b = before[f] ?? null;
    const a = after[f] ?? null;
    if (b !== a) out[f] = [b, a];
  }
  return Object.keys(out).length ? out : null;
}

async function requestAddress(): Promise<string | null> {
  try {
    return clientAddress(await headers());
  } catch {
    return null; // outside a request (a check script, a timer)
  }
}

/** Writes one entry. Throws for a name that isn't in the list: a typo must not silently log nothing. */
export async function audit(tx: Db, actor: Actor, e: AuditInput): Promise<void> {
  const meta = AUDIT_ACTIONS[e.action];
  if (!meta) throw new Error(`Unknown audit action: ${e.action}`);
  await tx.auditEntry.create({
    data: {
      shopId: actor.shopId,
      userId: actor.id ?? null,
      userName: actor.name.slice(0, 120),
      role: actor.role ?? null,
      actor: actor.kind ?? "user",
      category: meta.category,
      action: e.action,
      subjectType: e.subjectType,
      subjectId: e.subjectId ?? null,
      subjectLabel: e.subjectLabel?.slice(0, 200) ?? null,
      changes: (e.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      amountCents: e.amountCents ?? null,
      reason: e.reason?.slice(0, 500) ?? null,
      ip: e.noIp ? null : await requestAddress(),
    },
  });
}

/** Runs `fn` in a transaction the audit table's guard lets delete: pruning, and removing a whole company. Nothing else calls it. */
export async function withPrune<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('stitchbench.audit_prune', 'on', true)`;
    return fn(tx);
  });
}

/** The clean-up: entries past 7 years, sign-ins past 1. Returns how many went. */
export async function pruneAudit(now = new Date()): Promise<number> {
  const ago = (years: number) => new Date(now.getFullYear() - years, now.getMonth(), now.getDate());
  return withPrune(async (tx) => {
    const a = await tx.auditEntry.deleteMany({ where: { action: { in: ["signin.ok", "signin.fail"] }, at: { lt: ago(KEEP_SIGNIN_YEARS) } } });
    const b = await tx.auditEntry.deleteMany({ where: { at: { lt: ago(KEEP_YEARS) } } });
    return a.count + b.count;
  });
}

/** Every entry of one company goes with it (the table has no foreign key to cascade). */
export async function removeAuditOf(shopId: string): Promise<void> {
  await withPrune((tx) => tx.auditEntry.deleteMany({ where: { shopId } }));
}

export type AuditFilter = { userId?: string; category?: string; action?: string; from?: Date; to?: Date; subjectType?: string; subjectId?: string };

/** The company's entries, newest first, by the filter. shopId is the signed-in admin's. */
export async function auditEntries(shopId: string, f: AuditFilter, o: { take: number; skip?: number }) {
  const where: Prisma.AuditEntryWhereInput = {
    shopId,
    ...(f.userId ? { userId: f.userId } : {}),
    ...(f.category ? { category: f.category } : {}),
    ...(f.action ? { action: f.action } : {}),
    ...(f.subjectType ? { subjectType: f.subjectType } : {}),
    ...(f.subjectId ? { subjectId: f.subjectId } : {}),
    ...(f.from || f.to ? { at: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([db.auditEntry.findMany({ where, orderBy: [{ at: "desc" }, { id: "desc" }], take: o.take, skip: o.skip ?? 0 }), db.auditEntry.count({ where })]);
  return { rows, total };
}
