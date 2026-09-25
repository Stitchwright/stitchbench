// Back up the running program's shop data from the command line (the same backup as the tray's "Back up now").
// usage: node backup-now.mjs
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { backup } from "./backup.mjs";

const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, "StitchBench", "config.json"), "utf8"));
const pool = new pg.Pool({ host: "127.0.0.1", port: cfg.dbPort, user: "stitchbench", password: cfg.dbPassword, database: "stitchbench" });
const dir = await backup(pool, cfg.backupDir, cfg.backupsToKeep);
const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
console.log(`backup saved to ${dir}`);
for (const t of m.tables) if (t.rows) console.log(`  ${t.name}: ${t.rows}`);
await pool.end();
