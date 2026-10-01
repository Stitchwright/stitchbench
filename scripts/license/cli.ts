// Shared helpers for the license CLI (keygen.ts, issue.ts, resign-grants.ts): paths under ~/.stitchbench, the passphrase
// prompt, the sales log and a small argv parser. modules-design.md section 4. Nothing here touches the database.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/** `~` and `~/x` mean the home folder: cmd.exe and PowerShell don't expand it themselves. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Where the owner's keys, the sales log and the email files live. */
export const stitchDir = () => path.join(os.homedir(), ".stitchbench");

/** The repo this script runs from: git's answer, else the working directory. */
export function repoRoot(): string {
  try {
    return path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return process.cwd();
  }
}

export function insideDir(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

/** Today's date on this PC's clock, as YYYY-MM-DD (the owner issues keys from his own calendar). */
export function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The local date of an instant, for file names. */
export function localYmd(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return todayYmd();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- argv ----------

export type Args = { flags: Record<string, string | true>; rest: string[] };

/**
 * `--name value`, `--name=value`, and bare `--name` (for names in `booleans`, or when nothing follows). An option that
 * isn't in `known` is a typo: say so and stop, rather than issue a key with a default the owner didn't mean.
 */
export function parseArgs(argv: string[], known: string[], booleans: string[] = []): Args {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!known.includes(name)) fail(`Unknown option --${name}. Run with --help for the list.`, 2);
    if (eq !== -1) {
      flags[name] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (booleans.includes(name) || next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { flags, rest };
}

/** The string value of a flag, or undefined for a bare flag or a missing one. */
export const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

// ---------- passphrase ----------

function readOneLine(): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    let done = false;
    rl.once("line", (line) => {
      done = true;
      rl.close();
      resolve(line);
    });
    rl.once("close", () => {
      if (!done) resolve(null);
    });
  });
}

/**
 * The signing key's passphrase: STITCH_LICENSE_PASSPHRASE when set, else typed at the terminal with nothing echoed
 * (raw mode, until Enter). Without a terminal (a pipe), one line of stdin.
 */
export async function readPassphrase(prompt: string): Promise<string> {
  const env = process.env.STITCH_LICENSE_PASSPHRASE;
  if (env) return env;
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const line = await readOneLine();
    if (line == null) fail("No passphrase: set STITCH_LICENSE_PASSPHRASE, or run this in a terminal.");
    return line;
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let buf = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer | string) => {
      for (const c of chunk.toString("utf8")) {
        if (c === "\r" || c === "\n") {
          cleanup();
          resolve(buf);
          return;
        }
        if (c === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// ---------- sales log ----------

export const LOG_COLUMNS = ["issued", "keyId", "companyId", "name", "email", "modules", "plan", "from", "until", "grace", "anchor", "note", "key"] as const;
export type LogRow = Record<(typeof LOG_COLUMNS)[number], string>;

/** --log, else $STITCH_LICENSE_LOG, else ~/.stitchbench/licenses.csv. */
export function logPath(flag?: string): string {
  return path.resolve(expandHome(flag || process.env.STITCH_LICENSE_LOG || path.join(stitchDir(), "licenses.csv")));
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const csvLine = (values: readonly string[]) => values.map(csvField).join(",") + "\n";

/** RFC 4180: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Every row of the log, by column name (an older or hand-edited header still maps by name). */
export function readLog(file: string): LogRow[] {
  if (!fs.existsSync(file)) return [];
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c !== ""))
    .map((r) => {
      const o = {} as LogRow;
      for (const c of LOG_COLUMNS) {
        const i = header.indexOf(c);
        o[c] = i === -1 ? "" : (r[i] ?? "");
      }
      return o;
    });
}

/** Appends one row (and the header when the file is new). */
export function appendLog(file: string, row: LogRow) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !fs.existsSync(file) || fs.statSync(file).size === 0;
  fs.appendFileSync(file, (fresh ? csvLine(LOG_COLUMNS) : "") + csvLine(LOG_COLUMNS.map((c) => row[c])));
}
