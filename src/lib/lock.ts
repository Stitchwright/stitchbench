import "server-only";
// Transaction-scoped advisory locks for seat and capacity checks (scheduling-messaging-design.md section 12).
import type { Prisma } from "@/generated/prisma/client";

/** Locks every key for the rest of the transaction, in sorted order so two transactions never deadlock. */
export async function lockKeys(tx: Prisma.TransactionClient, keys: string[]): Promise<void> {
  for (const k of [...new Set(keys)].sort()) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${k}))::text`;
}
