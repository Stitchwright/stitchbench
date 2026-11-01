// Runs the database check scripts (scripts/checks/*.check.ts) the way CI does: each check gets a database of its own,
// cloned from a migrated template, so no check sees another's rows (some need an empty program, e.g. offsite).
//   node scripts/checks/run-ci.mjs <shard> <shards>      e.g. 1 4 = every 4th check starting at the first
// Needs ADMIN_DATABASE_URL (a role that can CREATE DATABASE, pointing at any database on the server) and `npx prisma`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const admin = process.env.ADMIN_DATABASE_URL;
if (!admin) throw new Error("Set ADMIN_DATABASE_URL (a Postgres role that can create databases).");
const shard = Number(process.argv[2] ?? 1);
const shards = Number(process.argv[3] ?? 1);
const only = process.argv[4]; // optional: a single check's name

const withDb = (name) => {
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return u.toString();
};
const sql = (q) => {
  const r = spawnSync("psql", [admin, "-v", "ON_ERROR_STOP=1", "-qc", q], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`psql failed: ${q}`);
};
const env = { ...process.env, AUTH_SECRET: process.env.AUTH_SECRET ?? "ci-auth-secret", SETTINGS_KEY: process.env.SETTINGS_KEY ?? "ci-settings-key" };

// ci-skip.txt: one check name per line, "name  # why and which issue". Left out of CI until fixed; never silently.
const skipFile = path.join(root, "scripts/checks/ci-skip.txt");
const skipped = existsSync(skipFile)
  ? readFileSync(skipFile, "utf8").split("\n").map((l) => l.split("#")[0].trim()).filter(Boolean)
  : [];

const checks = readdirSync(path.join(root, "scripts/checks"))
  .filter((f) => f.endsWith(".check.ts"))
  .sort()
  .filter((f) => !skipped.includes(f.replace(".check.ts", "")))
  .filter((f) => !only || f === `${only}.check.ts`)
  .filter((_, i) => i % shards === shard - 1);

const template = `sb_template_${shard}`;
sql(`DROP DATABASE IF EXISTS ${template}`);
sql(`CREATE DATABASE ${template}`);
const mig = spawnSync("npx", ["prisma", "migrate", "deploy"], { cwd: root, env: { ...env, DATABASE_URL: withDb(template) }, stdio: "inherit" });
if (mig.status !== 0) process.exit(1);

const failed = [];
const t0 = Date.now();
for (const f of checks) {
  const name = f.replace(".check.ts", "");
  const dbName = `sb_${shard}_${name.replace(/[^a-z0-9]/gi, "_")}`;
  sql(`DROP DATABASE IF EXISTS ${dbName}`);
  sql(`CREATE DATABASE ${dbName} TEMPLATE ${template}`);
  const t = Date.now();
  console.log(`::group::${name}`);
  const r = spawnSync("npm", ["run", "-s", "check", `scripts/checks/${f}`], { cwd: root, env: { ...env, DATABASE_URL: withDb(dbName) }, stdio: "inherit", timeout: 5 * 60_000 });
  console.log("::endgroup::");
  const secs = Math.round((Date.now() - t) / 1000);
  console.log(`${r.status === 0 ? "PASS" : "FAIL"} ${name} (${secs}s)`);
  if (r.status !== 0) failed.push(name);
  sql(`DROP DATABASE IF EXISTS ${dbName}`);
}
sql(`DROP DATABASE IF EXISTS ${template}`);
console.log(`shard ${shard}/${shards}: ${checks.length} checks, ${failed.length} failed, ${Math.round((Date.now() - t0) / 1000)}s`);
if (failed.length) {
  console.log(`FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
