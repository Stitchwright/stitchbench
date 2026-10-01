// Backups of the shop's data: customers, machines, tickets, photos, parts, people, prices, shared notes, plus the
// pictures the program can't reload by itself (figures and machine pictures). The tension specs, factory settings and
// manual list come with the program (reference.mjs loads them), so they're left out: a restore must not put an older
// set back. The community hub's cached copies are left out too: they're synced again from the hub after a restore.
// Each backup is a folder of gzipped COPY files plus manifest.json; restore replaces the shop data with it.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import copyStreams from "pg-copy-streams";

const { to: copyTo, from: copyFrom } = copyStreams;
// Never in a backup: the migration record (the program's own), the shipped reference sets (reference.mjs reloads them,
// and skips a table whose comment says the shipped set is in, which a restore wouldn't change) and the hub's cached
// data (re-synced from the hub). The hub connection itself (HubState), this shop's marketplace orders and its listings
// are kept: which company on this install owns a listing (shopId) is known here only, not on the hub.
const SKIP = new Set(["_prisma_migrations", "TensionSpec", "FactorySetting", "LibraryDoc", "ManualLink", "HubPost", "HubPhoto", "HubFigure", "XPart", "ListingPhoto"]);
// Backed up, but restored only from a backup that has it, so an older backup leaves what's here alone: the reference
// pictures, and the listings (backups before 1.4.2 left them out; the ones here keep their owner, the hub refreshes the rest).
const OPTIONAL = new Set(["FigureImage", "ModelImage", "Listing"]);
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

/**
 * Backups from before 1.4.2 recorded no flavor, and both programs named theirs stitchbench-*. Those sitting in
 * StitchShop's own "StitchShop Backups" folder are StitchShop's: it keeps counting and pruning them.
 */
function legacyOwn(root, name, flavor) {
  if (flavor === "stitchbench" || !name.startsWith("stitchbench-") || !path.basename(root).startsWith("StitchShop")) return false;
  try {
    return !("flavor" in JSON.parse(fs.readFileSync(path.join(root, name, "manifest.json"), "utf8")));
  } catch {
    return false;
  }
}

/**
 * Newest first by the numbers in the name: the date and time, then the "-2", "-3"... a second backup in the same
 * second gets. Compared as numbers, not text: as text "-10" sorts before "-9", so the tenth backup of a second would
 * count as older than the ninth, and pruning would keep the wrong ones (and the last-backup time would be off).
 */
export function newestFirst(a, b) {
  const nums = (n) => n.split("-").slice(1).map(Number);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    // A name with fewer numbers is the first of its second (no suffix), so it is the older one.
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** This program's backups in root, newest first. StitchBench and StitchShop keep theirs apart even in one folder. */
export function listBackups(root, flavor = "stitchbench") {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => NAME.test(n) && (n.startsWith(`${flavor}-`) || legacyOwn(root, n, flavor)) && fs.existsSync(path.join(root, n, "manifest.json")))
    .sort(newestFirst)
    .map((n) => path.join(root, n));
}

// One at a time, backups and restores alike: a second "Back up now" (or the nightly timer landing on it) waits for the
// first, and a backup never runs beside a restore. Its snapshot, taken while the restore's TRUNCATE is in flight, would
// see every table empty and be saved as a complete backup.
let chain = Promise.resolve();

function oneAtATime(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

/**
 * Back up to a new folder in root. keep = how many of this program's backups to keep (older ones are removed unless
 * prune is false, as for the safety copy before a restore, which must never remove the backup being restored).
 */
export function backup(pool, root, { keep = 30, flavor = "stitchbench", prune = true, version = null } = {}) {
  return oneAtATime(() => backupNow(pool, root, { keep, flavor, prune, version }));
}

/** Leftovers of backups cut short (a power cut, an update or a Windows restart mid-backup): removed once an hour old. */
function sweepPartials(root, flavor) {
  for (const n of fs.readdirSync(root)) {
    if (!n.startsWith(`.${flavor}-partial-`)) continue;
    const p = path.join(root, n);
    try {
      // The newest write anywhere in it: a slow backup still running from a console (backup-now.mjs) keeps writing.
      const newest = Math.max(fs.statSync(p).mtimeMs, ...fs.readdirSync(p).map((f) => fs.statSync(path.join(p, f)).mtimeMs));
      if (Date.now() - newest > 3600_000) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* in use, or gone already: next time */
    }
  }
}

async function backupNow(pool, root, { keep, flavor, prune, version }) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  let dir = path.join(root, `${flavor}-${stamp}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${flavor}-${stamp}-${i}`);
  fs.mkdirSync(root, { recursive: true });
  sweepPartials(root, flavor);
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
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* a file still held open (antivirus): the sweep gets it next time, and the real error is the one to report */
    }
    throw e;
  } finally {
    client?.release();
  }
  // keep comes from the settings file: a whole number of backups to hold on to, 0 for all of them. Blank or a word
  // means the usual 30, never none (slice(0) would remove every backup). The one just made is never removed either.
  let limit = Number.parseInt(keep, 10);
  if (!(limit >= 0)) limit = 30;
  if (prune && limit > 0) {
    for (const old of listBackups(root, flavor).slice(limit)) if (old !== dir) fs.rmSync(old, { recursive: true, force: true });
  }
  return dir;
}

/** What a backup folder holds, or an error message when it isn't a backup this program can restore. */
export function readManifest(dir, flavor = "stitchbench") {
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) return { error: `Pick a folder named like ${flavor}-2026-09-25-01-00-00 from the backups folder.` };
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  // Backups from before 1.4.2 recorded no flavor, and both programs named theirs stitchbench-*, so the name says
  // nothing: either program restores one (its owner knows which folder it came from).
  const from = manifest.flavor ?? flavor;
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
export function restore(pool, dir, flavor = "stitchbench") {
  return oneAtATime(() => restoreNow(pool, dir, flavor));
}

async function restoreNow(pool, dir, flavor) {
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
    // All shop data is replaced; the optional tables only when the backup has them. Tables an older backup has but
    // this version no longer backs up (the shipped reference sets) are left as they are.
    const replace = here.filter((t) => !OPTIONAL.has(t) || inBackup.has(t));
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
