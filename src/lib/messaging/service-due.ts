import "server-only";
// Which machines are due for a service reminder (scheduling-messaging-design.md section 4.1, service-due.ts): the
// latest record per machine across bench tickets and retail partner jobs; due when that record is a completed one and
// its completion plus `months` calendar months (shop time) has passed. A later record (the machine came back in) means
// not due. Raw SQL with parameters only; the instants compared come from the caller, never from now().
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { addMonths, wall, ymdOf, zonedTime } from "@/lib/zoned";

export type DueMachine = { machineId: string; customerId: string; brand: string; model: string; equipment: string; lastServiceAt: Date; dueAt: Date; noticedFor: Date | null };

type Row = { machineId: string; customerId: string; completedAt: Date; brand: string; model: string; equipment: string; serviceNoticeFor: Date | null };

const pad = (n: number) => String(n).padStart(2, "0");

/** completedAt + months in shop time; a day that doesn't exist (Nov 31) becomes the month's last day. */
function dueFrom(completedAt: Date, months: number, tz: string): Date {
  const w = wall(completedAt, tz);
  const ymd = ymdOf(completedAt, tz);
  let target = addMonths(ymd, months);
  if (!target) {
    const last = new Date(Date.UTC(w.year, w.month - 1 + months + 1, 0));
    target = `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`;
  }
  return zonedTime(target, w.hour * 60 + w.minute, tz);
}

/**
 * Machines whose latest record is completed and `months` calendar months old at `now` (and no older than `dueSince`
 * when given), with the customer of that record. `customerIds` narrows the result to those customers.
 */
export async function machinesDue(shopId: string, months: number, now: Date, o: { dueSince?: Date; customerIds?: string[] } = {}): Promise<DueMachine[]> {
  if (!Number.isInteger(months) || months < 1) return [];
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { timeZone: true } });
  if (!shop) return [];
  const tz = shop.timeZone;
  // A calendar month is at least 28 days: anything completed later than this can't be due yet.
  const latestPossible = new Date(now.getTime() - months * 28 * 86_400_000);
  const customers = o.customerIds?.length ? Prisma.sql`AND l."customerId" IN (${Prisma.join(o.customerIds)})` : Prisma.empty;
  const rows = await db.$queryRaw<Row[]>`
    WITH t AS (
      SELECT DISTINCT ON (t."machineId") t."machineId", t."customerId", t.status::text AS status, t."closedAt" AS "completedAt",
             t."intakeAt" AS at, t."viaAccountId" AS via, 'ticket'::text AS src
      FROM "Ticket" t
      WHERE t."shopId" = ${shopId} AND t."jobType" = 'BENCH'
      ORDER BY t."machineId", t."intakeAt" DESC
    ), j AS (
      SELECT DISTINCT ON (j."machineId") j."machineId", j."customerId", j.status, j."pickedUpAt" AS "completedAt",
             j."createdAt" AS at, NULL::text AS via, 'job'::text AS src
      FROM "RepairJob" j
      WHERE j."shopId" = ${shopId} AND j.side = 'retail' AND j."machineId" IS NOT NULL
      ORDER BY j."machineId", j."createdAt" DESC
    ), u AS (SELECT * FROM t UNION ALL SELECT * FROM j),
    l AS (SELECT DISTINCT ON ("machineId") * FROM u ORDER BY "machineId", at DESC)
    SELECT l."machineId", l."customerId", l."completedAt", m.brand, m.model, m.equipment, m."serviceNoticeFor"
    FROM l JOIN "Machine" m ON m.id = l."machineId" AND m."shopId" = ${shopId}
    WHERE l.status = 'COLLECTED' AND l."completedAt" IS NOT NULL AND l."customerId" IS NOT NULL
      AND (l.src = 'job' OR l.via IS NULL)
      AND l."completedAt" <= ${latestPossible}
      ${customers}
    ORDER BY l."completedAt" ASC`;
  const out: DueMachine[] = [];
  for (const r of rows) {
    const dueAt = dueFrom(r.completedAt, months, tz);
    if (dueAt.getTime() > now.getTime()) continue;
    if (o.dueSince && dueAt.getTime() < o.dueSince.getTime()) continue;
    out.push({ machineId: r.machineId, customerId: r.customerId, brand: r.brand, model: r.model, equipment: r.equipment, lastServiceAt: r.completedAt, dueAt, noticedFor: r.serviceNoticeFor });
  }
  return out;
}
