// Builds the self-contained StitchBench server into desktop/server for the Windows program:
// the Next.js standalone build, its static files, public/, and the database migrations.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { writeNotices } from "./third-party-notices.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(import.meta.dirname, "server");

if (!process.argv.includes("--no-build")) {
  execSync("npm run build", { cwd: root, stdio: "inherit", env: { ...process.env, STANDALONE: "1" } });
}
const standalone = path.join(root, ".next", "standalone");
if (!fs.existsSync(path.join(standalone, "server.js"))) throw new Error("No standalone build. Run: STANDALONE=1 npm run build");

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(standalone, out, { recursive: true });
fs.cpSync(path.join(root, ".next", "static"), path.join(out, ".next", "static"), { recursive: true });
fs.cpSync(path.join(root, "public"), path.join(out, "public"), { recursive: true });
fs.cpSync(path.join(root, "prisma", "migrations"), path.join(out, "migrations"), { recursive: true });
// Reference data the program loads at start (reference.mjs); the hub's own seed files stay behind. The manufacturers'
// sets aren't in the public code: an official build fetches them first (scripts/data/fetch-reference-data.mjs), and a
// build without them works, with no factory specs shown (reference.mjs leaves a set it isn't given as it is).
fs.mkdirSync(path.join(out, "seed-data"), { recursive: true });
const missing = [];
for (const f of ["tension_specs.json", "factory_settings.json", "service_modes.json", "library_docs.json"]) {
  const from = path.join(root, "prisma", "seed-data", f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, "seed-data", f));
  else missing.push(f);
}
if (missing.length) console.log(`reference data: not in prisma/seed-data, so not in this build: ${missing.join(", ")}`);

// Never ship the developer's .env (database password, auth secret); the program passes its own settings.
for (const f of fs.readdirSync(out)) if (f.startsWith(".env")) fs.rmSync(path.join(out, f));
// Traced by a broad file pattern at some point, never needed to run: the source, the Windows wrapper and its installer
// output (the previous build, nested), the docs, the scripts (the dev license key is read only by test builds, and
// this is never one), the Railway files. A pattern once made the app 800 MB; this keeps it from shipping again.
for (const d of ["src", "desktop", "docs", "scripts", ".railway", "railway.json", "tests"]) fs.rmSync(path.join(out, d), { recursive: true, force: true });

// electron-builder leaves every folder named node_modules out of extra resources, so ship them as _node_modules;
// the program renames them back when it starts (main.mjs, unpackModules).
const rename = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    rename(p);
    if (e.name === "node_modules") fs.renameSync(p, path.join(dir, "_node_modules"));
  }
};
rename(out);

// The licenses of everything shipped with the program (THIRD_PARTY_NOTICES.txt beside the server): several ask for it.
const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"));
const notices = writeNotices(out, import.meta.dirname, version);
console.log(`third-party notices: ${notices.count} packages`);

const size = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`app ready: ${out} (${(size(out) / 1e6).toFixed(0)} MB)`);
