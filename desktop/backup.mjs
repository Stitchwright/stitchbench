// Backups of the shop's own data: customers, machines, tickets, photos, parts, people, prices, shared notes.
// Factory specs, the manual list, manual figures and the hub's cached data are left out: they're reloaded or re-synced.
// Each backup is a folder of gzipped COPY files plus manifest.json; restore replaces the shop data with it.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import copyStreams from "pg-copy-streams";

const { to: copyTo, from: copyFrom } = copyStreams;
// Reference data (reloaded from the program) and the community hub's cached copies (re-synced from the hub) are left out;
// the hub connection itself (HubState) and this shop's marketplace orders are kept.
const REFERENCE = new Set([
  "_prisma_migrations", "TensionSpec", "FactorySetting", "LibraryDoc", "FigureImage", "ModelImage",
  "ManualLink", "HubPost", "HubPhoto", "HubFigure", "XPart", "Listing", "ListingPhoto",
]);
const q = (name) => `"${name.replace(/"/g, '""')}"`;

async function shopTables(client) {
  const { rows } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  return rows.map((r) => r.tablename).filter((t) => !REFERENCE.has(t));
}

async function columns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

export function listBackups(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => /^stitchbench-\d{4}-\d\d-\d\d-\d\d-\d\d$/.test(n) && fs.existsSync(path.join(root, n, "manifest.json")))
    .sort()
    .reverse()
    .map((n) => path.join(root, n));
}

export async function backup(pool, root, keep = 30) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
  const dir = path.join(root, `stitchbench-${stamp}`);
  const tmp = `${dir}.partial`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const client = await pool.connect();
  const manifest = { created: d.toISOString(), lastMigration: null, tables: [] };
  try {
    // One consistent snapshot of every table.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    manifest.lastMigration = (await client.query(`SELECT max(migration_name) AS m FROM "_prisma_migrations"`)).rows[0].m;
    for (const t of await shopTables(client)) {
      const cols = await columns(client, t);
      const file = `${t}.copy.gz`;
      await pipeline(client.query(copyTo(`COPY ${q(t)} (${cols.map(q).join(", ")}) TO STDOUT`)), zlib.createGzip(), fs.createWriteStream(path.join(tmp, file)));
      const rows = Number((await client.query(`SELECT count(*) AS n FROM ${q(t)}`)).rows[0].n);
      manifest.tables.push({ name: t, file, columns: cols, rows });
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    client.release();
  }
  fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  for (const old of listBackups(root).slice(keep)) fs.rmSync(old, { recursive: true, force: true });
  return dir;
}

/** Replace all shop data with a backup. The database must already be at (or past) the backup's version. */
export async function restore(pool, dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(`SELECT max(migration_name) AS m FROM "_prisma_migrations"`)).rows[0].m;
    if (manifest.lastMigration && current && manifest.lastMigration > current) {
      throw new Error("This backup is from a newer StitchBench. Update the program first, then restore.");
    }
    // Load in any order: foreign keys aren't checked while restoring.
    await client.query("SET LOCAL session_replication_role = replica");
    const tables = await shopTables(client);
    if (tables.length) await client.query(`TRUNCATE ${tables.map(q).join(", ")}`);
    for (const t of manifest.tables) {
      if (!tables.includes(t.name)) continue;
      const have = new Set(await columns(client, t.name));
      if (t.columns.some((c) => !have.has(c))) throw new Error(`Backup table ${t.name} has columns this version doesn't know.`);
      await pipeline(
        fs.createReadStream(path.join(dir, t.file)),
        zlib.createGunzip(),
        client.query(copyFrom(`COPY ${q(t.name)} (${t.columns.map(q).join(", ")}) FROM STDIN`)),
      );
    }
    // The hub's cached data isn't in backups, so sync it all again from the start.
    // Ask the hub again for everything; what was already applied is skipped (PartnerSeen), the rest catches the shop up.
    if (tables.includes("HubState")) {
      await client.query(`UPDATE "HubState" SET cursor = '0', "orderCursor" = '0', "partnerCursor" = CASE WHEN "partnerCursor" IS NULL THEN NULL ELSE '0' END`);
    }
    await client.query("COMMIT");
    return manifest;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
