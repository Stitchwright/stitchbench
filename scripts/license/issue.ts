// Issues StitchBench license keys and keeps the sales log (modules-design.md section 4, "issue"). Files only, under
// ~/.stitchbench; no database.
//   npm run license                                  asks step by step (needs a terminal)
//   npm run license -- --shop <Company ID> --name "Sew & Vac of Springfield" --modules vac,appliance --plan yearly \
//       --from 2026-10-01 [--until 2027-09-30] [--grace 14] [--email owner@shop.com] [--note "Invoice 1042"] [--key <pem>] [--log <csv>]
//   npm run license -- --trial --shop <Company ID> --modules vac      14 days from today, grace 0
//   npm run license -- --renew <keyId or Company ID>                  the next period of that customer's latest key (same name, modules, plan, anchor day)
//   npm run license -- --renew-due 7                                  --renew for every key ending within 7 days that has no later key
//   npm run license -- --resend <keyId>                               prints that key and its email again, from the log
//   npm run license -- --due 30                                       keys ending within 30 days with no later key, each with its --renew command
//   npm run license -- --check <key>                                  decodes a key and verifies it against src/lib/license-keys.ts
//   npm run license -- --retire-list k1                               the `retired` entry for k1 (lastDay and allow) from the log
// Signing key: --key, else the newest ~/.stitchbench/license-<kid>.pem whose kid is in license-keys.ts and not retired. Its
// passphrase comes from STITCH_LICENSE_PASSPHRASE or is asked for. Log: --log, $STITCH_LICENSE_LOG or ~/.stitchbench/licenses.csv.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {
  addDaysYmd,
  encodeLicense,
  extractKey,
  newKeyId,
  payloadHash,
  planLastDay,
  validYmd,
  verifyLicense,
  type LicensePayload,
  type PublicKeys,
} from "../../src/lib/license";
import { LICENSE_PUBLIC_KEYS } from "../../src/lib/license-keys";
import { fmtYmd, isModuleId, MODULE_IDS, MODULES, planLabel } from "../../src/lib/module-info";
import { appendLog, expandHome, fail, localYmd, logPath, parseArgs, readLog, readPassphrase, stitchDir, str, todayYmd, type LogRow } from "./cli";

const KNOWN = ["shop", "name", "modules", "plan", "from", "until", "grace", "email", "note", "key", "log", "trial", "renew", "renew-due", "resend", "due", "check", "retire-list", "help"];

function usage() {
  console.log(
    [
      "usage: npm run license                                           ask step by step",
      "       npm run license -- --shop <Company ID> --name <name> --modules vac,appliance --plan monthly|yearly|trial",
      '           [--from YYYY-MM-DD] [--until YYYY-MM-DD] [--grace 14] [--email <email>] [--note "Invoice 1042"] [--key <pem>] [--log <csv>]',
      "       npm run license -- --trial --shop <Company ID> --modules vac   14 days from today, grace 0",
      "       npm run license -- --renew <keyId or Company ID>               the next period of that customer's latest key",
      "       npm run license -- --renew-due 7                               --renew for every key ending within 7 days with no later key",
      "       npm run license -- --resend <keyId>                            print that key and its email again",
      "       npm run license -- --due 30                                    keys ending within 30 days with no later key",
      "       npm run license -- --check <key>                               decode and verify a key",
      "       npm run license -- --retire-list k1                            the retired entry for k1, from the log",
    ].join("\n"),
  );
}

// ---------- the key being made ----------

/** validYmd for typed input: a month 13 or day 32 makes Date throw inside it, and a typo deserves a message, not a stack. */
function okYmd(s: unknown): s is string {
  try {
    return validYmd(s);
  } catch {
    return false;
  }
}

type Spec ={ shopId: string; name: string; modules: string[]; plan: string; from: string; until: string; grace: number; anchor: number; email: string; note: string };

function planCode(word: string): string {
  const w = word.trim().toLowerCase();
  if (w === "m" || w === "monthly") return "m";
  if (w === "y" || w === "yearly") return "y";
  if (w === "t" || w === "trial") return "t";
  return fail(`Plan "${word}" isn't one of monthly, yearly or trial.`, 2);
}

function parseModules(s: string): string[] {
  const ids = [...new Set(s.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (!ids.length) fail("Say which modules: --modules vac,appliance", 2);
  for (const id of ids) if (!isModuleId(id)) fail(`Unknown module "${id}". This version knows: ${MODULE_IDS.join(", ")}.`, 2);
  return ids;
}

function parseGrace(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 90) fail("--grace is a whole number of days from 0 to 90.", 2);
  return n;
}

function checkSpec(s: Spec): Spec {
  if (!s.shopId || s.shopId.length > 64 || /\s/.test(s.shopId)) fail("The Company ID is one word of up to 64 characters (Settings -> Add-ons shows it).", 2);
  if (!okYmd(s.from)) fail(`Start date "${s.from}" isn't a real date (YYYY-MM-DD).`, 2);
  if (!okYmd(s.until)) fail(`Last day "${s.until}" isn't a real date (YYYY-MM-DD).`, 2);
  if (s.until < s.from) fail(`The last day (${s.until}) is before the start (${s.from}).`, 2);
  if (!/^[a-z]{1,8}$/.test(s.plan)) fail(`Plan "${s.plan}" isn't valid.`, 2);
  if (!s.modules.length) fail("At least one module is needed.", 2);
  return s;
}

/** The name the log last used for a company, so renewals and trials don't need --name. */
function lastName(rows: LogRow[], shopId: string): string | undefined {
  return [...rows].reverse().find((r) => r.companyId === shopId && r.name)?.name;
}

function specFromFlags(flags: Record<string, string | true>, rows: LogRow[]): Spec {
  const shopId = str(flags.shop) ?? fail("--shop <Company ID> is needed (or run with no options to be asked).", 2);
  const trial = flags.trial === true;
  const plan = trial ? "t" : planCode(str(flags.plan) ?? fail("--plan monthly|yearly|trial is needed (or --trial).", 2));
  const modules = parseModules(str(flags.modules) ?? fail("--modules vac,appliance is needed.", 2));
  const from = str(flags.from) ?? todayYmd();
  if (!okYmd(from)) fail(`Start date "${from}" isn't a real date (YYYY-MM-DD).`, 2);
  const anchor = Number(from.slice(8));
  return checkSpec({
    shopId,
    name: str(flags.name) ?? lastName(rows, shopId) ?? shopId,
    modules,
    plan,
    from,
    until: str(flags.until) ?? planLastDay(from, plan as "m" | "y" | "t", anchor),
    grace: parseGrace(str(flags.grace), plan === "t" ? 0 : 14),
    anchor,
    email: str(flags.email) ?? "",
    note: str(flags.note) ?? "",
  });
}

/** The latest key in the log for a key id or a Company ID (by last day, then issue time). */
function latestRow(rows: LogRow[], ref: string): LogRow | undefined {
  const mine = rows.filter((r) => r.keyId === ref || r.companyId === ref);
  return mine.sort((a, b) => (a.until !== b.until ? (a.until < b.until ? 1 : -1) : a.issued < b.issued ? 1 : -1))[0];
}

/** The next period of a logged key: from its last day + 1, with the same anchor day so renewals don't drift. */
function renewSpec(row: LogRow, flags: Record<string, string | true>): Spec {
  const plan = str(flags.plan) ? planCode(str(flags.plan)!) : row.plan;
  if (plan === "t") fail(`${row.keyId} was a trial. Say --plan monthly or --plan yearly for the paid key.`, 2);
  const from = str(flags.from) ?? addDaysYmd(row.until, 1);
  if (!okYmd(from)) fail(`Start date "${from}" isn't a real date (YYYY-MM-DD).`, 2);
  const anchor = Number(row.anchor) || Number(row.from.slice(8)) || Number(from.slice(8));
  return checkSpec({
    shopId: row.companyId,
    name: str(flags.name) ?? row.name,
    modules: str(flags.modules) ? parseModules(str(flags.modules)!) : parseModules(row.modules),
    plan,
    from,
    until: str(flags.until) ?? planLastDay(from, plan as "m" | "y", anchor),
    grace: parseGrace(str(flags.grace), Number.isInteger(Number(row.grace)) && row.grace !== "" ? Number(row.grace) : 14),
    anchor,
    email: str(flags.email) ?? row.email,
    note: str(flags.note) ?? "",
  });
}

// ---------- the signing key ----------

type Signer = { kid: string; key: crypto.KeyObject; file: string; compiled: boolean };

const kidOfFile = (file: string) => /^license-([a-z0-9]+)\.pem$/i.exec(path.basename(file))?.[1]?.toLowerCase();

/** The newest license-<kid>.pem in ~/.stitchbench, preferring kids that are compiled in and not retired. */
function defaultKeyFile(): string {
  const dir = stitchDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => kidOfFile(f)) : [];
  const info = files
    .map((f) => {
      const kid = kidOfFile(f)!;
      const pub = Object.hasOwn(LICENSE_PUBLIC_KEYS, kid) ? LICENSE_PUBLIC_KEYS[kid] : undefined;
      return { file: path.join(dir, f), kid, mtime: +fs.statSync(path.join(dir, f)).mtime, retired: !!pub?.retired, usable: !!pub && pub.scope === "any" && !pub.retired };
    })
    .filter((i) => !i.retired)
    .sort((a, b) => Number(b.usable) - Number(a.usable) || b.mtime - a.mtime);
  if (!info.length) fail(`No signing key in ${dir} (license-<kid>.pem). Run npm run license:keygen -- --kid k1, or pass --key <pem>.`);
  return info[0].file;
}

async function loadSigner(keyFlag: string | undefined): Promise<Signer> {
  const file = keyFlag ? path.resolve(expandHome(keyFlag)) : defaultKeyFile();
  const kid = kidOfFile(file) ?? fail(`Name the key file license-<kid>.pem (got ${path.basename(file)}), so the kid is known.`, 2);
  const pub = Object.hasOwn(LICENSE_PUBLIC_KEYS, kid) ? LICENSE_PUBLIC_KEYS[kid] : undefined;
  if (pub?.retired) fail(`${kid} is retired. Use your newer key.`);
  if (pub && pub.scope !== "any") fail(`${kid} is a ${pub.scope} key. Keys to paste are signed with the owner's key (scope "any").`);
  let pem: string;
  try {
    pem = fs.readFileSync(file, "utf8");
  } catch {
    return fail(`${file} not found. Run npm run license:keygen -- --kid k1, or pass --key <pem>.`);
  }
  let key: crypto.KeyObject;
  if (/ENCRYPTED/.test(pem)) {
    const passphrase = await readPassphrase(`Passphrase for ${file}: `);
    try {
      key = crypto.createPrivateKey({ key: pem, format: "pem", passphrase });
    } catch {
      return fail(`Wrong passphrase for ${file}`);
    }
  } else {
    try {
      key = crypto.createPrivateKey({ key: pem, format: "pem" });
    } catch {
      return fail(`${file} isn't a private key file.`);
    }
  }
  const x = (crypto.createPublicKey(key).export({ format: "jwk" }) as { x?: string }).x;
  if (pub && pub.x !== x) fail(`The public key for ${kid} in src/lib/license-keys.ts isn't this file's (${file}). Check which key you are signing with.`);
  if (!pub) console.error(`Warning: No released StitchBench knows kid ${kid} yet: add its line to src/lib/license-keys.ts and release first.`);
  return { kid, key, file, compiled: !!pub };
}

// ---------- issuing ----------

/** "Vac Shop", "Vac Shop and Small Appliance Repair", "A, B and C". */
function moduleNames(ids: string[]): string {
  const names = ids.map((id) => (isModuleId(id) ? MODULES[id].label : id));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function emailText(row: LogRow): string {
  const what = moduleNames(row.modules.split(",").filter(Boolean));
  return [
    `Subject: Your StitchBench key: ${what}`,
    "",
    `Here is your StitchBench key for ${what}, good through ${fmtYmd(row.until)}. It is for ${row.name} (Company ID ${row.companyId}).`,
    "",
    "In StitchBench, go to Settings → Add-ons, paste the key (or this whole email) in the box and press Add key. It works without the internet.",
    "",
    row.key,
    "",
  ].join("\n");
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function emailFile(row: LogRow): string {
  const dir = path.join(stitchDir(), "keys");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${localYmd(row.issued)}-${row.keyId}-${slug(row.name) || slug(row.companyId) || "key"}.txt`);
  fs.writeFileSync(file, emailText(row), "utf8");
  return file;
}

function describe(s: Spec): string {
  const graceNote = s.grace ? `, ${s.grace} days grace` : ", no grace";
  return `${moduleNames(s.modules)}, ${planLabel(s.plan)}, ${s.from} to ${s.until}${graceNote}, for ${s.name} (Company ID ${s.shopId})`;
}

function issueKey(s: Spec, signer: Signer, log: string) {
  const payload: LicensePayload = { v: 1, k: signer.kid, id: newKeyId(), s: s.shopId, n: s.name, m: s.modules, p: s.plan, f: s.from, u: s.until, g: s.grace, t: new Date().toISOString() };
  const key = encodeLicense(payload, signer.key);
  // The key must verify with its own public half, and (once the kid is released) with the compiled table.
  const own: PublicKeys = { [signer.kid]: { x: (crypto.createPublicKey(signer.key).export({ format: "jwk" }) as { x: string }).x, scope: "any" } };
  const self = verifyLicense(key, own);
  if (!self.ok) fail(`The new key doesn't verify with its own public key: ${self.reason}`);
  if (signer.compiled) {
    const v = verifyLicense(key, LICENSE_PUBLIC_KEYS);
    if (!v.ok) fail(`The new key doesn't verify against src/lib/license-keys.ts: ${v.reason}`);
  }
  const row: LogRow = {
    issued: payload.t,
    keyId: payload.id,
    companyId: s.shopId,
    name: s.name,
    email: s.email,
    modules: s.modules.join(","),
    plan: s.plan,
    from: s.from,
    until: s.until,
    grace: String(s.grace),
    anchor: String(s.anchor),
    note: s.note,
    key,
  };
  appendLog(log, row);
  const file = emailFile(row);
  console.log(`Key ${row.keyId}: ${describe(s)}.`);
  console.log("");
  console.log(key);
  console.log("");
  console.log(`Email to send: ${file}`);
  console.log(`Logged in ${log}`);
  return row;
}

// ---------- the log's other uses ----------

const planWord = (p: string) => planLabel(p) || p;

/** A later key for the same company that covers one of this key's modules. */
function hasLater(rows: LogRow[], r: LogRow): boolean {
  const mods = r.modules.split(",");
  return rows.some((o) => o !== r && o.companyId === r.companyId && o.until > r.until && o.modules.split(",").some((m) => mods.includes(m)));
}

/** Keys whose last day is within `days` (or already past, while their grace runs) and that have no later key. */
function dueRows(rows: LogRow[], days: number): LogRow[] {
  const today = todayYmd();
  const limit = addDaysYmd(today, days);
  return rows.filter((r) => okYmd(r.until) && r.until <= limit && addDaysYmd(r.until, Number(r.grace) || 0) >= today && !hasLater(rows, r)).sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0));
}

function daysWord(until: string): string {
  const n = Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${todayYmd()}T00:00:00Z`)) / 86_400_000);
  if (n === 0) return "today";
  return n > 0 ? `in ${n} day${n === 1 ? "" : "s"}` : `${-n} day${n === -1 ? "" : "s"} ago, in grace`;
}

function listDue(rows: LogRow[], days: number) {
  const due = dueRows(rows, days);
  if (!due.length) return console.log(`No keys end within ${days} days without a later key.`);
  for (const r of due) {
    console.log(`${r.keyId}  ${r.name} (${r.companyId})  ${moduleNames(r.modules.split(","))}, ${planWord(r.plan)}, ends ${r.until} (${daysWord(r.until)})${r.email ? `  ${r.email}` : ""}    npm run license -- --renew ${r.keyId}`);
  }
}

function resend(rows: LogRow[], keyId: string) {
  const row = rows.find((r) => r.keyId === keyId) ?? fail(`No key ${keyId} in the log.`);
  console.log(emailText(row));
}

function decodePayload(key: string): { part: string; payload: Partial<LicensePayload> } | null {
  const part = key.split(".")[1];
  if (!part) return null;
  try {
    const p = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return p && typeof p === "object" ? { part, payload: p as Partial<LicensePayload> } : null;
  } catch {
    return null;
  }
}

/** The `retired` entry for a kid: the latest last day it signed, and every genuine key's payload hash (the leak case). */
function retireList(rows: LogRow[], kid: string) {
  const mine = rows.map((r) => ({ r, d: decodePayload(r.key) })).filter((x) => x.d?.payload.k === kid);
  const pub = Object.hasOwn(LICENSE_PUBLIC_KEYS, kid) ? LICENSE_PUBLIC_KEYS[kid] : undefined;
  const x = pub?.x ?? "<the x from this kid's line in license-keys.ts>";
  const scope = pub?.scope ?? "any";
  if (!mine.length) console.error(`No keys signed with ${kid} in the log: the entry below retires it as of today, allowing nothing.`);
  const lastDay = mine.reduce((m, { r }) => (r.until > m ? r.until : m), mine.length ? "0000-00-00" : todayYmd());
  const allow = mine.map(({ d }) => payloadHash(d!.part));
  console.log(`Replace the ${kid} line in src/lib/license-keys.ts with (${mine.length} key${mine.length === 1 ? "" : "s"} in the log):`);
  console.log("");
  console.log(`  ${kid}: { x: "${x}", scope: "${scope}", retired: { lastDay: "${lastDay}", allow: [${allow.map((h) => `"${h}"`).join(", ")}] } },`);
}

function check(text: string) {
  const key = extractKey(text) ?? fail("That doesn't look like a StitchBench license key: it starts with SB1. and has two dots.");
  const d = decodePayload(key) ?? fail("The key's payload isn't readable: it is damaged.");
  const p = d.payload;
  const v = verifyLicense(key, LICENSE_PUBLIC_KEYS);
  const line = (k: string, val: unknown) => console.log(`${k.padEnd(14)} ${val ?? ""}`);
  line("Key ID", p.id);
  line("Company ID", p.s);
  line("Issued to", p.n);
  line("Modules", Array.isArray(p.m) ? moduleNames(p.m) : p.m);
  line("Plan", typeof p.p === "string" ? planWord(p.p) : p.p);
  line("First day", p.f);
  line("Last day", typeof p.u === "string" ? `${p.u} (${okYmd(p.u) ? fmtYmd(p.u) : "not a date"})` : p.u);
  line("Grace days", p.g);
  if (okYmd(p.u) && Number.isInteger(p.g)) line("Grace ends", addDaysYmd(p.u, p.g as number));
  line("Issued at", p.t);
  line("Signing key", p.k);
  line("Payload hash", payloadHash(d.part));
  line("Format", p.v);
  if (v.ok) {
    line("Verified", `yes (scope ${v.scope})`);
    return;
  }
  if (p.v === 1 && typeof p.k === "string" && !Object.hasOwn(LICENSE_PUBLIC_KEYS, p.k)) {
    line("Verified", `not by this version. No released StitchBench knows kid ${p.k} yet: add its line to src/lib/license-keys.ts and release first.`);
    return;
  }
  line("Verified", `NO: ${v.reason}`);
  process.exit(1);
}

// ---------- interactive ----------

async function interactive(log: string) {
  const rows = readLog(log);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const first = (await rl.question("Company ID, or paste the shop's email (end with an empty line): ")).trim();
    let shopId = first;
    let name = "";
    if (/\s/.test(first) || /company id/i.test(first)) {
      let text = first;
      for (;;) {
        const l = await rl.question("");
        if (!l.trim()) break;
        text += "\n" + l;
      }
      shopId = /Company ID:\s*(\S+)/i.exec(text)?.[1] ?? fail("No \"Company ID: …\" line in that email. Ask the shop for the ID shown in Settings → Add-ons.");
      name = /^\s*Company:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "";
    }
    if (!shopId) fail("A Company ID is needed.", 2);
    const defName = name || lastName(rows, shopId) || "";
    name = (await rl.question(`Name on the key${defName ? ` [${defName}]` : ""}: `)).trim() || defName;
    if (!name) fail("A name is needed: it is shown on the shop's Modules page.", 2);
    console.log("Modules:");
    MODULE_IDS.forEach((id, i) => console.log(`  ${i + 1}. ${MODULES[id].label}`));
    const picks = (await rl.question("Which (e.g. 1,2): ")).split(/[,\s]+/).filter(Boolean);
    const modules = [...new Set(picks.map((n) => MODULE_IDS[Number(n) - 1] ?? fail(`"${n}" isn't one of the numbers above.`, 2)))];
    if (!modules.length) fail("Pick at least one module.", 2);
    const plan = planCode((await rl.question("Monthly, yearly or trial [monthly]: ")).trim() || "monthly");
    const today = todayYmd();
    const from = (await rl.question(`Start date [${today}]: `)).trim() || today;
    if (!okYmd(from)) fail(`Start date "${from}" isn't a real date (YYYY-MM-DD).`, 2);
    const email = (await rl.question("Customer's email (for your log, optional): ")).trim();
    const note = (await rl.question("Note (invoice #, optional): ")).trim();
    const anchor = Number(from.slice(8));
    const spec = checkSpec({ shopId, name, modules, plan, from, until: planLastDay(from, plan as "m" | "y" | "t", anchor), grace: plan === "t" ? 0 : 14, anchor, email, note });
    console.log("");
    console.log(describe(spec) + ".");
    const yn = (await rl.question("Make this key? (y/n) ")).trim();
    rl.close();
    if (!/^y/i.test(yn)) return console.log("Nothing made.");
    const signer = await loadSigner(undefined);
    issueKey(spec, signer, log);
  } finally {
    rl.close();
  }
}

// ---------- main ----------

async function main() {
  const argv = process.argv.slice(2);
  const { flags, rest } = parseArgs(argv, KNOWN, ["trial", "help"]);
  if (flags.help) return usage();
  if (rest.length) fail(`Unexpected argument "${rest[0]}". Run with --help for the options.`, 2);
  const log = logPath(str(flags.log));
  if (!argv.length) {
    if (!process.stdin.isTTY) {
      usage();
      process.exit(2);
    }
    return interactive(log);
  }
  const rows = readLog(log);
  if (flags.check !== undefined) return check(str(flags.check) ?? fail("--check needs the key (or the whole email, quoted).", 2));
  if (flags["retire-list"] !== undefined) return retireList(rows, str(flags["retire-list"]) ?? fail("--retire-list needs a kid, e.g. k1.", 2));
  if (flags.resend !== undefined) return resend(rows, str(flags.resend) ?? fail("--resend needs a key id.", 2));
  if (flags.due !== undefined) return listDue(rows, parseDays(flags.due, "--due"));
  if (flags["renew-due"] !== undefined) {
    const due = dueRows(rows, parseDays(flags["renew-due"], "--renew-due"));
    if (!due.length) return console.log("Nothing to renew.");
    const signer = await loadSigner(str(flags.key));
    for (const row of due) {
      issueKey(renewSpec(row, flags), signer, log);
      console.log("");
    }
    return;
  }
  if (flags.renew !== undefined) {
    const ref = str(flags.renew) ?? fail("--renew needs a key id or a Company ID.", 2);
    const row = latestRow(rows, ref) ?? fail(`No key ${ref} in the log (${log}).`);
    const spec = renewSpec(row, flags);
    const signer = await loadSigner(str(flags.key));
    issueKey(spec, signer, log);
    return;
  }
  const spec = specFromFlags(flags, rows);
  const signer = await loadSigner(str(flags.key));
  issueKey(spec, signer, log);
}

function parseDays(v: string | true, flag: string): number {
  const n = Number(str(v));
  if (!Number.isInteger(n) || n < 0) fail(`${flag} needs a number of days, e.g. ${flag} 30.`, 2);
  return n;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
