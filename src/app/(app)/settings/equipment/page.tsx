// "What you repair" (modules-design.md 11.2): which kind check-in opens on, the built-in kinds the company can use
// (read-only), its own kinds (forms, while Small Appliance Repair is active) and "Add your own kind". Shown when vac or
// appliance is not off; techs and a lapsed appliance module get a read-only view.
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { pageGate } from "@/lib/module-info";
import { getModules } from "@/lib/modules";
import { shopKinds } from "@/lib/equipment/shop";
import { cleanFieldDefs } from "@/lib/equipment/form";
import { accessoryBoxText } from "@/lib/equipment/lines";
import type { EquipmentKind, FieldDef } from "@/lib/equipment/types";
import { saveCheckInKind, saveEquipmentKind, setKindActive } from "@/actions/equipment";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { ModuleNotice } from "@/components/module-notice";
import { Empty, PageHeader, Section } from "@/components/ui";

const TYPE_LABEL: Record<FieldDef["type"], string> = { text: "Text", number: "Number", select: "Choice", checkbox: "Yes / no" };
const ON_LABEL: Record<FieldDef["on"], string> = { machine: "Once per unit", ticket: "Every visit" };
const BLANK_ROWS = 3;

type KindRow = { key: string; label: string; noun: string | null; types: string[]; brands: string[]; accessories: string[]; defaultChecked: string[]; checklist: string[]; intakeFields: unknown; active: boolean };

function List({ title, items, marked }: { title: string; items: string[]; marked?: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="label">{title}</div>
      <ul className="list-inside list-disc text-sm">
        {items.map((it) => (
          <li key={it}>
            {it}
            {marked?.includes(it) && <span className="muted"> (ticked at check-in)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BuiltIn({ k }: { k: EquipmentKind }) {
  return (
    <details className="card card-pad">
      <summary className="cursor-pointer font-semibold">{k.label}</summary>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <List title="Types" items={k.types} />
        <List title="Accessories" items={k.accessories} marked={k.defaultChecked} />
        {k.intakeFields.length > 0 && (
          <div>
            <div className="label">Check-in questions</div>
            <ul className="list-inside list-disc text-sm">
              {k.intakeFields.map((f) => (
                <li key={f.key}>
                  {f.label} <span className="muted">({TYPE_LABEL[f.type]}, {ON_LABEL[f.on].toLowerCase()})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <List title="Checklist" items={k.checklist} />
        {k.readings.length > 0 && <List title="Readings" items={k.readings.map((r) => r.label)} />}
        <List title="Starter menu" items={k.serviceMenu.map((s) => s.name)} />
      </div>
    </details>
  );
}

function QuestionRow({ n, def, idp }: { n: number; def: FieldDef | null; idp: string }) {
  return (
    <div className="grid-form items-end">
      <input type="hidden" name="q.key" value={def?.key ?? ""} />
      <div className="field">
        <label htmlFor={`${idp}-ql-${n}`} className="label">
          Question {n}
        </label>
        <input id={`${idp}-ql-${n}`} name="q.label" className="input" defaultValue={def?.label ?? ""} placeholder={def ? "" : "e.g. Boiler type"} />
      </div>
      <div className="field">
        <label htmlFor={`${idp}-qt-${n}`} className="label">
          Answer type
        </label>
        <select id={`${idp}-qt-${n}`} name="q.type" className="select" defaultValue={def?.type ?? "text"}>
          {(Object.keys(TYPE_LABEL) as FieldDef["type"][]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idp}-qo-${n}`} className="label">
          Choices (separate with commas)
        </label>
        <input id={`${idp}-qo-${n}`} name="q.options" className="input" defaultValue={def?.options?.join(", ") ?? ""} />
      </div>
      <div className="field">
        <label htmlFor={`${idp}-qn-${n}`} className="label">
          Asked
        </label>
        <select id={`${idp}-qn-${n}`} name="q.on" className="select" defaultValue={def?.on ?? "machine"}>
          <option value="machine">Once per unit</option>
          <option value="ticket">Every visit</option>
        </select>
      </div>
      {def && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="q.remove" value={def.key} className="check" /> Remove
        </label>
      )}
    </div>
  );
}

function KindForm({ row, readOnly }: { row: KindRow | null; readOnly: boolean }) {
  const idp = row?.key ?? "new";
  const questions = row ? cleanFieldDefs(row.intakeFields) : [];
  return (
    <ActionForm action={saveEquipmentKind.bind(null, row?.key ?? null)} success={row ? "Saved" : "Kind added"} className="space-y-3">
      <fieldset disabled={readOnly} className="space-y-3">
        <div className="grid-form">
          <div className="field">
            <label htmlFor={`${idp}-label`} className="label">
              Name
            </label>
            <input id={`${idp}-label`} name="label" required className="input" defaultValue={row?.label ?? ""} placeholder="Espresso machine" />
          </div>
          <div className="field">
            <label htmlFor={`${idp}-noun`} className="label">
              Word used in sentences
            </label>
            <input id={`${idp}-noun`} name="noun" className="input" defaultValue={row?.noun ?? ""} placeholder="espresso machine" />
          </div>
          <div className="field">
            <label htmlFor={`${idp}-types`} className="label">
              Types, one per line
            </label>
            <textarea id={`${idp}-types`} name="types" rows={3} className="textarea text-sm" defaultValue={row?.types.join("\n") ?? ""} />
          </div>
          <div className="field">
            <label htmlFor={`${idp}-brands`} className="label">
              Brands, one per line
            </label>
            <textarea id={`${idp}-brands`} name="brands" rows={3} className="textarea text-sm" defaultValue={row?.brands.join("\n") ?? ""} />
          </div>
          <div className="field">
            <label htmlFor={`${idp}-acc`} className="label">
              Accessories, one per line (start a line with * to tick it at check-in)
            </label>
            <textarea id={`${idp}-acc`} name="accessories" rows={3} className="textarea text-sm" defaultValue={row ? accessoryBoxText(row) : ""} placeholder={"* Power cord\nPortafilter"} />
          </div>
          <div className="field">
            <label htmlFor={`${idp}-check`} className="label">
              Checklist, one per line
            </label>
            <textarea id={`${idp}-check`} name="checklist" rows={3} className="textarea text-sm" defaultValue={row?.checklist.join("\n") ?? ""} />
          </div>
        </div>
        <div className="space-y-2">
          <div className="label">Check-in questions</div>
          {questions.map((q, i) => (
            <QuestionRow key={q.key} n={i + 1} def={q} idp={idp} />
          ))}
          {Array.from({ length: BLANK_ROWS }, (_, i) => (
            <QuestionRow key={`blank-${i}`} n={questions.length + i + 1} def={null} idp={idp} />
          ))}
          <p className="muted text-xs">Blank rows are ignored. Save with all three filled to get three more.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" className="check" defaultChecked={row?.active ?? true} /> Active (offered at check-in)
        </label>
        {!readOnly && <Submit>{row ? "Save" : "Add the kind"}</Submit>}
      </fieldset>
    </ActionForm>
  );
}

export default async function EquipmentSettings() {
  const user = await requireUser();
  const shopId = user.shopId;
  const [mods, shop, kinds, rows] = await Promise.all([
    getModules(shopId),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { id: true, name: true, checkInKind: true } }),
    shopKinds(shopId),
    db.shopEquipmentKind.findMany({ where: { shopId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
  ]);
  const admin = user.role !== "TECH";
  const shown = pageGate(mods.states.vac) !== "none" || pageGate(mods.states.appliance) !== "none";
  const canEdit = admin && mods.states.appliance.active;
  const builtIns = kinds.usable.filter((k) => k.builtIn);
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="What you repair" sub="The kinds of things you check in, and what each one asks for." back={{ href: "/settings", label: "Settings" }} />
      {!shown ? (
        <ModuleNotice state={mods.states.appliance} admin={admin} shop={shop} />
      ) : (
        <>
          <Section title="Check-in opens on">
            <ActionForm action={saveCheckInKind} success="Saved" className="flex flex-wrap items-end gap-2">
              <div className="field">
                <label htmlFor="checkInKind" className="label">
                  Kind
                </label>
                <select id="checkInKind" name="checkInKind" className="select" defaultValue={shop.checkInKind ?? "sewing"} disabled={!admin}>
                  {kinds.usable.map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
              {admin && <Submit className="btn">Save</Submit>}
              <span className="muted text-sm">The check-in page starts on this. You can still pick another kind there.</span>
            </ActionForm>
          </Section>

          <Section title="Built-in kinds">
            <div className="space-y-2">
              {builtIns.map((k) => (
                <BuiltIn key={k.key} k={k} />
              ))}
            </div>
            <p className="muted mt-3 text-sm">These lists are built in. Add your own kind below if you need something different.</p>
          </Section>

          {(rows.length > 0 || mods.states.appliance.active) && (
            <Section title="Your own kinds">
              {rows.length === 0 ? (
                <Empty>None yet.</Empty>
              ) : (
                <div className="space-y-2">
                  {rows.map((r) => (
                    <details key={r.key} className="card card-pad">
                      <summary className="cursor-pointer font-semibold">
                        {r.label} {!r.active && <span className="pill tone-neutral ml-2">off</span>}
                      </summary>
                      <div className="mt-3 space-y-3">
                        <KindForm row={r} readOnly={!canEdit} />
                        {canEdit && (
                          <ActionButton action={setKindActive.bind(null, r.key, !r.active)} className="btn btn-sm" success={r.active ? "Switched off" : "Switched on"}>
                            {r.active ? "Switch off (hide from check-in)" : "Switch on"}
                          </ActionButton>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              )}
              {!canEdit && admin && <p className="muted mt-3 text-sm">Small Appliance Repair isn&apos;t active: your kinds are read-only.</p>}
            </Section>
          )}

          {canEdit && (
            <Section title="Add your own kind">
              <KindForm row={null} readOnly={false} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}
