// Writes THIRD_PARTY_NOTICES.txt for the Windows program: every package it ships (the server's node_modules and the
// wrapper's own production dependencies), with its version, license, where its source is, and the license and notice
// files it came with. Several licenses ask for exactly this: MIT and BSD keep their notice, Apache-2.0 its NOTICE file,
// and the LGPL libvips that sharp brings its license and a pointer to its source. Electron's and Chromium's own
// licenses are added by electron-builder (LICENSE.electron.txt, LICENSES.chromium.html).
// prepare-app.mjs runs it; on its own: node third-party-notices.mjs [server dir]
import fs from "node:fs";
import path from "node:path";

const SOURCE = "https://github.com/sitesentrix/stitchbench";
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|third.party.notices)([.-].*)?$/i;

/** name@version -> { meta, dir } for every package below a node_modules folder (prepare-app ships them as _node_modules). */
function walk(dir, found) {
  if (!fs.existsSync(dir)) return found;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.name.startsWith("@")) {
      walk(p, found); // a scope folder: its packages are one level down
      continue;
    }
    add(p, found);
    for (const nm of ["node_modules", "_node_modules"]) walk(path.join(p, nm), found);
  }
  return found;
}

function add(dir, found) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return; // not a package (a plain folder inside one)
  }
  if (meta.name && meta.version && !found.has(`${meta.name}@${meta.version}`)) found.set(`${meta.name}@${meta.version}`, { meta, dir });
}

/** The wrapper's production packages only: electron and electron-builder are build tools and never ship. */
function wrapperPackages(desktop, found) {
  const lock = JSON.parse(fs.readFileSync(path.join(desktop, "package-lock.json"), "utf8"));
  for (const [rel, info] of Object.entries(lock.packages ?? {})) {
    if (!rel || info.dev) continue;
    const dir = path.join(desktop, rel);
    if (fs.existsSync(dir)) add(dir, found);
  }
  return found;
}

function licenseOf(meta) {
  const l = meta.license ?? meta.licenses;
  if (typeof l === "string") return l;
  if (Array.isArray(l)) return l.map((x) => x.type ?? x).join(" OR ");
  if (l && typeof l === "object") return l.type ?? "see below";
  return "not stated (see below)";
}

function sourceOf(meta) {
  const r = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
  if (!r) return meta.homepage ?? `https://www.npmjs.com/package/${meta.name}/v/${meta.version}`;
  return r.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "").replace(/^github:/, "https://github.com/");
}

/** The library files a package of prebuilt binaries carries (embedded-postgres's PostgreSQL, sharp's libvips). */
function nativeLibraries(dir) {
  const names = [];
  const look = (d, depth) => {
    if (depth > 4 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) look(path.join(d, e.name), depth + 1);
      else if (/\.(dll|so(\.\d+)*|dylib)$/i.test(e.name)) names.push(e.name);
    }
  };
  look(dir, 0);
  // Other projects' libraries (libssl, libicu..., zlib1, libiconv...), not PostgreSQL's own (libpq, libecpg, libpgtypes)
  // or its extension modules (amcheck, citext...).
  return [...new Set(names)].filter((n) => /^(lib|icu|zlib)/i.test(n) && !/^lib(pq|ecpg|pgtypes|pg)/i.test(n)).sort();
}

export function writeNotices(serverDir, desktopDir, version) {
  const found = new Map();
  walk(fs.existsSync(path.join(serverDir, "_node_modules")) ? path.join(serverDir, "_node_modules") : path.join(serverDir, "node_modules"), found);
  wrapperPackages(desktopDir, found);
  const line = "-".repeat(78);
  const parts = [
    `Third-party software in StitchBench ${version}`,
    "",
    "StitchBench (and StitchShop, the same program) is free software under the GNU Affero General Public License,",
    `version 3. Its source code: ${SOURCE}`,
    "",
    "It includes the packages below. For each: its version, its license, where its source is, and the license and",
    "notice files it came with. Electron's and Chromium's licenses are in LICENSE.electron.txt and",
    "LICENSES.chromium.html in the program folder. The license texts referred to as LGPL, GPL and PostgreSQL License",
    "are at the end of this file.",
  ];
  for (const [key, { meta, dir }] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    const license = licenseOf(meta);
    parts.push("", line, `${key}: ${license}`, `Source: ${sourceOf(meta)}`);
    const files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f));
    // sharp's libvips packages carry no license file: their README is where the bundled libraries' licenses are listed.
    if (/LGPL/i.test(license)) files.push(...fs.readdirSync(dir).filter((f) => /^readme\.md$/i.test(f)));
    for (const f of files.sort()) {
      const file = path.join(dir, f);
      if (fs.statSync(file).isFile()) parts.push("", `${f}:`, "", fs.readFileSync(file, "utf8").trim());
    }
    if (meta.name.startsWith("@embedded-postgres/")) {
      parts.push(
        "",
        "This package holds PostgreSQL itself, under the PostgreSQL License (at the end of this file), with the libraries",
        "it is built with, each under its own license (for example OpenSSL, ICU, zlib, libxml2 and libxslt):",
        `${nativeLibraries(dir).join(", ") || "(none found)"}.`,
        "PostgreSQL's source: https://www.postgresql.org/ftp/source/",
      );
    }
  }
  parts.push("", line, "License texts referred to above", line);
  for (const f of ["PostgreSQL-COPYRIGHT.txt", "LGPL-3.0.txt", "GPL-3.0.txt"]) {
    parts.push("", `${f}:`, "", fs.readFileSync(path.join(desktopDir, "licenses", f), "utf8").trim());
  }
  const out = path.join(serverDir, "THIRD_PARTY_NOTICES.txt");
  fs.writeFileSync(out, parts.join("\n") + "\n");
  return { out, count: found.size };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("third-party-notices.mjs")) {
  const desktop = import.meta.dirname;
  const server = process.argv[2] ?? path.join(desktop, "server");
  const { version } = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
  const { out, count } = writeNotices(server, desktop, version);
  console.log(`third-party notices: ${count} packages in ${out}`);
}
