"use client";

// A print or cut job's form (shop-features-round-2-design.md 6.5): who it is for (new jobs), what it is, the machine, the
// customer's file, the material from stock and how much, the machine time, and "Work out the price" shown as it is
// typed (machine time x the rate + material x its price + the set-up fee). The server works it out again on save.
import { useState } from "react";
import { ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { startMakeJob, saveMakeJob } from "@/actions/make-jobs";
import { MAKE_KINDS, MAKE_KIND_LABEL, MATERIAL_TYPES, makePrice, type MakeKind } from "@/lib/make-jobs-math";
import { money, toCents } from "@/lib/format";

export type MaterialChoice = { id: string; label: string; itemType: string | null; unit: "g" | "ml" | "sheet"; unitCents: number | null; neverCut: boolean };
export type JobDraft = {
  title: string;
  kind: MakeKind;
  hours: string;
  minutes: string;
  materialPartId: string;
  materialName: string;
  materialQty: string;
  rate: string;
  setup: string;
  due: string;
  note: string;
  taxable: boolean;
};

const UNIT_WORD = { g: "grams", ml: "ml", sheet: "sheets" } as const;

export function JobForm({ id, init, materials, lockPrices, hasFile }: { id: string | null; init: JobDraft; materials: MaterialChoice[]; lockPrices: boolean; hasFile?: boolean }) {
  const [d, setD] = useState(init);
  const set = <K extends keyof JobDraft>(k: K, v: JobDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const fits = materials.filter((m) => m.itemType && MATERIAL_TYPES[d.kind].includes(m.itemType));
  const mat = materials.find((m) => m.id === d.materialPartId) ?? null;
  const minutes = Math.round((Number(d.hours) || 0) * 60 + (Number(d.minutes) || 0));
  const price = makePrice({ minutes, rateCents: toCents(d.rate) ?? 0, materialQty: Number(d.materialQty) || 0, materialUnitCents: mat?.unitCents ?? null, setupCents: toCents(d.setup) ?? 0 });
  const p = id ? "edit-" : "new-";
  return (
    <ActionForm action={id ? saveMakeJob.bind(null, id) : startMakeJob} className="grid gap-3 sm:grid-cols-2">
      {!id && <CustomerPicker initial={null} />}
      <div className="field sm:col-span-2">
        <label className="label" htmlFor={`${p}title`}>
          What is it?
        </label>
        <input id={`${p}title`} name="title" className="input" required maxLength={120} value={d.title} onChange={(e) => set("title", e.target.value)} placeholder="20 acrylic name tags" />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}kind`}>
          On which machine
        </label>
        <select id={`${p}kind`} name="kind" className="select" value={d.kind} onChange={(e) => set("kind", e.target.value as MakeKind)}>
          {MAKE_KINDS.map((k) => (
            <option key={k} value={k}>
              {MAKE_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}file`}>
          The customer&apos;s file {hasFile ? "(choose one to replace it)" : "(optional)"}
        </label>
        <input id={`${p}file`} name="file" type="file" className="input" />
        <p className="muted text-sm">Kept until 30 days after pickup, then deleted. 10 MB at most.</p>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}mat`}>
          Material from stock
        </label>
        <select id={`${p}mat`} name="materialPartId" className="select" value={d.materialPartId} onChange={(e) => set("materialPartId", e.target.value)}>
          <option value="">None, or the customer brings it</option>
          {fits.map((m) => (
            <option key={m.id} value={m.id} disabled={m.neverCut && d.kind === "LASER"}>
              {m.label}
              {m.neverCut && d.kind === "LASER" ? " (never on the laser)" : ""}
            </option>
          ))}
        </select>
        {!d.materialPartId && <input name="materialName" className="input mt-1" value={d.materialName} onChange={(e) => set("materialName", e.target.value)} placeholder="Or say what it is (theirs)" aria-label="Material in words" />}
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}qty`}>
          How much material ({mat ? UNIT_WORD[mat.unit] : "grams, ml or sheets"})
        </label>
        <input id={`${p}qty`} name="materialQty" inputMode="decimal" className="input num w-32" value={d.materialQty} onChange={(e) => set("materialQty", e.target.value)} />
      </div>
      <div className="field">
        <span className="label">Machine time</span>
        <div className="flex items-center gap-2">
          <input name="hours" inputMode="numeric" className="input num w-20" value={d.hours} onChange={(e) => set("hours", e.target.value)} aria-label="Hours" /> h
          <input name="minutes" inputMode="numeric" className="input num w-20" value={d.minutes} onChange={(e) => set("minutes", e.target.value)} aria-label="Minutes" /> min
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}due`}>
          Wanted by (optional)
        </label>
        <input id={`${p}due`} name="due" type="date" className="input" value={d.due} onChange={(e) => set("due", e.target.value)} />
      </div>
      <details className="sm:col-span-2">
        <summary className="link cursor-pointer text-sm">Rate, set-up fee, tax and a note</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div className="field">
            <label className="label" htmlFor={`${p}rate`}>
              Machine rate ($ an hour)
            </label>
            <input id={`${p}rate`} name="rate" inputMode="decimal" className="input num w-28" value={d.rate} disabled={lockPrices} onChange={(e) => set("rate", e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor={`${p}setup`}>
              Set-up fee ($)
            </label>
            <input id={`${p}setup`} name="setup" inputMode="decimal" className="input num w-28" value={d.setup} disabled={lockPrices} onChange={(e) => set("setup", e.target.value)} />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-base">
            <input type="hidden" name="taxable" value="off" />
            <input type="checkbox" name="taxable" value="on" className="check" checked={d.taxable} onChange={(e) => set("taxable", e.target.checked)} /> Taxable
          </label>
          <div className="field">
            <label className="label" htmlFor={`${p}note`}>
              Note
            </label>
            <input id={`${p}note`} name="note" className="input" maxLength={1000} value={d.note} onChange={(e) => set("note", e.target.value)} />
          </div>
        </div>
      </details>
      <p className="text-base sm:col-span-2" aria-live="polite">
        The price: machine {money(price.machineCents)} + material {money(price.materialCents)} + set-up {money(price.setupCents)} = <span className="num text-xl font-semibold">{money(price.totalCents)}</span> before tax
      </p>
      <div className="sm:col-span-2">
        <Submit>{id ? "Save" : "Take the job"}</Submit>
      </div>
    </ActionForm>
  );
}
