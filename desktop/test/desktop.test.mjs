// The Windows program's database code (migrate.mjs, reference.mjs, backup.mjs) against a scratch Postgres, without
// Electron. Run from desktop/ (after `npm ci --ignore-scripts` there):
//   TEST_DATABASE_URL=postgresql://user:password@localhost:5433/postgres npm test
// The user has to be a superuser, as the program's own is: restore switches foreign-key checks off. Every test works in a
// database of its own and drops it afterwards. Without TEST_DATABASE_URL the tests are skipped.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { migrate } from "../migrate.mjs";
import { loadReference } from "../reference.mjs";
import { backup, restore, listBackups, readManifest } from "../backup.mjs";

const base = process.env.TEST_DATABASE_URL;
const skip = base ? false : "set TEST_DATABASE_URL (a scratch Postgres, superuser) to run these";
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "prisma", "migrations");
const quiet = () => {};

/** A new empty database and a folder for backups; done() removes both. */
async function scratch() {
  const name = `sbtest_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-test-"));
  return {
    pool,
    dir,
    backups: path.join(dir, "backups"),
    async done() {
      await pool.end();
      fs.rmSync(dir, { recursive: true, force: true });
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await a.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** A scratch database with every migration applied and one company with one customer. */
async function shop() {
  const t = await scratch();
  try {
    await migrate(t.pool, MIGRATIONS, quiet);
    await t.pool.query(`INSERT INTO "Shop" (id, name) VALUES ('shop1', 'Before')`);
    await t.pool.query(`INSERT INTO "Customer" (id, "shopId", name) VALUES ('c1', 'shop1', 'Ann')`);
  } catch (e) {
    await t.done();
    throw e;
  }
  return t;
}

const names = (pool, table) => pool.query(`SELECT name FROM "${table}" ORDER BY id`).then((r) => r.rows.map((x) => x.name));

test("migrate: a new database gets every migration once, and running it again adds none", { skip }, async () => {
  const t = await scratch();
  try {
    const all = fs.readdirSync(MIGRATIONS).filter((n) => fs.existsSync(path.join(MIGRATIONS, n, "migration.sql")));
    assert.equal(await migrate(t.pool, MIGRATIONS, quiet), all.length);
    assert.equal(await migrate(t.pool, MIGRATIONS, quiet), 0);
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`);
    assert.equal(rows[0].n, all.length);
  } finally {
    await t.done();
  }
});

test("backup and restore: the data comes back as it was, and what came after is gone", { skip }, async () => {
  const t = await shop();
  try {
    const dir = await backup(t.pool, t.backups, { version: "1.0.0" });
    const { manifest } = readManifest(dir);
    assert.ok(manifest.lastMigration, "the manifest records the last migration");
    const saved = manifest.tables.map((x) => x.name);
    assert.ok(saved.includes("Shop") && saved.includes("Customer"));
    for (const skipped of ["_prisma_migrations", "TensionSpec", "FactorySetting", "LibraryDoc", "HubPost"]) assert.ok(!saved.includes(skipped), `${skipped} is not backed up`);

    await t.pool.query(`UPDATE "Shop" SET name = 'After' WHERE id = 'shop1'`);
    await t.pool.query(`DELETE FROM "Customer"`);
    await t.pool.query(`INSERT INTO "Shop" (id, name) VALUES ('shop2', 'Later')`);
    await restore(t.pool, dir);

    assert.deepEqual(await names(t.pool, "Shop"), ["Before"]);
    assert.deepEqual(await names(t.pool, "Customer"), ["Ann"]);
  } finally {
    await t.done();
  }
});

test("restore: license keys pasted after the backup come back, and the equipmentKind fix-up runs only for backups from before paid_modules", { skip }, async () => {
  const t = await shop();
  try {
    // A menu the shop set to "every kind" (all null): a backup made after paid_modules must come back exactly like that.
    await t.pool.query(`INSERT INTO "ServiceItem" (id, "shopId", name, "priceCents") VALUES ('s1', 'shop1', 'Hook timing only', 5500), ('s2', 'shop1', 'Storage fee (after 60 days)', 4500)`);
    await t.pool.query(`INSERT INTO "License" (id, "shopId", "keyId", key) VALUES ('l0', 'shop1', 'KEY0', 'SB1.in-the-backup.sig')`);
    const dir = await backup(t.pool, t.backups);
    const kinds = async () => (await t.pool.query(`SELECT name, "equipmentKind" AS k FROM "ServiceItem" ORDER BY id`)).rows.map((r) => [r.name, r.k]);
    const keys = async () => (await t.pool.query(`SELECT id, "shopId" FROM "License" ORDER BY id`)).rows.map((r) => `${r.shopId}:${r.id}`);

    // After the backup: a key pasted for shop1, a second company with its own key, and shop1's key text changed in place.
    await t.pool.query(`INSERT INTO "License" (id, "shopId", "keyId", key) VALUES ('l1', 'shop1', 'KEY1', 'SB1.pasted-later.sig')`);
    await t.pool.query(`INSERT INTO "Shop" (id, name) VALUES ('shop2', 'Later')`);
    await t.pool.query(`INSERT INTO "License" (id, "shopId", "keyId", key) VALUES ('l2', 'shop2', 'KEY2', 'SB1.other-company.sig')`);
    await t.pool.query(`UPDATE "License" SET key = 'changed' WHERE id = 'l0'`);
    await restore(t.pool, dir);
    assert.deepEqual(await keys(), ["shop1:l0", "shop1:l1"], "the pasted key comes back; the later company's key goes with its company");
    assert.equal((await t.pool.query(`SELECT key FROM "License" WHERE id = 'l0'`)).rows[0].key, "SB1.in-the-backup.sig", "a key the backup has is the backup's");
    assert.deepEqual(await kinds(), [["Hook timing only", null], ["Storage fee (after 60 days)", null]], "a backup from after paid_modules is left as saved");

    // The same backup presented as one from before paid_modules (no License table, an older last migration).
    const file = path.join(dir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(manifest.lastMigration >= "20261001120000_paid_modules");
    fs.writeFileSync(file, JSON.stringify({ ...manifest, lastMigration: "20260930220000_round3_tail2_part_number_ci", tables: manifest.tables.filter((x) => x.name !== "License") }));
    await restore(t.pool, dir);
    assert.deepEqual(await kinds(), [["Hook timing only", "sewing"], ["Storage fee (after 60 days)", null]], "an older backup gets the migration's backfill");
    assert.deepEqual(await keys(), ["shop1:l0", "shop1:l1"], "an older backup keeps the keys the PC has");

    // And one with no last migration recorded at all (before 1.4) gets the fix-up too.
    await t.pool.query(`UPDATE "ServiceItem" SET "equipmentKind" = NULL`);
    fs.writeFileSync(file, JSON.stringify({ ...manifest, lastMigration: null, tables: manifest.tables.filter((x) => x.name !== "License") }));
    await restore(t.pool, dir);
    assert.deepEqual(await kinds(), [["Hook timing only", "sewing"], ["Storage fee (after 60 days)", null]]);
  } finally {
    await t.done();
  }
});

test("restore: a backup's Features come back as saved; one from before Settings → Features has its keys decide them again", { skip }, async () => {
  const t = await shop();
  try {
    const shopRow = async () => (await t.pool.query(`SELECT "featuresSetUpAt" FROM "Shop" WHERE id = 'shop1'`)).rows[0];
    const features = async () => (await t.pool.query(`SELECT module, enabled FROM "ShopFeature" WHERE "shopId" = 'shop1' ORDER BY module`)).rows.map((r) => `${r.module}:${r.enabled}`);
    assert.ok((await shopRow()).featuresSetUpAt, "a company made on this version is set up when it is made");
    await t.pool.query(`INSERT INTO "ShopFeature" ("shopId", module, enabled, "byName") VALUES ('shop1', 'vac', true, 'Ann'), ('shop1', 'marketing', false, 'Ann')`);
    const dir = await backup(t.pool, t.backups);

    // After the backup: Scheduling switched on, Vac Shop off. The restore puts the backup's choices back.
    await t.pool.query(`INSERT INTO "ShopFeature" ("shopId", module, enabled) VALUES ('shop1', 'scheduling', true)`);
    await t.pool.query(`UPDATE "ShopFeature" SET enabled = false WHERE module = 'vac'`);
    await restore(t.pool, dir);
    assert.deepEqual(await features(), ["marketing:false", "vac:true"]);
    assert.ok((await shopRow()).featuresSetUpAt, "still set up: nothing to work out again");

    // The same backup presented as one from before shop_features (no ShopFeature table, an older last migration): its
    // companies' Features are worked out again from their keys at the first load (featuresSetUpAt null), never all off.
    const file = path.join(dir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(manifest.lastMigration >= "20261030000000_shop_features");
    fs.writeFileSync(file, JSON.stringify({ ...manifest, lastMigration: "20261029000000_text_size", tables: manifest.tables.filter((x) => x.name !== "ShopFeature") }));
    await restore(t.pool, dir);
    assert.deepEqual(await features(), [], "an older backup has no features");
    assert.equal((await shopRow()).featuresSetUpAt, null, "so its keys decide them at the first load, as at the update to 1.8");
  } finally {
    await t.done();
  }
});

test("restore: opt-outs and consent recorded after the backup stay, restored marketing is cancelled, notices requeued, marketing on hold", { skip }, async () => {
  const t = await shop();
  // Times as the UTC wall clock Prisma writes into TIMESTAMP(3) columns (backup.mjs compares the backup's time the same way).
  const at = (d) => d.toISOString();
  const AT = "::timestamptz AT TIME ZONE 'UTC'";
  try {
    const earlier = new Date(Date.now() - 86_400_000);
    await t.pool.query(
      `UPDATE "Customer" SET phone = '+15551230001', "notifyBy" = 'sms', "smsConsentAt" = $1${AT}, "smsConsentPhone" = '+15551230001', "smsConsentSource" = 'form', "smsConsentText" = 'Yes, text me offers' WHERE id = 'c1'`,
      [at(earlier)],
    );
    await t.pool.query(`INSERT INTO "Customer" (id, "shopId", name, "notifyBy") VALUES ('c2', 'shop1', 'Bob', 'email')`);
    await t.pool.query(`INSERT INTO "MessagingSettings" ("shopId", "inboundAt", "inboundIncomplete", "updatedAt") VALUES ('shop1', $1${AT}, 2, now())`, [at(earlier)]);
    await t.pool.query(`INSERT INTO "Suppression" ("shopId", channel, address, scope, source) VALUES ('shop1', 'email', 'bob@example.com', 'marketing', 'link')`);
    await t.pool.query(`INSERT INTO "Campaign" (id, "shopId", name, channel, body, audience, status, "updatedAt") VALUES ('camp1', 'shop1', 'Sale', 'sms', 'Sale!', '{}', 'SENDING', now())`);
    await t.pool.query(
      `INSERT INTO "OutMessage" (id, "shopId", channel, purpose, kind, "customerId", address, body, status, "campaignId", "claimedAt", "nextTryAt") VALUES
         ('m1', 'shop1', 'sms', 'marketing', 'campaign', 'c1', '+15551230001', 'Sale!', 'QUEUED', 'camp1', NULL, NULL),
         ('m2', 'shop1', 'email', 'notice', 'ready', 'c2', 'bob@example.com', 'Ready', 'QUEUED', NULL, NULL, NULL),
         ('m3', 'shop1', 'email', 'notice', 'ready', 'c2', 'bob@example.com', 'Ready (2)', 'SENDING', NULL, now(), now())`,
    );
    const dir = await backup(t.pool, t.backups);

    // After the backup: Ann texts STOP and asks for no messages, Bob's opt-out widens, a later customer sets a preference,
    // and the campaign finishes sending.
    const later = Date.now();
    await t.pool.query(`INSERT INTO "Suppression" ("shopId", channel, address, scope, source) VALUES ('shop1', 'sms', '+15551230001', 'all', 'reply')`);
    await t.pool.query(`UPDATE "Suppression" SET scope = 'all' WHERE address = 'bob@example.com'`);
    await t.pool.query(`INSERT INTO "Customer" (id, "shopId", name, "notifyBy") VALUES ('c3', 'shop1', 'Cat', 'both')`);
    await t.pool.query(
      `INSERT INTO "ConsentEvent" (id, "shopId", "customerId", channel, event, address, source, detail, "at") VALUES
         ('ev1', 'shop1', 'c1', 'sms', 'marketing_no', '+15551230001', 'reply', 'STOP', $1${AT}),
         ('ev2', 'shop1', 'c1', 'any', 'notify_pref', NULL, 'counter', 'none', $2${AT}),
         ('ev3', 'shop1', 'c3', 'any', 'notify_pref', NULL, 'counter', 'both', $3${AT}),
         ('ev4', 'shop1', 'c2', 'any', 'notify_pref', NULL, 'counter', 'bogus', $3${AT})`,
      [at(new Date(later + 1000)), at(new Date(later + 2000)), at(new Date(later + 3000))],
    );
    await t.pool.query(`UPDATE "Customer" SET "notifyBy" = 'none' WHERE id = 'c1'`);
    await t.pool.query(`UPDATE "OutMessage" SET status = 'SENT' WHERE id = 'm1'`);
    await restore(t.pool, dir);

    const rows = async (sql) => (await t.pool.query(sql)).rows;
    assert.deepEqual(await rows(`SELECT channel, address, scope FROM "Suppression" ORDER BY channel`), [
      { channel: "email", address: "bob@example.com", scope: "all" },
      { channel: "sms", address: "+15551230001", scope: "all" },
    ], "the STOP survives and an opt-out never narrows");
    assert.deepEqual(await rows(`SELECT id, "customerId" FROM "ConsentEvent" ORDER BY id`), [
      { id: "ev1", customerId: "c1" },
      { id: "ev2", customerId: "c1" },
      { id: "ev3", customerId: null },
      { id: "ev4", customerId: "c2" },
    ], "every event stays; one about a customer the backup lacks names no customer");
    const [ann] = await rows(`SELECT "notifyBy", "smsConsentAt", "smsConsentPhone", "smsConsentSource", "smsConsentText" FROM "Customer" WHERE id = 'c1'`);
    assert.deepEqual(ann, { notifyBy: "none", smsConsentAt: null, smsConsentPhone: null, smsConsentSource: null, smsConsentText: null }, "consent cleared, 'no messages' kept");
    assert.equal((await rows(`SELECT "notifyBy" FROM "Customer" WHERE id = 'c2'`))[0].notifyBy, "email", "a preference that isn't one of the five values is ignored");
    assert.deepEqual(await rows(`SELECT id, status FROM "OutMessage" ORDER BY id`), [
      { id: "m1", status: "CANCELLED" },
      { id: "m2", status: "QUEUED" },
      { id: "m3", status: "QUEUED" },
    ], "restored marketing never goes out again; notices go back to the queue");
    assert.equal((await rows(`SELECT "claimedAt" FROM "OutMessage" WHERE id = 'm3'`))[0].claimedAt, null);
    assert.equal((await rows(`SELECT status FROM "Campaign"`))[0].status, "CANCELLED");
    const [ms] = await rows(`SELECT "marketingHoldAt", "inboundAt", "inboundIncomplete" FROM "MessagingSettings"`);
    assert.ok(ms.marketingHoldAt, "marketing is on hold until an admin checks the opt-outs");
    assert.equal(ms.inboundAt, null, "replies are read again from the start");
    assert.equal(ms.inboundIncomplete, 0);
  } finally {
    await t.done();
  }
});

test("restore: a backup from a newer version, a missing file or a damaged file is refused and changes nothing", { skip }, async () => {
  const t = await shop();
  try {
    const dir = await backup(t.pool, t.backups);
    const file = path.join(dir, "manifest.json");
    const good = fs.readFileSync(file, "utf8");
    await t.pool.query(`UPDATE "Shop" SET name = 'Changed' WHERE id = 'shop1'`);

    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(good), lastMigration: "99990101000000_from_the_future" }));
    await assert.rejects(restore(t.pool, dir), /newer version/);
    fs.writeFileSync(file, good);

    const copy = path.join(dir, "Customer.copy.gz");
    const original = fs.readFileSync(copy);
    fs.writeFileSync(copy, "this is not gzip");
    await assert.rejects(restore(t.pool, dir));
    assert.deepEqual(await names(t.pool, "Shop"), ["Changed"], "a damaged file rolls the whole restore back");
    assert.deepEqual(await names(t.pool, "Customer"), ["Ann"]);

    fs.rmSync(copy);
    await assert.rejects(restore(t.pool, dir), /missing/);
    fs.writeFileSync(copy, original);
    await restore(t.pool, dir); // and the untouched backup still restores
    assert.deepEqual(await names(t.pool, "Shop"), ["Before"]);
  } finally {
    await t.done();
  }
});

test("backups are pruned to the newest few; keep 0, blank or a word never removes them all", { skip }, async () => {
  const t = await shop();
  try {
    const count = () => listBackups(t.backups).length;
    for (let i = 0; i < 3; i++) await backup(t.pool, t.backups, { keep: 30 });
    assert.equal(count(), 3);
    await backup(t.pool, t.backups, { keep: 0 }); // 0 keeps them all
    assert.equal(count(), 4);
    for (const odd of [null, undefined, "", "many", -1]) await backup(t.pool, t.backups, { keep: odd }); // the usual 30
    assert.equal(count(), 9);
    await backup(t.pool, t.backups, { keep: 1, prune: false }); // the safety copy before a restore removes nothing
    assert.equal(count(), 10);
    const newest = await backup(t.pool, t.backups, { keep: 2 });
    assert.equal(count(), 2);
    assert.equal(listBackups(t.backups)[0], newest, "the backup just made is the one kept first");
  } finally {
    await t.done();
  }
});

test("backups: StitchBench and StitchShop keep theirs apart, and each refuses the other's on restore", { skip }, async () => {
  const t = await shop();
  try {
    const mine = await backup(t.pool, t.backups, { flavor: "stitchbench" });
    const other = await backup(t.pool, t.backups, { flavor: "stitchshop", keep: 1 });
    assert.deepEqual(listBackups(t.backups, "stitchbench"), [mine]);
    assert.deepEqual(listBackups(t.backups, "stitchshop"), [other]);
    assert.match(readManifest(other, "stitchbench").error, /StitchShop backup/);
    assert.ok(readManifest(mine, "stitchbench").manifest);
    assert.ok(readManifest(t.dir, "stitchbench").error, "a folder that isn't a backup is refused");
  } finally {
    await t.done();
  }
});

// The tension specs are among the manufacturers' reference data, which isn't in the public code (INSTALL.md): a checkout
// without them skips this test rather than failing.
const SPECS = path.join(ROOT, "prisma", "seed-data", "tension_specs.json");
const noSpecs = fs.existsSync(SPECS) ? false : "prisma/seed-data/tension_specs.json isn't here (the manufacturers' reference data, kept out of the public code)";

test("reference data: loaded once, reloaded when the shipped file changes, and a restore leaves it alone", { skip: skip || noSpecs }, async () => {
  const t = await shop();
  try {
    const shipped = path.join(t.dir, "seed-data");
    fs.mkdirSync(shipped);
    const specs = JSON.parse(fs.readFileSync(SPECS, "utf8"));
    const write = (rows) => fs.writeFileSync(path.join(shipped, "tension_specs.json"), JSON.stringify(rows));
    const loaded = [];
    const log = (m) => loaded.push(m);
    const rows = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM "TensionSpec"`)).rows[0].n;

    write(specs);
    await loadReference(t.pool, shipped, { library: false, log });
    assert.equal(await rows(), specs.length);
    assert.equal(loaded.length, 1);
    await loadReference(t.pool, shipped, { library: false, log });
    assert.equal(loaded.length, 1, "an unchanged file costs no reload");

    write(specs.slice(1)); // an update ships a smaller set
    await loadReference(t.pool, shipped, { library: false, log });
    assert.equal(await rows(), specs.length - 1);

    const dir = await backup(t.pool, t.backups);
    assert.ok(!readManifest(dir).manifest.tables.some((x) => x.name === "TensionSpec"));
    await restore(t.pool, dir);
    assert.equal(await rows(), specs.length - 1, "a restore doesn't put older reference data back");
  } finally {
    await t.done();
  }
});

test("reference data: a set this build doesn't ship (or ships empty or cut off) leaves the loaded rows alone", { skip }, async () => {
  const t = await shop();
  try {
    const dir = (name) => {
      const d = path.join(t.dir, name);
      fs.mkdirSync(d);
      return d;
    };
    const rows = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM "TensionSpec"`)).rows[0].n;
    const mark = async () => (await t.pool.query(`SELECT obj_description('"TensionSpec"'::regclass, 'pg_class') AS c`)).rows[0].c;
    const earlier = dir("earlier");
    const made = [1, 2, 3].map((i) => ({ id: `chk${i}`, category: "Sewing", brand: "Check", models: `CHK${i}`, modelKeys: [`CHK${i}`], sourceFile: "check.pdf" }));
    fs.writeFileSync(path.join(earlier, "tension_specs.json"), JSON.stringify(made));
    await loadReference(t.pool, earlier, { library: false, log: quiet });
    assert.equal(await rows(), 3);
    const loaded = await mark();

    // A build without the manufacturers' data (the public code): no file at all.
    await loadReference(t.pool, dir("none"), { library: false, log: quiet });
    assert.equal(await rows(), 3, "a missing file empties nothing");
    assert.equal(await mark(), loaded);
    const empty = dir("empty");
    fs.writeFileSync(path.join(empty, "tension_specs.json"), "[]");
    await loadReference(t.pool, empty, { library: false, log: quiet });
    assert.equal(await rows(), 3, "nor does an empty list");
    const cut = dir("cut");
    fs.writeFileSync(path.join(cut, "tension_specs.json"), JSON.stringify(made).slice(0, 40));
    const logged = [];
    await loadReference(t.pool, cut, { library: false, log: (...a) => logged.push(a.join(" ")) });
    assert.equal(await rows(), 3, "nor a file cut off halfway");
    assert.equal(await mark(), loaded);
    assert.ok(logged.some((l) => l.includes("TensionSpec not loaded")), "which is logged");
  } finally {
    await t.done();
  }
});
