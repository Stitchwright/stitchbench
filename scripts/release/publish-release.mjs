// Publishes a program release to the hub: node scripts/release/publish-release.mjs --flavor stitchbench --version 1.7.1
//   --file "<the .exe>" [--url https://...] [--hub https://hub.stitchbench.app]
// Signs it with the private key in Documents (never printed), then either uploads the file to the hub's storage or,
// with --url, tells the hub where it already is. The notes come from src/lib/whats-new.ts.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { signRelease, hashFile, isNewer } from "../../desktop/update.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const docs = path.join(process.env.USERPROFILE ?? os.homedir(), "Documents");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] == null ? "true" : process.argv[++i];
}
function stop(msg) {
  console.error(msg);
  process.exit(1);
}

const flavor = args.flavor;
const version = args.version;
const file = args.file;
const hub = (args.hub ?? "https://hub.stitchbench.app").replace(/\/+$/, "");
const url = args.url && args.url !== "true" ? args.url : null;
if (!["stitchbench", "stitchshop"].includes(flavor)) stop("Use --flavor stitchbench or --flavor stitchshop.");
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) stop("Use --version x.y.z, for example --version 1.7.1.");
if (!file || !fs.existsSync(file)) stop('Use --file "<the installer .exe>"; that file was not found.');
if (url && !url.startsWith("https://")) stop("--url must be an https address.");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "desktop", "package.json"), "utf8"));
if (pkg.version !== version) console.warn(`Warning: desktop/package.json says ${pkg.version}, not ${version}. Is this the right installer?`);
if (!isNewer(version, "0.0.0")) stop("That version number isn't x.y.z.");

// The hub admin token: HUB_ADMIN_TOKEN, else Documents\StitchHub admin.txt (a "token: ..." line, or one bare line).
function adminToken() {
  if (process.env.HUB_ADMIN_TOKEN) return process.env.HUB_ADMIN_TOKEN.trim();
  const f = path.join(docs, "StitchHub admin.txt");
  if (!fs.existsSync(f)) stop(`No hub admin token: ${f} was not found.`);
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const labelled = lines.find((l) => /token/i.test(l) && /[:=]/.test(l));
  if (labelled) return labelled.split(/[:=]/).slice(1).join(":").trim();
  const bare = lines.filter((l) => !/\s/.test(l)).sort((a, b) => b.length - a.length)[0];
  if (!bare) stop("Could not find the hub admin token in StitchHub admin.txt.");
  return bare;
}

// The lines for this version and program, from src/lib/whats-new.ts (a plain array literal, so it is read as text).
function notesFor() {
  const f = path.join(root, "src", "lib", "whats-new.ts");
  if (!fs.existsSync(f)) {
    console.warn("Warning: src/lib/whats-new.ts not found; publishing without notes.");
    return [];
  }
  const text = fs.readFileSync(f, "utf8");
  const at = text.search(new RegExp(`version:\\s*["']${version.replace(/\./g, "\\.")}["']`));
  if (at < 0) {
    console.warn(`Warning: no entry for ${version} in whats-new.ts; publishing without notes.`);
    return [];
  }
  const rest = text.slice(at + 1);
  const next = rest.search(/version:\s*["']\d/);
  const block = next < 0 ? rest : rest.slice(0, next);
  const m = new RegExp(`\\b${flavor}\\s*:\\s*\\[([\\s\\S]*?)\\]\\s*,?\\s*(?:\\n|\\w+\\s*:|\\})`).exec(block);
  if (!m) return [];
  const out = [];
  for (const s of m[1].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    try {
      out.push(s[1] != null ? JSON.parse(`"${s[1]}"`) : (s[2] ?? s[3]).replace(/\\(.)/g, "$1"));
    } catch {
      out.push(s[1] ?? s[2] ?? s[3]);
    }
  }
  return out;
}

const keyFile = path.join(docs, "StitchBench release key.txt");
if (!fs.existsSync(keyFile)) stop(`No release key: ${keyFile} was not found. Run make-release-key.mjs first.`);
const privateKey = fs.readFileSync(keyFile, "utf8");

console.log("Reading the installer...");
const { sha256, size } = await hashFile(file);
console.log(`  ${(size / 1048576).toFixed(1)} MB`);
const signature = signRelease(privateKey, { flavor, version, sha256, size });
// Proves the key file matches what the programs will check against.
try {
  const { RELEASE_PUBLIC_KEY } = await import("../../desktop/release-key.mjs");
  const { verifyRelease } = await import("../../desktop/update.mjs");
  if (!RELEASE_PUBLIC_KEY) console.warn("Warning: desktop/release-key.mjs has no public key yet, so no program will accept this.");
  else if (!verifyRelease(RELEASE_PUBLIC_KEY, { flavor, version, sha256, size }, signature)) stop("The private key doesn't match desktop/release-key.mjs. Nothing was published.");
} catch (e) {
  if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e;
}
const notes = notesFor();
console.log(`Notes: ${notes.length} line(s).`);

const token = adminToken();
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
async function call(method, route, body, extra = {}) {
  const res = await fetch(hub + route, { method, headers: extra.headers ?? headers, body });
  const text = await res.text();
  if (!res.ok) stop(`The hub said ${res.status} for ${route}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

let key = null;
if (!url) {
  console.log("Asking the hub where to put the file...");
  const up = await call("POST", "/v1/admin/releases/upload-url", JSON.stringify({ flavor, version, size }));
  if (!up.putUrl || !up.key) stop("The hub didn't give an upload address.");
  key = up.key;
  console.log("Uploading (this can take a few minutes)...");
  // node:https rather than fetch: the presigned PUT signs Content-Length, and fetch would send a stream chunked.
  const putHeaders = { "Content-Type": "application/octet-stream", ...(up.putHeaders ?? {}), "Content-Length": String(size) };
  const put = await new Promise((resolve, reject) => {
    const u = new URL(up.putUrl);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method: "PUT", headers: putHeaders }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on("error", reject);
    fs.createReadStream(file).on("error", reject).pipe(req);
  });
  if (!put.ok) stop(`The upload failed (${put.status}).`);
}
console.log("Telling the hub about the release...");
await call("POST", "/v1/admin/releases", JSON.stringify({ flavor, version, sha256, size, signature, notes, ...(url ? { url } : { key }) }));
console.log(`Done: ${flavor} ${version} is published. Programs will offer it within 6 hours.`);
