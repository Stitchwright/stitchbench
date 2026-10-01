// The server's limited database login (app-role.mjs) against a scratch Postgres. Same setup as desktop.test.mjs:
//   TEST_DATABASE_URL=postgresql://user:password@localhost:5433/postgres npm test
// The user has to be a superuser (it plays the program's owner role). Each test makes its own database and its own
// app role (a cluster-wide name, so a scratch one, never stitchbench_app) and drops both afterwards.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { migrate } from "../migrate.mjs";
import { ensureAppRole } from "../app-role.mjs";
import { backup, restore } from "../backup.mjs";

const base = process.env.TEST_DATABASE_URL;
const skip = base ? false : "set TEST_DATABASE_URL (a scratch Postgres, superuser) to run these";
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "prisma", "migrations");
const quiet = () => {};

/** A migrated scratch database, a scratch role name and a way to connect as it; done() drops the lot. */
async function scratch() {
  const tag = crypto.randomBytes(4).toString("hex");
  const name = `sbtest_${tag}`;
  const role = `sbtest_app_${tag}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-role-test-"));
  const clients = [];
  const t = {
    pool,
    role,
    dir,
    /** A connection as the app role with this password (closed by done()). */
    async asApp(password) {
      const c = new pg.Client({ host: url.hostname, port: Number(url.port || 5432), user: role, password, database: name });
      await c.connect();
      clients.push(c);
      return c;
    },
    async done() {
      for (const c of clients) await c.end().catch(() => {});
      await pool.end();
      fs.rmSync(dir, { recursive: true, force: true });
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await a.query(`DROP DATABASE ${name} WITH (FORCE)`); // takes the role's grants and default privileges with it
      await a.query(`DROP ROLE IF EXISTS ${role}`);
      await a.end();
    },
  };
  try {
    await migrate(pool, MIGRATIONS, quiet);
  } catch (e) {
    await t.done();
    throw e;
  }
  return t;
}

const refused = (p, re) => assert.rejects(p, re);

test("app role: reads and writes the shop tables, and is refused everything a superuser could do", { skip }, async () => {
  const t = await scratch();
  try {
    const password = crypto.randomBytes(18).toString("base64url");
    assert.equal(await ensureAppRole(t.pool, { password, role: t.role, log: quiet }), t.role);
    const app = await t.asApp(password);

    // Not a superuser, and none of the superuser-only powers.
    const who = (await app.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
    assert.deepEqual(who, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    await refused(app.query(`COPY "Shop" TO PROGRAM 'calc.exe'`), /permission denied|superuser|pg_execute_server_program/);
    await refused(app.query(`COPY "Shop" TO 'C:/out.txt'`), /permission denied|superuser|pg_write_server_files/);
    await refused(app.query(`SELECT pg_read_file('PG_VERSION')`), /permission denied/);
    await refused(app.query(`SELECT pg_ls_dir('.')`), /permission denied/);
    await refused(app.query(`CREATE TABLE "Evil" (id text)`), /permission denied/);
    await refused(app.query(`DROP TABLE "Customer"`), /must be owner/);
    await refused(app.query(`TRUNCATE "Customer"`), /permission denied/);
    await refused(app.query(`ALTER TABLE "Customer" ADD COLUMN x text`), /must be owner/);
    await refused(app.query(`SET session_replication_role = replica`), /permission denied|superuser/);
    await refused(app.query(`ALTER ROLE ${t.role} SUPERUSER`), /permission denied|superuser/);
    await refused(app.query(`CREATE ROLE sbtest_other LOGIN`), /permission denied/);
    await refused(app.query(`CREATE DATABASE sbtest_other`), /permission denied/);
    await refused(app.query(`CREATE EXTENSION IF NOT EXISTS plpython3u`), /permission denied|superuser|not available/);

    // What the server does: plain DML, row locks, transaction-scoped advisory locks, jsonb helpers.
    await app.query(`INSERT INTO "Shop" (id, name) VALUES ('shop1', 'Ann''s Bench')`);
    await app.query(`INSERT INTO "Customer" (id, "shopId", name) VALUES ('c1', 'shop1', 'Ann')`);
    await app.query(`UPDATE "Customer" SET name = 'Anne' WHERE id = 'c1'`);
    assert.equal((await app.query(`SELECT name FROM "Customer" WHERE id = 'c1' FOR UPDATE`)).rows[0].name, "Anne");
    await app.query(`DELETE FROM "Customer" WHERE id = 'c1'`);
    await app.query("BEGIN");
    assert.equal((await app.query(`SELECT pg_try_advisory_xact_lock(7710002, hashtext('shop1')) AS ok`)).rows[0].ok, true);
    await app.query(`SELECT pg_advisory_xact_lock(7710001)`);
    await app.query("COMMIT");
    const n = (await app.query(`SELECT count(*)::int AS n FROM "TensionSpec"`)).rows[0].n;
    assert.equal(n, 0);
    // The migration record is a table like any other to the grants; it just isn't the server's to change in practice.
    assert.ok((await app.query(`SELECT count(*)::int AS n FROM "_prisma_migrations"`)).rows[0].n > 0);
  } finally {
    await t.done();
  }
});

test("app role: tables from a later update are covered before and after the grants run again", { skip }, async () => {
  const t = await scratch();
  try {
    const password = crypto.randomBytes(18).toString("base64url");
    await ensureAppRole(t.pool, { password, role: t.role, log: quiet });
    const app = await t.asApp(password);

    // A future migration, run by the owner: default privileges cover the new table with no further step.
    await t.pool.query(`CREATE TABLE "Later" (id serial PRIMARY KEY, note text)`);
    await app.query(`INSERT INTO "Later" (note) VALUES ('x')`);
    assert.equal((await app.query(`SELECT count(*)::int AS n FROM "Later"`)).rows[0].n, 1);

    // The next start: no migrations to apply, the role setup runs again and nothing is lost.
    assert.equal(await migrate(t.pool, MIGRATIONS, quiet), 0);
    await ensureAppRole(t.pool, { password, role: t.role, log: quiet });
    await app.query(`INSERT INTO "Later" (note) VALUES ('y')`);
    await app.query(`INSERT INTO "Shop" (id, name) VALUES ('shop1', 'Bench')`);
    await refused(app.query(`CREATE TABLE "Evil" (id text)`), /permission denied/);
  } finally {
    await t.done();
  }
});

test("app role: the password on file wins over the role's, so an old secrets.json can't lock the server out", { skip }, async () => {
  const t = await scratch();
  try {
    const first = crypto.randomBytes(18).toString("base64url");
    await ensureAppRole(t.pool, { password: first, role: t.role, log: quiet });
    // The role's password drifts from the file (a secrets.json put back from an older backup makes a new one up).
    const second = crypto.randomBytes(18).toString("base64url");
    await ensureAppRole(t.pool, { password: second, role: t.role, log: quiet });
    const app = await t.asApp(second);
    assert.equal((await app.query(`SELECT current_user`)).rows[0].current_user, t.role);
    await refused(t.asApp(first), /password authentication failed/);
    // A role someone made by hand with more than it should have is cut back.
    await t.pool.query(`ALTER ROLE ${t.role} CREATEDB CREATEROLE`);
    await ensureAppRole(t.pool, { password: second, role: t.role, log: quiet });
    const who = (await t.pool.query(`SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1`, [t.role])).rows[0];
    assert.deepEqual(who, { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  } finally {
    await t.done();
  }
});

test("app role: a backup and restore by the owner leave the server's access as it was", { skip }, async () => {
  const t = await scratch();
  try {
    const password = crypto.randomBytes(18).toString("base64url");
    await ensureAppRole(t.pool, { password, role: t.role, log: quiet });
    const app = await t.asApp(password);
    await app.query(`INSERT INTO "Shop" (id, name) VALUES ('shop1', 'Before')`);
    const dir = await backup(t.pool, path.join(t.dir, "backups"));
    await app.query(`UPDATE "Shop" SET name = 'After' WHERE id = 'shop1'`);
    await restore(t.pool, dir);
    await ensureAppRole(t.pool, { password, role: t.role, log: quiet }); // as main.mjs does after a restore
    assert.equal((await app.query(`SELECT name FROM "Shop" WHERE id = 'shop1'`)).rows[0].name, "Before");
    await app.query(`INSERT INTO "Customer" (id, "shopId", name) VALUES ('c1', 'shop1', 'Ann')`);
    await refused(app.query(`SELECT pg_read_file('PG_VERSION')`), /permission denied/);
  } finally {
    await t.done();
  }
});

test("app role: refuses a missing password or a bad role name before touching the database", { skip }, async () => {
  const t = await scratch();
  try {
    await refused(ensureAppRole(t.pool, { role: t.role, log: quiet }), /password/);
    await refused(ensureAppRole(t.pool, { password: "x", role: `${t.role}; DROP ROLE x`, log: quiet }), /role name/);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`, [t.role])).rows[0].n, 0);
  } finally {
    await t.done();
  }
});
