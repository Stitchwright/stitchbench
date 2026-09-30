// One-off: replace the Windows program's shop data (companies, logins, customers, machines, tickets, photos, prices...)
// with the data of another StitchBench database, using the program's own backup + restore. It is a replace, not a merge.
// usage: node import-from-dev.mjs <dev DATABASE_URL> [--replace]
// The program must be running (its database is in it), best with nobody using it: its server keeps serving while the
// data is swapped. A program that already has a company needs --replace; what is there is backed up first (the folder
// is printed), because everything entered since its last backup would otherwise be gone.
// Then load the factory specs and figures into it from the repo:
//   DATABASE_URL=<program url> npm run db:seed ; DATABASE_URL=<program url> npx tsx scripts/library/upload-media.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { FLAVOR, programConfig } from "./cli-config.mjs";
import { backup, restore } from "./backup.mjs";

const args = process.argv.slice(2);
const replace = args.includes("--replace");
const devUrl = args.find((a) => !a.startsWith("--"));
if (!devUrl) throw new Error("usage: node import-from-dev.mjs <dev DATABASE_URL> [--replace]");
const cfg = programConfig();
const dev = new pg.Pool({ connectionString: devUrl });
const prog = new pg.Pool({ host: "127.0.0.1", port: cfg.dbPort, user: "stitchbench", password: cfg.dbPassword, database: "stitchbench" });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-import-"));
try {
  const shops = Number((await prog.query(`SELECT count(*) AS n FROM "Shop"`)).rows[0].n);
  if (shops && !replace) {
    throw new Error(
      `The program already has ${shops} compan${shops === 1 ? "y" : "ies"}. This replaces all of its shop data with the other database's. Run it again with --replace if that is what you want; what is there now is backed up first.`,
    );
  }
  if (shops) console.log(`the current data is saved in ${await backup(prog, cfg.backupDir, { flavor: FLAVOR, prune: false })}`);
  const dir = await backup(dev, tmp, { flavor: FLAVOR, prune: false });
  const m = await restore(prog, dir, FLAVOR);
  for (const t of m.tables) if (t.rows) console.log(`${t.name}: ${t.rows}`);
  console.log("imported");
} finally {
  // The dump holds every login and customer: gone whether the import worked or not.
  fs.rmSync(tmp, { recursive: true, force: true });
  await dev.end();
  await prog.end();
}
