// Reading a kind's intake answers and readings out of a form (modules-design.md section 9.3). Pure.
import { UserError } from "@/lib/action";
import type { FieldDef, ReadingDef } from "./types";

const KEY = /^[a-z0-9-]{1,40}$/;
const str = (v: FormDataEntryValue | null) => (v == null ? null : String(v).trim() || null);

/**
 * The answers to `defs` (those asked `on` the machine or the ticket) from inputs named `f:<key>`. Text <= 200 chars,
 * numbers finite, a select must be one of its options, a checkbox "on" is true; blank is dropped unless the key is
 * in `required`. Unknown keys are ignored; entries of `prev` for keys no longer defined are kept.
 */
export function readAnswers(defs: FieldDef[], on: "machine" | "ticket", fd: FormData, prev?: Record<string, unknown>, required: string[] = []): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const mine = defs.filter((d) => d.on === on);
  const known = new Set(mine.map((d) => d.key));
  for (const [k, v] of Object.entries(prev ?? {})) {
    if (!known.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) out[k] = v;
  }
  for (const d of mine) {
    const raw = fd.get(`f:${d.key}`);
    if (d.type === "checkbox") {
      if (raw != null) out[d.key] = String(raw) === "on" || String(raw) === "true";
      continue;
    }
    const s = str(raw);
    if (s == null) {
      if (required.includes(d.key)) throw new UserError(`Answer '${d.label}'.`);
      continue;
    }
    if (d.type === "number") {
      const n = Number(s.replace(/,/, "."));
      if (!Number.isFinite(n)) throw new UserError(`${d.label}: "${s}" isn't a number.`);
      out[d.key] = n;
    } else if (d.type === "select") {
      if (!d.options?.includes(s)) throw new UserError(`Pick one of the choices for ${d.label}.`);
      out[d.key] = s;
    } else {
      out[d.key] = s.slice(0, 200);
    }
  }
  return out;
}

/**
 * Readings from inputs `found:<key>` / `left:<key>`: numbers >= 0 and finite, text <= 80, passfail "pass" | "fail".
 * Unknown keys are ignored (a Map, never an object from the browser's keys). A key with neither value is left out.
 */
export function readReadings(defs: ReadingDef[], fd: FormData): Record<string, { found?: string | number; left?: string | number }> {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const read = new Map<string, { found?: string | number; left?: string | number }>();
  for (const [k, v] of fd.entries()) {
    const m = /^(found|left):([a-z0-9-]{1,40})$/.exec(k);
    if (!m) continue;
    const d = byKey.get(m[2]);
    if (!d) continue;
    const s = str(v);
    if (s == null) continue;
    let value: string | number;
    if (d.type === "number") {
      const n = Number(s.replace(/,/, "."));
      if (!Number.isFinite(n) || n < 0) throw new UserError(`${d.label} as ${m[1]}: "${s}" isn't a reading (0 or more).`);
      value = n;
    } else if (d.type === "passfail") {
      if (s !== "pass" && s !== "fail") throw new UserError(`${d.label}: pick Pass or Fail.`);
      value = s;
    } else {
      value = s.slice(0, 80);
    }
    const entry = read.get(d.key) ?? {};
    // A one-value reading is stored as "left".
    entry[d.foundLeft ? (m[1] as "found" | "left") : "left"] = value;
    read.set(d.key, entry);
  }
  return Object.fromEntries(read);
}

/** Defensive parse of ShopEquipmentKind.intakeFields. */
export function cleanFieldDefs(json: unknown): FieldDef[] {
  if (!Array.isArray(json)) return [];
  const out: FieldDef[] = [];
  const seen = new Set<string>();
  for (const x of json.slice(0, 30)) {
    if (!x || typeof x !== "object") continue;
    const f = x as Record<string, unknown>;
    const key = typeof f.key === "string" ? f.key : "";
    const label = typeof f.label === "string" ? f.label.trim().slice(0, 120) : "";
    const type = f.type === "text" || f.type === "number" || f.type === "select" || f.type === "checkbox" ? f.type : null;
    const on = f.on === "ticket" ? "ticket" : "machine";
    if (!KEY.test(key) || !label || !type || seen.has(key)) continue;
    seen.add(key);
    const options = Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim().slice(0, 80)).slice(0, 20) : undefined;
    if (type === "select" && !options?.length) continue;
    out.push({
      key,
      label,
      type,
      on,
      ...(type === "select" ? { options } : {}),
      ...(typeof f.unit === "string" && f.unit ? { unit: f.unit.slice(0, 12) } : {}),
      ...(typeof f.placeholder === "string" && f.placeholder ? { placeholder: f.placeholder.slice(0, 80) } : {}),
    });
  }
  return out;
}

/** Whether a number reading is inside the definition's range; null when it isn't a number or has no range. */
export function inRange(def: ReadingDef, v: unknown): boolean | null {
  if (def.type !== "number" || (def.min == null && def.max == null)) return null;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return (def.min == null || n >= def.min) && (def.max == null || n <= def.max);
}
