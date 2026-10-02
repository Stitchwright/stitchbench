// Reading the "What you repair" form (modules-design.md 11.2): one-per-line boxes, the accessory box with its "*"
// ticks, and the check-in question rows (`q.*` arrays by index, no client JavaScript). Pure.
import { UserError } from "@/lib/action";
import type { FieldDef } from "./types";

export const MAX_QUESTIONS = 30;
export const MAX_CHOICES = 20;
const KEY = /^[a-z0-9-]{1,40}$/;

/** One per line, trimmed, 120 characters each at most, de-duplicated, up to `max`. */
export function readListBox(text: string | null | undefined, max = 100): string[] {
  const out: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const t = line.trim().slice(0, 120);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** The accessory box: a line starting with "*" is ticked at check-in. */
export function readAccessoryBox(text: string | null | undefined): { accessories: string[]; defaultChecked: string[] } {
  const accessories: string[] = [];
  const defaultChecked: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    const ticked = raw.startsWith("*");
    const name = (ticked ? raw.slice(1) : raw).trim().slice(0, 120);
    if (!name || accessories.includes(name)) continue;
    accessories.push(name);
    if (ticked) defaultChecked.push(name);
    if (accessories.length >= 100) break;
  }
  return { accessories, defaultChecked };
}

export function accessoryBoxText(k: { accessories: string[]; defaultChecked: string[] }): string {
  return k.accessories.map((a) => (k.defaultChecked.includes(a) ? `* ${a}` : a)).join("\n");
}

/** "Espresso machine" -> "espresso-machine" (40 characters at most; "q" when nothing is left). */
export function slug(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "q";
}

/** A key not yet in `used`: the slug, else slug-2, slug-3... */
export function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base.slice(0, 40 - String(n).length - 1)}-${n}`;
  return key;
}

const TYPES: FieldDef["type"][] = ["text", "number", "select", "checkbox"];

/**
 * The question rows by index from q.key / q.label / q.type / q.options / q.on, skipping blank labels and the keys
 * ticked in q.remove. A row whose q.key is one of `prev` keeps that key (relabelling keeps the answers); a new row gets
 * the slug of its label made unique. Problems name the row: "Question 3: ...".
 */
export function readQuestionRows(fd: FormData, prev: FieldDef[]): FieldDef[] {
  const labels = fd.getAll("q.label").map(String);
  const types = fd.getAll("q.type").map(String);
  const options = fd.getAll("q.options").map(String);
  const ons = fd.getAll("q.on").map(String);
  const keys = fd.getAll("q.key").map(String);
  const remove = new Set(fd.getAll("q.remove").map(String));
  const prevKeys = new Set(prev.map((d) => d.key));
  const used = new Set<string>();
  const out: FieldDef[] = [];
  for (let i = 0; i < labels.length; i++) {
    const n = i + 1;
    const label = labels[i].trim();
    const givenKey = (keys[i] ?? "").trim();
    if (!label || (givenKey && remove.has(givenKey))) continue;
    if (label.length > 120) throw new UserError(`Question ${n}: the question is over 120 characters.`);
    const type = TYPES.includes(types[i] as FieldDef["type"]) ? (types[i] as FieldDef["type"]) : "text";
    const on: FieldDef["on"] = ons[i] === "ticket" ? "ticket" : "machine";
    const key = givenKey && prevKeys.has(givenKey) && KEY.test(givenKey) && !used.has(givenKey) ? givenKey : uniqueKey(slug(label), used);
    used.add(key);
    const def: FieldDef = { key, label, type, on };
    if (type === "select") {
      const choices = [...new Set((options[i] ?? "").split(",").map((s) => s.trim().slice(0, 80)).filter(Boolean))];
      if (!choices.length) throw new UserError(`Question ${n}: a Choice question needs its choices (separate them with commas).`);
      if (choices.length > MAX_CHOICES) throw new UserError(`Question ${n}: ${MAX_CHOICES} choices at most.`);
      def.options = choices;
    }
    out.push(def);
    if (out.length > MAX_QUESTIONS) throw new UserError(`${MAX_QUESTIONS} questions at most.`);
  }
  return out;
}
