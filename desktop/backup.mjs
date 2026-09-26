// Backups of the shop's data: customers, machines, tickets, photos, parts, people, prices, shared notes, plus the
// reference data the program can't reload by itself (tension specs, factory settings, the manual list, pictures).
// The community hub's cached copies are left out: they're synced again from the hub after a restore.
// Each backup is a folder of gzipped COPY files plus manifest.json; restore replaces the shop data with it.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import copyStreams from "pg-copy-streams";

const { to: copyTo, from: copyFrom } = copyStreams;
// Never in a backup: the migration record (the program's own) and the hub's cached data (re-synced from the hub).
// The hub connection itself (HubState) and this shop's marketplace orders are kept.
const SKIP = new Set(["_prisma_migrations", "ManualLink", "HubPost", "HubPhoto", "HubFigure", "XPart", "Listing", "ListingPhoto"]);
// Reference data: backed up, but restored only from a backup that has it, so an older backup leaves what's here alone.
const REFERENCE = new Set(["TensionSpec", "FactorySetting", "LibraryDoc", "FigureImage", "ModelImage"]);
// Pictures are already compressed: don't spend time gzipping them hard.
const PICTURES = new Set(["FigureImage", "ModelImage", "MachinePhoto", "SharedPhoto"]);
const q = (name) => `"${name.replace(/"/g, '""')}"`;

async function backedUpTables(client) {
  const { rows } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  return rows.map((r) => r.tablename).filter((t) => !SKIP.has(t));
}

async function columns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

const NAME = /^(stitchbench|stitchshop)-\d{4}-\d\d-\d\d-\d\d-\d\d(-\d\d)?(-\d+)?$/;

/** This program's backups in root, newest first. StitchBench and StitchShop keep theirs apart even in one folder. */
export function listBackups(root, flavor = "stitchbench") {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => NAME.test(n) && n.startsWith(`${flavor}-`) && fs.existsSync(path.join(root, n, "manifest.json")))
    .sort()
    .reverse()
    .map((n) => path.join(root, n));
}

// One backup at a time: a second "Back up now" (or the nightly timer landing on it) waits for the first.
let running = Promise.resolve();

/**
 * Back up to a new folder in root. keep = how many of this program's backups to keep (older ones are removed unless
 * prune is false, as for the safety copy before a restore, which must never remove the backup being restored).
 */
export function backup(pool, root, { keep = 30, flavor = "stitchbench", prune = true, version = null } = {}) {
  const run = running.then(() => backupNow(pool, root, { keep, flavor, prune, version }));
  running = run.catch(() => {});
  return run;
}

async function backupNow(pool, root, { keep, flavor, prune, version }) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  let dir = path.join(root, `${flavor}-${stamp}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${flavor}-${stamp}-${i}`);
  fs.mkdirSync(root, { recursive: true });
  // A folder of its own for the work in progress (never shared with another run), renamed into place when complete.
  const tmp = fs.mkdtempSync(path.join(root, `.${flavor}-partial-`));
  const manifest = { created: d.toISOString(), flavor, version, lastMigration: null, shops: [], tables: [] };
  let client;
  try {
    client = await pool.connect();
    // One consistent snapshot of every table.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    manifest.lastMigration = (await client.query(`SELECT max(migration_name) AS m FROM "_prisma_migrations"`)).rows[0].m;
    manifest.shops = (await client.query(`SELECT id, name FROM "Shop" ORDER BY "createdAt"`)).rows;
    for (const t of await backedUpTables(client)) {
      const cols = await columns(client, t);
      const file = `${t}.copy.gz`;
      await pipeline(
        client.query(copyTo(`COPY ${q(t)} (${cols.map(q).join(", ")}) TO STDOUT`)),
        zlib.createGzip({ level: PICTURES.has(t) ? 1 : 6 }),
        fs.createWriteStream(path.join(tmp, file)),
      );
      const rows = Number((await client.query(`SELECT count(*) AS n FROM ${q(t)}`)).rows[0].n);
      manifest.tables.push({ name: t, file, columns: cols, rows });
    }
    await client.query("COMMIT");
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, dir);
  } catch (e) {
    await client?.query("ROLLBACK").catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    client?.release();
  }
  if (prune) for (const old of listBackups(root, flavor).slice(keep)) fs.rmSync(old, { recursive: true, force: true });
  return dir;
}

/** What a backup folder holds, or an error message when it isn't a backup this program can restore. */
export function readManifest(dir, flavor = "stitchbench") {
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) return { error: `Pick a folder named like ${flavor}-2026-09-25-01-00-00 from the backups folder.` };
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  // Backups from before the flavor was recorded carry only the folder name (all were StitchBench's).
  const from = manifest.flavor ?? (path.basename(dir).startsWith("stitchshop-") ? "stitchshop" : "stitchbench");
  if (from !== flavor) {
    const names = { stitchbench: "StitchBench", stitchshop: "StitchShop" };
    return { error: `That's a ${names[from] ?? from} backup. Restore it in ${names[from] ?? from}, not ${names[flavor]}.` };
  }
  return { manifest };
}

// Data fix-ups from migrations, safe to repeat: a backup from before a migration comes back with them applied.
const FIXUPS = [
  // 20260925170100_part_number_keys
  `UPDATE "Part" SET "numberKeys" = ARRAY[regexp_replace(upper("partNumber"), '[^A-Z0-9]', '', 'g')] WHERE "numberKeys" IS NULL OR cardinality("numberKeys") = 0`,
  `UPDATE "Part" SET "altNumbers" = '{}' WHERE "altNumbers" IS NULL`,
  // 20260926090000_review_fixes: a single-company install's marketplace listings and orders are that company's
  `UPDATE "Listing" SET "shopId" = (SELECT id FROM "Shop" LIMIT 1) WHERE mine AND "shopId" IS NULL AND (SELECT count(*) FROM "Shop") = 1`,
  `UPDATE "MarketOrder" SET "shopId" = (SELECT id FROM "Shop" LIMIT 1) WHERE "shopId" IS NULL AND (SELECT count(*) FROM "Shop") = 1`,
];

/** Replace all shop data with a backup. The database must already be at (or past) the backup's version. */
export async function restore(pool, dir, flavor = "stitchbench") {
  const { manifest, error } = readManifest(dir, flavor);
  if (error) throw new Error(error);
  for (const t of manifest.tables) {
    if (!fs.existsSync(path.join(dir, t.file))) throw new Error(`The backup is missing ${t.file}. Pick another backup.`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(`SELECT max(migration_name) AS m FROM "_prisma_migrations"`)).rows[0].m;
    if (manifest.lastMigration && current && manifest.lastMigration > current) {
      throw new Error("This backup is from a newer version of the program. Update the program first, then restore.");
    }
    // Load in any order: foreign keys aren't checked while restoring.
    await client.query("SET LOCAL session_replication_role = replica");
    const here = await backedUpTables(client);
    const inBackup = new Set(manifest.tables.map((t) => t.name));
    // All shop data is replaced; reference data only when the backup has it.
    const replace = here.filter((t) => !REFERENCE.has(t) || inBackup.has(t));
    if (replace.length) await client.query(`TRUNCATE ${replace.map(q).join(", ")}`);
    for (const t of manifest.tables) {
      if (!replace.includes(t.name)) continue;
      const have = new Set(await columns(client, t.name));
      if (t.columns.some((c) => !have.has(c))) throw new Error(`Backup table ${t.name} has columns this version doesn't know.`);
      await pipeline(
        fs.createReadStream(path.join(dir, t.file)),
        zlib.createGunzip(),
        client.query(copyFrom(`COPY ${q(t.name)} (${t.columns.map(q).join(", ")}) FROM STDIN`)),
      );
    }
    for (const sql of FIXUPS) await client.query(sql);
    // The hub's cached data isn't in backups, so sync it all again from the start.
    // Ask the hub again for everything; what was already applied is skipped (PartnerSeen), the rest catches the shop up.
    if (here.includes("HubState")) {
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
