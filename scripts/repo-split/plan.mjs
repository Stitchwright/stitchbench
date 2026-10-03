// Dry run of the repository split (docs/plans/repo-split-design.md). It PRINTS the `git mv` commands and the tracked
// files each would move, grouped by destination, with a count per group and the files it could not classify. It
// moves nothing and writes nothing: run it as `node scripts/repo-split/plan.mjs` from the repository root, read the
// output, then run the commands from the design document's section 7 by hand (or paste them from here).
//
// Rules (first match wins; paths are the ones `git ls-files` prints, with forward slashes):
//   root               stays where it is (workspace files, docs, workflows, Railway files)
//   packages/core      the Next.js app, its schema, tests, checks and tooling
//   packages/desktop   the Electron shell (today desktop/)
// Nothing that exists today moves into apps/stitchbench or apps/stitchshop: those are new files, listed at the end.
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
// Tracked files plus new ones not yet committed (this script, for one), so nothing is swept along by a directory move.
const files = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

/** [where, test]: `where` is "root", "packages/core" or "packages/desktop"; a string test is a prefix, a RegExp a match. */
const RULES = [
  // Stays at the root: workspace, documentation, GitHub, Railway, the dev database.
  ["root", /^(CLAUDE|AGENTS|INSTALL|README)\.md$/],
  ["root", "docs/"],
  ["root", ".github/"],
  ["root", ".railway/"],
  ["root", /^(railway\.json|docker-compose\.yml|\.gitignore|package\.json|package-lock\.json)$/],
  ["root", "scripts/repo-split/"],
  // The Electron shell, whole: desktop/ becomes packages/desktop itself (its contents, not a desktop/ folder inside).
  ["packages/desktop", "desktop/", "desktop/"],
  // The app and everything that builds, seeds, tests or checks it.
  ["packages/core", "src/"],
  ["packages/core", "prisma/"],
  ["packages/core", "prisma.config.ts"],
  ["packages/core", "public/"],
  ["packages/core", "tests/"],
  ["packages/core", "scripts/"],
  ["packages/core", /^(next\.config\.ts|tsconfig\.json|eslint\.config\.mjs|postcss\.config\.mjs|playwright\.config\.ts|\.env\.example)$/],
];

const groups = new Map([
  ["root", []],
  ["packages/core", []],
  ["packages/desktop", []],
]);
const unclassified = [];
const strips = new Map(); // destination -> top folder that is dropped from the moved path
for (const f of files) {
  const rule = RULES.find(([, t]) => (typeof t === "string" ? f.startsWith(t) : t.test(f)));
  if (rule) groups.get(rule[0]).push(f), rule[2] && strips.set(rule[0], rule[2]);
  else unclassified.push(f);
}

/**
 * The `git mv` commands for one destination. A directory moves with one command when every file under it (tracked or
 * new) goes to this destination; otherwise its children are tried one level down, so a folder that stays behind
 * (scripts/repo-split) keeps its siblings moving as whole folders. `git mv` keeps history: git follows renames by
 * content, and the move is one commit with nothing else in it.
 */
function commands(dest, list) {
  if (dest === "root") return [];
  const here = new Set(list);
  const strip = strips.get(dest);
  const target = (p) => (strip && p.startsWith(strip) ? `${dest}/${p.slice(strip.length)}` : strip && p + "/" === strip ? dest : `${dest}/${p}`);
  const out = [];
  const visit = (dir) => {
    const under = files.filter((f) => f.startsWith(dir + "/"));
    if (under.every((f) => here.has(f))) return out.push(`git mv ${dir} ${target(dir)}`);
    const children = new Set(under.filter((f) => here.has(f)).map((f) => f.slice(dir.length + 1).split("/")[0]));
    for (const c of children) {
      const p = `${dir}/${c}`;
      if (files.includes(p)) out.push(`git mv ${p} ${target(p)}`);
      else visit(p);
    }
  };
  const tops = [...new Set(list.map((f) => (f.includes("/") ? f.slice(0, f.indexOf("/")) : f)))];
  for (const t of tops) {
    if (files.includes(t)) out.push(`git mv ${t} ${target(t)}`);
    else visit(t);
  }
  // Parent folders that `git mv` needs to exist (it makes the last one itself when the target does not exist).
  const dirs = new Set(out.map((c) => path.posix.dirname(c.split(" ")[3])));
  return [...[...dirs].map((d) => `mkdir -p ${d}`), ...out];
}

console.log(`Repository split, dry run. ${files.length} tracked files. Nothing is moved.\n`);
for (const [dest, list] of groups) {
  console.log(`== ${dest}: ${list.length} files ${dest === "root" ? "(stay)" : ""}`);
  for (const f of list) console.log(`   ${f}`);
  const cmds = commands(dest, list);
  if (cmds.length) {
    console.log(`   -- commands (${cmds.length}):`);
    for (const c of cmds) console.log(`   ${c}`);
  }
  console.log();
}
console.log(`== could not classify: ${unclassified.length} files`);
for (const f of unclassified) console.log(`   ${f}`);
console.log();

const NEW_FILES = {
  "apps/stitchbench": ["package.json (name, version 1.6.x, stitch.flavor=stitchbench)", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "src/app/** (generated shims)", "src/proxy.ts, src/instrumentation.ts (generated shims)", "electron-builder.yml", "brand/icon.png", "README.md (one paragraph)"],
  "apps/stitchshop": ["the same nine, with the StitchShop name, appId, defaults and version"],
  "packages/core": ["package.json (@stitch/core: today's root package.json minus the workspace lines)"],
  "packages/desktop": ["(package.json is today's desktop/package.json without the StitchShop installer flags)"],
  "root": ["package.json rewritten as the workspace root (workspaces, forwarding scripts)", "scripts/repo-split/sync-app.mjs (the shim generator)"],
};
console.log("== new files the design adds (not moves)");
for (const [dest, list] of Object.entries(NEW_FILES)) {
  console.log(`   ${dest}:`);
  for (const f of list) console.log(`      ${f}`);
}
console.log("\nSummary:");
for (const [dest, list] of groups) console.log(`   ${dest.padEnd(18)} ${String(list.length).padStart(4)}`);
console.log(`   ${"unclassified".padEnd(18)} ${String(unclassified.length).padStart(4)}`);
