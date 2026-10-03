// The tray's "Reset a password..." (reset-password.mjs): the password it makes, the dialog's lines, and (with
// TEST_DATABASE_URL, a scratch Postgres as in desktop.test.mjs) the login's hash and sessionVersion after a reset.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import pg from "pg";
import { migrate } from "../migrate.mjs";
import { describeLogin, listLogins, newPassword, PASSWORD_LENGTH, resetLogin, setPassword } from "../reset-password.mjs";

const base = process.env.TEST_DATABASE_URL;
const skip = base ? false : "set TEST_DATABASE_URL (a scratch Postgres, superuser) to run these";
const MIGRATIONS = path.join(path.resolve(import.meta.dirname, "..", ".."), "prisma", "migrations");

test("newPassword: 12 characters, none that look alike, different every time", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = newPassword();
    assert.equal(p.length, PASSWORD_LENGTH);
    assert.match(p, /^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
  assert.equal(newPassword(20).length, 20);
});

test("describeLogin: name, email and role; the company only when the install has several", () => {
  const l = { name: "Pat Smith", email: "pat@shop.com", role: "OWNER", shop: "Sew & Vac" };
  assert.equal(describeLogin(l, false), "Pat Smith (pat@shop.com), owner");
  assert.equal(describeLogin(l, true), "Pat Smith (pat@shop.com), owner, Sew & Vac");
});

test("reset: the hash changes, sessionVersion goes up by one, owners are listed first, a missing login is refused", { skip }, async () => {
  const name = `sbtest_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  try {
    await migrate(pool, MIGRATIONS, () => {});
    await pool.query(`INSERT INTO "Shop" (id, name) VALUES ('shop1', 'Sew & Vac')`);
    await pool.query(
      `INSERT INTO "User" (id, "shopId", email, name, role, "passwordHash", "sessionVersion") VALUES ('t1', 'shop1', 'tech@shop.com', 'Tech', 'TECH', 'old', 0), ('o1', 'shop1', 'pat@shop.com', 'Pat', 'OWNER', 'old', 3)`,
    );
    const logins = await listLogins(pool);
    assert.deepEqual(
      logins.map((l) => l.id),
      ["o1", "t1"],
    );
    // A stand-in for bcryptjs: the hash is whatever it returns.
    const bcrypt = { hash: async (p) => `hashed:${p}` };
    const password = await resetLogin(pool, bcrypt, "o1");
    assert.equal(password.length, PASSWORD_LENGTH);
    const row = (await pool.query(`SELECT "passwordHash", "sessionVersion" FROM "User" WHERE id = 'o1'`)).rows[0];
    assert.equal(row.passwordHash, `hashed:${password}`);
    assert.equal(row.sessionVersion, 4);
    const other = (await pool.query(`SELECT "passwordHash", "sessionVersion" FROM "User" WHERE id = 't1'`)).rows[0];
    assert.deepEqual(other, { passwordHash: "old", sessionVersion: 0 });
    assert.equal(await setPassword(pool, "nobody", "x"), false);
    await assert.rejects(resetLogin(pool, bcrypt, "nobody"), /isn't there/);
  } finally {
    await pool.end();
    const a = new pg.Client({ connectionString: base });
    await a.connect();
    await a.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await a.end();
  }
});
