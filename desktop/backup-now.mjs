// Back up the running program's shop data from the command line (the same backup as the tray's "Back up now").
// usage: node backup-now.mjs        (SB_FLAVOR=stitchshop for StitchShop)
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { FLAVOR, programConfig } from "./cli-config.mjs";
import { backup } from "./backup.mjs";

const cfg = programConfig();
const pool = new pg.Pool({ host: "127.0.0.1", port: cfg.dbPort, user: "stitchbench", password: cfg.dbPassword, database: "stitchbench" });
const dir = await backup(pool, cfg.backupDir, { keep: cfg.backupsToKeep, flavor: FLAVOR });
const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
console.log(`backup saved to ${dir}`);
for (const t of m.tables) if (t.rows) console.log(`  ${t.name}: ${t.rows}`);
await pool.end();
