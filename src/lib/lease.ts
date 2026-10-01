import "server-only";
// One background job at a time per install (JobLease), for an app that may run as several server copies
// (scheduling-messaging-design.md section 4.1). All times are passed as JS Dates, never compared with now().
import os from "node:os";
import { db } from "@/lib/db";

export const LEASE_HOLDER: string = `${os.hostname()}:${process.pid}`;

/** Runs `run` while holding the lease, renewing it on request; null when someone else holds it. */
export async function withLease<T>(name: string, ttlMs: number, run: (renew: () => Promise<boolean>) => Promise<T>): Promise<T | null> {
  const me = LEASE_HOLDER;
  const take = async () => {
    const now = new Date();
    const until = new Date(now.getTime() + ttlMs);
    const rows = await db.$queryRaw<{ holder: string }[]>`
      INSERT INTO "JobLease" (name, holder, until) VALUES (${name}, ${me}, ${until})
      ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until
      WHERE "JobLease".until < ${now} OR "JobLease".holder = EXCLUDED.holder
      RETURNING holder`;
    return rows.length > 0 && rows[0].holder === me;
  };
  if (!(await take())) return null;
  try {
    return await run(take);
  } finally {
    await db.$executeRaw`DELETE FROM "JobLease" WHERE name = ${name} AND holder = ${me}`.catch(() => {});
  }
}

/** A restarted program's old process left its lease behind: remove any lease held by another pid on this host. */
export async function clearStaleOwnLeases(): Promise<void> {
  const prefix = `${os.hostname()}:%`;
  await db.$executeRaw`DELETE FROM "JobLease" WHERE holder LIKE ${prefix} AND holder <> ${LEASE_HOLDER}`;
}
