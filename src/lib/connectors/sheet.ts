// A catalog spreadsheet as rows of text (package F6): a CSV or tab-separated file, or an Excel .xlsx workbook (its first
// sheet). The .xlsx reader is small and has no dependency: a workbook is a zip of XML files, read with node:zlib.
// Limits keep a hostile file from using the server up (rows, columns, unpacked size). Pure: no database.
import { inflateRawSync } from "node:zlib";
import { UserError } from "@/lib/user-error";
import { parseTable } from "@/lib/parse-table";

export const MAX_SHEET_BYTES = 8 * 1024 * 1024;
export const MAX_SHEET_ROWS = 20_000;
const MAX_COLS = 100;
const MAX_UNPACKED = 40 * 1024 * 1024;

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&amp;/g, "&");

type ZipEntry = { name: string; method: number; compSize: number; size: number; offset: number };

/** The files of a zip, by name, unpacked on demand (stored or deflated entries). */
function openZip(buf: Buffer) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UserError("That file isn't a readable Excel workbook. Save it as CSV or .xlsx and try again.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new UserError("That Excel workbook is damaged. Save it as CSV or .xlsx again.");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name: string) => entries.has(name),
    names: () => [...entries.keys()],
    text(name: string): string | null {
      const e = entries.get(name);
      if (!e) return null;
      if (e.size > MAX_UNPACKED) throw new UserError("That workbook unpacks to more than a spreadsheet should. Save it as CSV and try again.");
      if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new UserError("That Excel workbook is damaged. Save it as CSV or .xlsx again.");
      const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      const raw = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return raw.toString("utf8");
      if (e.method !== 8) throw new UserError("That Excel workbook uses a compression this program can't read. Save it as CSV and try again.");
      try {
        return inflateRawSync(raw, { maxOutputLength: MAX_UNPACKED }).toString("utf8");
      } catch {
        throw new UserError("That Excel workbook is damaged or too large. Save it as CSV and try again.");
      }
    },
  };
}

/** Column letters to a zero-based index: A = 0, Z = 25, AA = 26. */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[^A-Za-z]/g, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;

/** The first sheet of an .xlsx workbook as rows of text (blank rows dropped, numbers as plain text). */
export function readXlsx(buf: Buffer): string[][] {
  const zip = openZip(buf);
  if (!zip.has("xl/workbook.xml")) throw new UserError("That file isn't an Excel workbook (.xlsx). Save it as CSV or .xlsx and try again.");
  // Which part is the first sheet: workbook.xml names it by a relationship id; the relationships file says where it is.
  let target = "xl/worksheets/sheet1.xml";
  const wb = zip.text("xl/workbook.xml") ?? "";
  const first = /<sheet\b[^>]*>/.exec(wb)?.[0];
  const rid = first ? attr(first, "r:id") : null;
  const rels = zip.text("xl/_rels/workbook.xml.rels");
  if (rid && rels) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attr(m[0], "Id") === rid) {
        const t = attr(m[0], "Target");
        if (t) target = t.startsWith("/") ? t.slice(1) : `xl/${t}`;
      }
    }
  }
  const sheet = zip.text(target) ?? zip.text("xl/worksheets/sheet1.xml");
  if (sheet == null) throw new UserError("That workbook has no sheet to read.");
  const shared: string[] = [];
  const sst = zip.text("xl/sharedStrings.xml");
  if (sst) {
    for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const body = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
      shared.push(decodeXml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
    }
  }
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= MAX_SHEET_ROWS + 20) throw new UserError(`That sheet has more than ${MAX_SHEET_ROWS.toLocaleString("en-US")} rows. Split it and import in parts.`);
    const cells: string[] = [];
    let next = 0;
    for (const cm of (rm[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], "r");
      const at = ref ? colIndex(ref) : next;
      if (at < 0 || at >= MAX_COLS) continue;
      next = at + 1;
      const type = attr(cm[1], "t");
      const body = cm[2] ?? "";
      let v = "";
      if (type === "inlineStr") v = decodeXml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
      else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        if (type === "s") v = shared[Number(raw)] ?? "";
        else if (type === "str" || type === "e") v = decodeXml(raw);
        else if (type === "b") v = raw === "1" ? "TRUE" : "FALSE";
        else {
          const n = Number(raw);
          v = raw !== "" && Number.isFinite(n) ? String(n) : decodeXml(raw);
        }
      }
      while (cells.length < at) cells.push("");
      cells[at] = v.trim();
    }
    if (cells.some((c) => c)) rows.push(cells);
  }
  return rows;
}

/** A chosen file as rows of text. CSV and tab-separated (UTF-8, or Windows-1252 as Excel's plain CSV is) and .xlsx. */
export function readTable(name: string, bytes: Uint8Array): string[][] {
  if (bytes.length === 0) throw new UserError("That file is empty.");
  if (bytes.length > MAX_SHEET_BYTES) throw new UserError(`That file is larger than ${MAX_SHEET_BYTES / 1024 / 1024} MB. Split it and import in parts.`);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  let rows: string[][];
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
    rows = readXlsx(buf);
  } else if (/\.xlsx?$/i.test(name) && buf.length > 4 && buf.readUInt32BE(0) === 0xd0cf11e0) {
    throw new UserError("That is an old Excel file (.xls). Open it in Excel and Save As .xlsx or CSV.");
  } else {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder("windows-1252").decode(buf);
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.includes("\u0000")) throw new UserError("That doesn't look like a CSV or Excel file. Save the sheet as CSV or .xlsx and try again.");
    rows = parseTable(text);
  }
  if (rows.length > MAX_SHEET_ROWS + 20) throw new UserError(`That sheet has more than ${MAX_SHEET_ROWS.toLocaleString("en-US")} rows. Split it and import in parts.`);
  return rows;
}
