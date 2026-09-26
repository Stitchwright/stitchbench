// One-off: copy the shop data (companies, logins, customers, machines, tickets, photos, prices...) from the
// development database into the Windows program's database, using the program's own backup + restore.
// usage: node import-from-dev.mjs <dev DATABASE_URL>   (the program must be running)
// Then load the factory specs and figures into it from the repo:
//   DATABASE_URL=<program url> npm run db:seed ; DATABASE_URL=<program url> npx tsx scripts/library/upload-media.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { FLAVOR, programConfig } from "./cli-config.mjs";
import { backup, restore } from "./backup.mjs";

const devUrl = process.argv[2];
if (!devUrl) throw new Error("usage: node import-from-dev.mjs <dev DATABASE_URL>");
const cfg = programConfig();
const dev = new pg.Pool({ connectionString: devUrl });
const prog = new pg.Pool({ host: "127.0.0.1", port: cfg.dbPort, user: "stitchbench", password: cfg.dbPassword, database: "stitchbench" });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-import-"));
const dir = await backup(dev, tmp, { flavor: FLAVOR, prune: false });
const m = await restore(prog, dir, FLAVOR);
for (const t of m.tables) if (t.rows) console.log(`${t.name}: ${t.rows}`);
fs.rmSync(tmp, { recursive: true, force: true });
await dev.end();
await prog.end();
console.log("imported");
