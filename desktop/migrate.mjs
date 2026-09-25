// Brings the program's database up to date with the app's migrations (prisma/migrations, copied into app/migrations).
// Records them in "_prisma_migrations" exactly as `prisma migrate deploy` would, so either tool can be used.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export async function migrate(pool, dir, log = console.log) {
  await pool.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
  )`);
  const { rows } = await pool.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
  const done = new Set(rows.map((r) => r.migration_name));
  const names = fs
    .readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, "migration.sql")))
    .sort();
  let applied = 0;
  for (const name of names) {
    if (done.has(name)) continue;
    const sql = fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES ($1, $2, now(), $3, now(), 1)`,
        [crypto.randomUUID(), crypto.createHash("sha256").update(sql).digest("hex"), name],
      );
      await client.query("COMMIT");
      applied++;
      log(`database updated: ${name}`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Database update ${name} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
