// The parts helpers (ai-assistant-scope.md 1.5 and 1.6 a), the pure half: the requests the hub receives, how the answers
// are read, and the words a search is made from. No "server-only" and no database: scripts/checks/assistant-parts.check.ts
// holds the shapes and the parsing. Nothing built here carries a customer: a part is a number, a name and the models it
// fits, and an inventory file is its column headings and three sample rows.
import { jsonOf, type Built, type Source } from "./prompts";
import { redact, type Redaction } from "./redact";

const clip = (s: string | null | undefined, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// ----- the part-number words a search is made from -----

/** Words that stand for "a part number follows" ("Type 15J", "No. 7", "P/N 4421"): dropped from the front when numbers are compared. */
const NUMBER_PREFIX = /^(?:TYPE|NO|NUM|NUMBER|PART|PARTNO|PN|ITEM|STYLE|MODEL|SKU)(?=[A-Z0-9]*[0-9])/;

/** The keys a typed number may be filed under: its letters and digits, and the same without a "Type"/"No" prefix (never fewer than 3 characters). */
export function numberVariants(...numbers: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const n of numbers) {
    const k = String(n ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (k.length < 3) continue;
    out.add(k);
    let s = k;
    for (let i = 0; i < 2; i++) {
      const t = s.replace(NUMBER_PREFIX, "");
      if (t === s || t.length < 3) break;
      s = t;
      out.add(s);
    }
  }
  return [...out];
}

const STOP = new Set(["the", "and", "for", "with", "set", "kit", "new", "used", "part", "parts", "each", "assembly", "assy", "type", "model", "machine", "sewing", "replacement", "genuine", "oem"]);

/** The words of a description worth looking for (3 letters or more, lower case, each once, not the filler words), at most `max`. */
export function nameTerms(text: string, max = 5): string[] {
  const out: string[] = [];
  for (const w of String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

// ----- Looks like -----

export type PartFacts = { number: string; alts: string[]; description: string; brand: string | null; fits: string | null };
/** A part the model may pick. `ref` is what it must cite; `href` is where a person opens it (never sent). */
export type LookCandidate = { ref: string; kind: "xpart" | "part"; name: string; numbers: string; fits: string; href: string; qty?: number };

const LOOKS_SYSTEM = `You help a sewing-machine, vacuum and small-appliance repair shop find the same part under another name or number.
You are given one part and numbered candidates: parts in the shop's own stock (references like s1) and entries in the community's shared cross-reference (references like x1). Say which candidates are probably the same part or a proper substitute for it. Judge by how the numbers are written (the same number with or without a prefix such as "Type" or "No.", a trailing revision), the name, the brand and the models it fits. A different size, voltage or fit is not a match.
Answer with JSON only: {"matches":[{"ref":"x3","confidence":"likely","why":"one short sentence"}]} with confidence "likely" or "possible", at most 5, best first. Cite only references from the list. When none look right, answer {"matches":[]}.`;

export function buildLooksLike(p: PartFacts, cands: readonly LookCandidate[], r: Redaction = {}): Built {
  const part = [
    `Part number: ${redact(clip(p.number, 80), r)}`,
    p.alts.length ? `Other numbers: ${p.alts.slice(0, 8).map((a) => redact(clip(a, 60), r)).join(", ")}` : "",
    `Description: ${redact(clip(p.description, 200), r)}`,
    p.brand ? `Brand: ${redact(clip(p.brand, 60), r)}` : "",
    p.fits ? `Fits: ${redact(clip(p.fits, 300), r)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const list = cands
    .slice(0, 40)
    .map((c) => `[${c.ref}] ${c.kind === "part" ? "In your stock" : "Community cross-reference"}: ${redact(clip(c.name, 160), r)} | numbers: ${redact(clip(c.numbers, 200), r)}${c.fits ? ` | fits: ${redact(clip(c.fits, 200), r)}` : ""}`)
    .join("\n");
  return {
    feature: "looks_like",
    cls: "read",
    system: LOOKS_SYSTEM,
    messages: [{ role: "user", content: `The part:\n${part}\n\nCandidates:\n${list}` }],
    maxTokens: 500,
    sources: cands.slice(0, 40).map((c): Source => ({ kind: c.kind, ref: c.ref, label: clip(c.name, 120), href: c.href })),
  };
}

export type Match = { ref: string; confidence: "likely" | "possible"; why: string };

/** The matches from the model's JSON, each checked against what was offered (an unknown reference is dropped, a repeat too). Null when the answer isn't usable; [] is "no match". */
export function parseMatches(text: string, offered: readonly { ref: string }[]): Match[] | null {
  const j = jsonOf(text) as { matches?: unknown } | null;
  if (!j || !Array.isArray(j.matches)) return null;
  const ok = new Set(offered.map((o) => o.ref));
  const seen = new Set<string>();
  const out: Match[] = [];
  for (const m of j.matches) {
    const o = m as { ref?: unknown; confidence?: unknown; why?: unknown };
    if (typeof o?.ref !== "string" || !ok.has(o.ref) || seen.has(o.ref)) continue;
    seen.add(o.ref);
    out.push({ ref: o.ref, confidence: o.confidence === "likely" ? "likely" : "possible", why: clip(typeof o.why === "string" ? o.why : "", 200) });
    if (out.length >= 5) break;
  }
  return out;
}

// ----- Parts this job usually needs -----

/** `kind` u: used on this shop's past jobs on the model; f: the community cross-reference says it fits the model. */
export type JobCandidate = { ref: string; kind: "used" | "fits"; label: string; text: string; href: string; stockHref?: string; qty?: number };
export type JobFacts = { brand: string; model: string; serviceRequested: string | null; problem: string | null; diagnosis: string | null };

const JOB_SYSTEM = `You help a repair technician plan the parts for a job. You are given the machine, the problem reported, and numbered candidates: parts this shop used on past jobs on the same model (references like u1) and parts the community's cross-reference says fit the model (references like f1).
List up to eight parts this job will likely need, most likely first, each with one short reason. Prefer parts used on past jobs with a similar problem; use the fitting parts to name a part the problem points to. Never invent a part: cite only references from the list.
Answer with JSON only: {"parts":[{"ref":"u2","reason":"..."}]}. When nothing in the list fits the problem, answer {"parts":[]}.`;

export function buildPartsForJob(j: JobFacts, cands: readonly JobCandidate[], r: Redaction = {}, o: { instruction?: string | null } = {}): Built {
  const head = [
    `Machine: ${redact([j.brand, j.model].join(" "), r)}`,
    j.serviceRequested ? `Service requested: ${redact(clip(j.serviceRequested, 300), r)}` : "",
    j.problem ? `Problem reported: ${redact(clip(j.problem, 800), r)}` : "",
    j.diagnosis ? `What we found: ${redact(clip(j.diagnosis, 800), r)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const list = cands.slice(0, 40).map((c) => `[${c.ref}] ${redact(clip(c.label, 160), r)}: ${redact(clip(c.text, 400), r)}`).join("\n");
  const extra = redact(clip(o.instruction, 160), r);
  return {
    feature: "parts_for_job",
    cls: "suggest",
    system: JOB_SYSTEM,
    messages: [{ role: "user", content: [head, `Candidates:\n${list}`, extra ? `Also: ${extra}` : ""].filter(Boolean).join("\n\n") }],
    maxTokens: 800,
    sources: cands.slice(0, 40).map((c): Source => ({ kind: c.kind === "used" ? "ticket" : "xpart", ref: c.ref, label: clip(c.label, 120), href: c.href })),
  };
}

export type JobPick = { ref: string; reason: string };

export function parseJobParts(text: string, offered: readonly { ref: string }[]): JobPick[] | null {
  const j = jsonOf(text) as { parts?: unknown } | null;
  if (!j || !Array.isArray(j.parts)) return null;
  const ok = new Set(offered.map((o) => o.ref));
  const seen = new Set<string>();
  const out: JobPick[] = [];
  for (const m of j.parts) {
    const o = m as { ref?: unknown; reason?: unknown };
    if (typeof o?.ref !== "string" || !ok.has(o.ref) || seen.has(o.ref)) continue;
    seen.add(o.ref);
    out.push({ ref: o.ref, reason: clip(typeof o.reason === "string" ? o.reason : "", 200) });
    if (out.length >= 8) break;
  }
  return out;
}

// ----- Match the columns (the inventory import) -----

export type ColumnField = { key: string; label: string };
const COLUMN_CELL = 40;

const COLUMNS_SYSTEM = `You match the columns of a supplier's or an old system's inventory spreadsheet to the fields of a repair shop's inventory.
You get the column headings (numbered from 0), up to three sample rows, and the fields to fill. For each field give the number of the column that holds it, or null when no column does. A column fills at most one field. A barcode is a UPC, EAN or GTIN; "cost" is what the shop pays, "price" is what it sells for; a "number" or "style" or "SKU" column is the item number.
Answer with JSON only: {"map":{"partNumber":0,"description":2,"price":null}} using exactly the field names given.`;

export function buildMatchColumns(fields: readonly ColumnField[], headers: readonly string[], sample: readonly (readonly string[])[], r: Redaction = {}): Built {
  const cell = (s: string) => redact(clip(s, COLUMN_CELL), r);
  const head = headers.slice(0, 60).map((h, i) => `${i}: ${cell(h) || "(blank)"}`).join("\n");
  const rows = sample.slice(0, 3).map((row, n) => `Row ${n + 1}: ${row.slice(0, 60).map((c, i) => `${i}=${cell(c)}`).join(" | ")}`).join("\n");
  return {
    feature: "match_columns",
    cls: "read",
    system: COLUMNS_SYSTEM,
    messages: [{ role: "user", content: `Fields to fill:\n${fields.map((f) => `${f.key}: ${f.label}`).join("\n")}\n\nColumn headings:\n${head}\n\nSample rows:\n${rows || "(none)"}` }],
    maxTokens: 400,
  };
}

/** The proposed map: field key -> column number, only for known fields and real columns, each column used once. Null when the answer isn't usable. */
export function parseColumnMap(text: string, fieldKeys: readonly string[], columns: number): Record<string, number> | null {
  const j = jsonOf(text) as { map?: unknown } | null;
  if (!j || typeof j.map !== "object" || j.map === null || Array.isArray(j.map)) return null;
  const map = j.map as Record<string, unknown>;
  const used = new Set<number>();
  const out: Record<string, number> = {};
  for (const key of fieldKeys) {
    const v = map[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= columns || used.has(v)) continue;
    used.add(v);
    out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}
