// Opt-outs and consent survive a restore of the Windows program's backups (desktop/backup.mjs, scheduling-messaging-
// design.md 2.3; foundation acceptance item 6). NEVER against the working database: it creates a database of its own,
// stitchbench_restorecheck_<run>, next to the one in .env, runs `prisma migrate deploy` there, and drops it (and its
// scratch backup folder) at the end, whatever happened.
//   npm run check scripts/checks/restore-optouts.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { backup, restore } from "../../desktop/backup.mjs";

const RUN = crypto.randomBytes(4).toString("hex");
const DB = `stitchbench_restorecheck_${RUN}`;
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PHONE = "+15551230001";
/** A JS time as the UTC wall clock Prisma writes into TIMESTAMP(3) columns. */
const ts = (d: Date) => d.toISOString();
const AT = "::timestamptz AT TIME ZONE 'UTC'";

function urlFor(database: string): string {
  const base = process.env.DATABASE_URL;
  assert.ok(base, "DATABASE_URL is set (.env)");
  const u = new URL(base);
  assert.notEqual(u.pathname, `/${database}`);
  u.pathname = `/${database}`;
  return u.toString();
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor("postgres") });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function migrateDeploy(url: string) {
  // The CLI directly (no npx: it would look for a shell on Windows). prisma.config.ts loads .env with dotenv, which
  // never overrides a variable already set, so the scratch database wins.
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`prisma migrate deploy failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
}

async function main() {
  const url = urlFor(DB);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sb-restorecheck-"));
  await admin((c) => c.query(`CREATE DATABASE "${DB}"`));
  let pool: pg.Pool | null = null;
  let passed = 0;
  const ok = (name: string, cond: unknown) => {
    assert.ok(cond, name);
    passed++;
  };
  try {
    migrateDeploy(url);
    pool = new pg.Pool({ connectionString: url, max: 3 });
    const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool!.query<R>(sql, params);

    // A company with a customer who agreed to marketing texts and wants texts, its messaging settings, and an older
    // email opt-out (marketing only) that the backup will hold.
    const consentAt = new Date(Date.now() - 86_400_000);
    await q(`INSERT INTO "Shop" (id, name) VALUES ('shop1', 'Restore check')`);
    await q(
      `INSERT INTO "Customer" (id, "shopId", name, phone, email, "notifyBy", "smsConsentAt", "smsConsentPhone", "smsConsentSource", "smsConsentText")
         VALUES ('c1', 'shop1', 'Ann Example', $1, 'ann@example.com', 'sms', $2${AT}, $1, 'form', 'Yes, text me offers')`,
      [PHONE, ts(consentAt)],
    );
    await q(`INSERT INTO "Customer" (id, "shopId", name, "notifyBy") VALUES ('c2', 'shop1', 'Bob Example', 'email')`);
    await q(`INSERT INTO "MessagingSettings" ("shopId", "inboundAt", "inboundIncomplete", "updatedAt") VALUES ('shop1', $1${AT}, 2, now())`, [ts(consentAt)]);
    await q(`INSERT INTO "Suppression" ("shopId", channel, address, scope, source) VALUES ('shop1', 'email', 'bob@example.com', 'marketing', 'link')`);
    await q(
      `INSERT INTO "ConsentEvent" (id, "shopId", "customerId", channel, event, address, source, detail, "at") VALUES ('ev0', 'shop1', 'c1', 'sms', 'marketing_yes', $1, 'form', 'Yes, text me offers', $2${AT})`,
      [PHONE, ts(consentAt)],
    );
    // In the backup too: a campaign mid-send with a queued marketing text, a queued notice and a notice in flight.
    await q(
      `INSERT INTO "Campaign" (id, "shopId", name, channel, body, audience, status, "updatedAt") VALUES ('camp1', 'shop1', 'Fall sale', 'sms', 'Sale!', '{}', 'SENDING', now())`,
    );
    await q(
      `INSERT INTO "OutMessage" (id, "shopId", channel, purpose, kind, "customerId", address, body, status, "campaignId", "claimedAt", "nextTryAt") VALUES
         ('m1', 'shop1', 'sms', 'marketing', 'campaign', 'c1', $1, 'Sale!', 'QUEUED', 'camp1', NULL, NULL),
         ('m2', 'shop1', 'email', 'notice', 'ready', 'c2', 'bob@example.com', 'Your machine is ready', 'QUEUED', NULL, NULL, NULL),
         ('m3', 'shop1', 'email', 'notice', 'ready', 'c2', 'bob@example.com', 'Your machine is ready (2)', 'SENDING', NULL, now(), now())`,
      [PHONE],
    );
    const dir = await backup(pool, scratch, { keep: 0, prune: false });
    ok("backup() made a folder", fs.existsSync(path.join(dir, "manifest.json")));

    // After the backup: Ann texts STOP and says "no messages"; Bob's email opt-out widens to everything; a customer
    // made later records a preference too; messages are queued and in flight; a campaign is sending.
    const later = new Date();
    await q(`INSERT INTO "Suppression" ("shopId", channel, address, scope, source) VALUES ('shop1', 'sms', $1, 'all', 'reply')`, [PHONE]);
    await q(`UPDATE "Suppression" SET scope = 'all' WHERE address = 'bob@example.com'`);
    await q(
      `INSERT INTO "ConsentEvent" (id, "shopId", "customerId", channel, event, address, source, detail, "at") VALUES
         ('ev1', 'shop1', 'c1', 'sms', 'marketing_no', $1, 'reply', 'STOP', $2${AT}),
         ('ev2', 'shop1', 'c1', 'any', 'notify_pref', NULL, 'counter', 'none', $3${AT})`,
      [PHONE, ts(new Date(later.getTime() + 1000)), ts(new Date(later.getTime() + 2000))],
    );
    await q(`UPDATE "Customer" SET "notifyBy" = 'none' WHERE id = 'c1'`);
    await q(`INSERT INTO "Customer" (id, "shopId", name, "notifyBy") VALUES ('c3', 'shop1', 'Cat Later', 'both')`);
    await q(
      `INSERT INTO "ConsentEvent" (id, "shopId", "customerId", channel, event, address, source, detail, "at") VALUES
         ('ev3', 'shop1', 'c3', 'any', 'notify_pref', NULL, 'counter', 'both', $1${AT}),
         ('ev4', 'shop1', 'c2', 'any', 'notify_pref', NULL, 'counter', 'bogus', $1${AT})`,
      [ts(new Date(later.getTime() + 3000))],
    );
    // The campaign went on after the backup: its restored copy must not send again.
    await q(`UPDATE "OutMessage" SET status = 'SENT', "sentAt" = now() WHERE id = 'm1'`);
    await q(`UPDATE "Campaign" SET status = 'SENT', "finishedAt" = now() WHERE id = 'camp1'`);
    const inboundBefore = (await q<{ a: Date | null }>(`SELECT "inboundAt" AS a FROM "MessagingSettings"`)).rows[0].a;
    ok("inboundAt set before the restore", inboundBefore !== null);

    await restore(pool, dir);

    const sup = (await q<{ channel: string; address: string; scope: string }>(`SELECT channel, address, scope FROM "Suppression" ORDER BY channel, address`)).rows;
    assert.deepEqual(
      sup,
      [
        { channel: "email", address: "bob@example.com", scope: "all" },
        { channel: "sms", address: PHONE, scope: "all" },
      ],
      "the STOP survives, and Bob's opt-out keeps its wider scope",
    );
    passed++;
    const events = (await q<{ id: string; customerId: string | null }>(`SELECT id, "customerId" FROM "ConsentEvent" ORDER BY id`)).rows;
    assert.deepEqual(
      events,
      [
        { id: "ev0", customerId: "c1" },
        { id: "ev1", customerId: "c1" },
        { id: "ev2", customerId: "c1" },
        { id: "ev3", customerId: null },
        { id: "ev4", customerId: "c2" },
      ],
      "every event is there; the later customer's event names no customer",
    );
    passed++;
    const ann = (await q(`SELECT "notifyBy", "smsConsentAt", "smsConsentPhone", "smsConsentSource", "smsConsentText" FROM "Customer" WHERE id = 'c1'`)).rows[0];
    ok("Ann's smsConsentAt is cleared", ann.smsConsentAt === null);
    ok("Ann's smsConsentPhone is cleared", ann.smsConsentPhone === null);
    ok("Ann's smsConsentSource is cleared", ann.smsConsentSource === null);
    ok("Ann's smsConsentText is cleared", ann.smsConsentText === null);
    assert.equal(ann.notifyBy, "none", "Ann's notifyBy is 'none' again (the newest notify_pref)");
    passed++;
    const bob = (await q(`SELECT "notifyBy" FROM "Customer" WHERE id = 'c2'`)).rows[0];
    assert.equal(bob.notifyBy, "email", "a notify_pref with a detail that isn't one of the five values changes nothing");
    passed++;
    assert.equal((await q(`SELECT count(*)::int AS n FROM "Customer"`)).rows[0].n, 2, "the customer made after the backup is gone");
    passed++;

    const msgs = (await q<{ id: string; status: string; error: string | null; claimedAt: Date | null; nextTryAt: Date | null }>(`SELECT id, status, error, "claimedAt", "nextTryAt" FROM "OutMessage" ORDER BY id`)).rows;
    assert.equal(msgs[0].status, "CANCELLED", "the queued marketing row is CANCELLED");
    assert.match(msgs[0].error ?? "", /restored from a backup/, "and says why");
    assert.equal(msgs[1].status, "QUEUED", "the queued notice stays QUEUED");
    assert.equal(msgs[2].status, "QUEUED", "the notice in flight is back in the queue");
    ok("with its claim cleared", msgs[2].claimedAt === null && msgs[2].nextTryAt === null);
    passed += 4;
    const camp = (await q<{ status: string; finishedAt: Date | null }>(`SELECT status, "finishedAt" FROM "Campaign"`)).rows[0];
    assert.equal(camp.status, "CANCELLED", "the sending campaign is CANCELLED");
    ok("with finishedAt set", camp.finishedAt !== null);
    passed++;
    const ms = (await q<{ marketingHoldAt: Date | null; inboundAt: Date | null; inboundIncomplete: number }>(`SELECT "marketingHoldAt", "inboundAt", "inboundIncomplete" FROM "MessagingSettings"`)).rows[0];
    ok("marketingHoldAt is set", ms.marketingHoldAt !== null);
    ok("inboundAt is null (replies are read again from the start)", ms.inboundAt === null);
    ok("inboundIncomplete is 0", ms.inboundIncomplete === 0);

    // The same restore again (the fix-ups are safe to repeat): nothing changes.
    await restore(pool, dir);
    assert.deepEqual((await q(`SELECT channel, address, scope FROM "Suppression" ORDER BY channel, address`)).rows, sup);
    assert.equal((await q(`SELECT count(*)::int AS n FROM "ConsentEvent"`)).rows[0].n, 5);
    assert.equal((await q(`SELECT "notifyBy" FROM "Customer" WHERE id = 'c1'`)).rows[0].notifyBy, "none");
    passed++;
  } finally {
    await pool?.end().catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`)).catch((e) => console.error(`could not drop ${DB}:`, e));
  }
  console.log(`restore-optouts.check: ${passed} checks passed (database ${DB} dropped)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
