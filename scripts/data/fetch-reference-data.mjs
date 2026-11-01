// Downloads the manufacturers' reference data into prisma/seed-data for an official build: the tension specs, factory
// settings and manual list read out of OEM manuals, and the hub's manual links. They aren't part of the public code;
// they live in a private repository (INSTALL.md, "Reference data"). The hosted build runs this before `next build`
// (npm's prebuild) and the installers workflow runs it before anything else is installed.
//   STITCH_DATA_TOKEN  a GitHub token that can read the data repository. Unset: nothing is downloaded and the build goes
//                      on without the data (the program works without it, with no factory specs shown).
//   STITCH_DATA_REPO   owner/name of the data repository, the files at its root (default sitesentrix/stitchbench-data)
//   STITCH_DATA_REF    the branch, tag or commit to take them from (default main)
//   STITCH_DATA_API    tests only: a stand-in for https://api.github.com on this machine
// With a token, every file has to arrive whole and read as a list, or none is replaced and this stops the build: an
// official build must never ship without the data by accident. Node 22+, no packages (it can run before npm ci).
//   node scripts/data/fetch-reference-data.mjs
import fs from "node:fs";
import path from "node:path";

// [file, whether each row needs an id]: prisma/seed.ts and desktop/reference.mjs load the first three into tables by id.
const FILES = [
  ["tension_specs.json", true],
  ["factory_settings.json", true],
  ["library_docs.json", true],
  ["hub_links.json", false],
];
const DIR = path.resolve(import.meta.dirname, "..", "..", "prisma", "seed-data");
const token = process.env.STITCH_DATA_TOKEN?.trim();
const repo = process.env.STITCH_DATA_REPO?.trim() || "sitesentrix/stitchbench-data";
const ref = process.env.STITCH_DATA_REF?.trim() || "main";
const api = (process.env.STITCH_DATA_API?.trim() || "https://api.github.com").replace(/\/+$/, "");

function stop(why) {
  console.error(`reference data: ${why}`);
  console.error("Nothing was replaced. The build stops here so it doesn't go out without the manufacturers' reference data.");
  process.exit(1);
}

if (!token) {
  // A secret that isn't set reaches a workflow step as an empty string: the same as unset.
  const missing = FILES.map(([f]) => f).filter((f) => !fs.existsSync(path.join(DIR, f)));
  console.log(
    missing.length
      ? `reference data: STITCH_DATA_TOKEN isn't set and prisma/seed-data has no ${missing.join(", ")}: this build goes without the manufacturers' reference data (it works without it, with no factory specs shown)`
      : "reference data: STITCH_DATA_TOKEN isn't set; this build uses the files already in prisma/seed-data",
  );
  process.exit(0);
}

if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) stop(`STITCH_DATA_REPO should be owner/name, like sitesentrix/stitchbench-data, not "${repo}".`);
let host;
try {
  const u = new URL(api);
  // The token goes with every request: never over plain http, except to a stand-in on this machine (tests).
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new Error();
  host = u.host;
} catch {
  stop("STITCH_DATA_API has to be an https address.");
}

/** One file's text, checked: the GitHub contents API, raw (it serves files up to 100 MB that way). */
async function download(file, needsId) {
  let res;
  try {
    res = await fetch(`${api}/repos/${repo}/contents/${encodeURIComponent(file)}?ref=${encodeURIComponent(ref)}`, {
      headers: { Accept: "application/vnd.github.raw", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "stitchbench-reference-data" },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new Error(`no answer from ${host} (${e?.cause?.code ?? e?.name ?? e})`);
  }
  if (!res.ok) {
    let said = "";
    try {
      said = JSON.parse(await res.text()).message ?? "";
    } catch {
      // not GitHub's JSON: the status says enough
    }
    // GitHub answers 404, not 403, when the token may not see a private repository.
    const hint =
      res.status === 401
        ? "the token was refused (wrong or expired)"
        : res.status === 404
          ? `check STITCH_DATA_REPO (${repo}) and STITCH_DATA_REF (${ref}), and that the token may read that repository's contents`
          : res.status === 403 || res.status === 429
            ? "the token may not read it, or GitHub's rate limit was reached"
            : "";
    throw new Error(`${host} answered ${res.status}${said ? ` (${said})` : ""}${hint ? `: ${hint}` : ""}`);
  }
  const text = await res.text();
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error(`arrived (${text.length} bytes) but isn't JSON: cut off, or not the data file`);
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error("arrived but isn't a list with rows in it");
  if (!rows.every((r) => r && typeof r === "object" && (!needsId || typeof r.id === "string"))) throw new Error(`arrived but has rows that aren't records${needsId ? " with an id" : ""}`);
  return { text, rows: rows.length };
}

// Every file in memory first: one that fails leaves all of them as they were.
const results = await Promise.allSettled(FILES.map(([file, needsId]) => download(file, needsId)));
const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${FILES[i][0]}: ${r.reason?.message ?? r.reason}`] : []));
if (failed.length) stop(`from ${repo} at ${ref}:\n  ${failed.join("\n  ")}`);

fs.mkdirSync(DIR, { recursive: true });
for (const [i, [file]] of FILES.entries()) {
  // Written beside the old one and renamed over it, so a file is never left half-written.
  const part = path.join(DIR, `.${file}.part`);
  fs.writeFileSync(part, results[i].value.text);
  fs.renameSync(part, path.join(DIR, file));
}
console.log(`reference data: ${FILES.map(([f], i) => `${f} (${results[i].value.rows} rows)`).join(", ")} from ${repo} at ${ref}`);
