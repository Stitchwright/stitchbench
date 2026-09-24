import Link from "next/link";
import { Pin, Trash2 } from "lucide-react";
import { specsFor, notesFor, gRange, type SpecRow } from "@/lib/model-info";
import { LocalManuals, OpenSpecSource } from "@/components/local-manuals";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { addNote, deleteNote, toggleNotePin } from "@/actions/records";
import { NOTE_LABEL } from "@/lib/constants";
import { Section, modelHref } from "@/components/ui";

export function SpecsTable({ specs, compact = false }: { specs: SpecRow[]; compact?: boolean }) {
  if (!specs.length) return null;
  return (
    <div className="scroll-x">
      <table className="table">
        <thead>
          <tr>
            {!compact && <th>Model(s)</th>}
            <th>Upper</th>
            <th>Bobbin</th>
            <th>Conditions</th>
            {!compact && <th>Source</th>}
          </tr>
        </thead>
        <tbody>
          {specs.map((s) => (
            <tr key={s.id}>
              {!compact && (
                <td>
                  <div className="font-semibold">{s.brand}</div>
                  <div className="text-xs">{s.models}</div>
                </td>
              )}
              <td className="num whitespace-nowrap">
                <div className="font-semibold">{gRange(s.upperMinG, s.upperMaxG) || "-"}</div>
                {s.upperPrinted && !s.upperPrinted.endsWith(" g") && <div className="muted text-xs">printed {s.upperPrinted}</div>}
              </td>
              <td className="num whitespace-nowrap">
                <div className="font-semibold">{gRange(s.bobbinMinG, s.bobbinMaxG) || (s.bobbinPrinted ?? "-")}</div>
                {s.bobbinPrinted && !s.bobbinPrinted.endsWith(" g") && <div className="muted text-xs">printed {s.bobbinPrinted}</div>}
              </td>
              <td className={`text-xs ${compact ? "" : "min-w-56"}`}>
                {s.upperConditions && (
                  <div>
                    <span className="label">Upper</span> {s.upperConditions}
                  </div>
                )}
                {s.bobbinConditions && (
                  <div>
                    <span className="label">Bobbin</span> {s.bobbinConditions}
                  </div>
                )}
                {s.otherSpecs && (
                  <div>
                    <span className="label">Other</span> {s.otherSpecs}
                  </div>
                )}
                {compact && (
                  <div className="muted mt-1 flex flex-wrap gap-x-2">
                    <span className="max-w-full truncate" title={s.sourceFile}>
                      {s.sourceFile}
                    </span>
                    <OpenSpecSource file={s.sourceFile} pages={s.pages} />
                  </div>
                )}
                {s.confidence && s.confidence !== "high" && (
                  <div className="mt-1">
                    <span className="pill tone-wait">{s.confidence} confidence</span> {s.notes}
                  </div>
                )}
              </td>
              {!compact && (
                <td className="text-xs">
                  <div className="max-w-56 truncate" title={s.sourceFile}>
                    {s.sourceFile}
                  </div>
                  <OpenSpecSource file={s.sourceFile} pages={s.pages} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export async function Gotchas({ shopId, brand, model }: { shopId: string; brand: string; model: string }) {
  const notes = await notesFor(shopId, brand, model);
  return (
    <div className="space-y-3">
      {notes.length === 0 && <p className="muted text-sm">No notes yet for the {model}. Add what the next tech should know.</p>}
      <ul className="space-y-2">
        {notes.map((n) => (
          <li key={n.id} className={`rounded border px-3 py-2 ${n.kind === "GOTCHA" ? "border-thread/40" : "border-line"}`}>
            <div className="flex items-start gap-2">
              <span className={`pill ${n.kind === "GOTCHA" ? "tone-bad" : n.kind === "TIP" ? "tone-ready" : "tone-work"}`}>{NOTE_LABEL[n.kind]}</span>
              <p className="flex-1 text-sm whitespace-pre-wrap">{n.body}</p>
              <ActionButton action={toggleNotePin.bind(null, n.id)} className="btn btn-sm" title={n.pinned ? "Unpin" : "Pin to top"}>
                <Pin size={12} aria-label={n.pinned ? "Unpin" : "Pin"} className={n.pinned ? "text-thread" : ""} />
              </ActionButton>
              <ActionButton action={deleteNote.bind(null, n.id)} className="btn btn-sm btn-danger" confirm="Delete?" title="Delete note">
                <Trash2 size={12} aria-label="Delete" />
              </ActionButton>
            </div>
            <div className="muted mt-1 text-xs">
              {n.author?.name ?? "Someone"}, {n.createdAt.toLocaleDateString()}
            </div>
          </li>
        ))}
      </ul>
      <ActionForm action={addNote} reset success="Note saved" className="space-y-2">
        <input type="hidden" name="brand" value={brand} />
        <input type="hidden" name="model" value={model} />
        <div className="flex gap-2">
          <label htmlFor={`kind-${model}`} className="sr-only">
            Kind
          </label>
          <select id={`kind-${model}`} name="kind" className="select w-32 shrink-0">
            <option value="GOTCHA">Gotcha</option>
            <option value="FACT">Fact</option>
            <option value="TIP">Tip</option>
          </select>
          <label htmlFor={`body-${model}`} className="sr-only">
            Note
          </label>
          <textarea
            id={`body-${model}`}
            name="body"
            rows={2}
            required
            className="textarea"
            placeholder="e.g. Hook retainer screws strip easily. Use the #2 JIS driver."
          />
        </div>
        <div className="flex justify-end">
          <Submit className="btn btn-sm">Add note</Submit>
        </div>
      </ActionForm>
    </div>
  );
}

/** Everything known about one brand + model: factory tension, gotchas, manuals on this PC. */
export async function ModelPanel({ shopId, brand, model, showLink = true }: { shopId: string; brand: string; model: string; showLink?: boolean }) {
  const specs = await specsFor(brand, model);
  return (
    <div className="space-y-4">
      <Section
        title={`Factory tension - ${brand} ${model}`}
        actions={
          showLink ? (
            <Link href={modelHref(brand, model)} className="link text-sm">
              Model page
            </Link>
          ) : undefined
        }
      >
        {specs.length ? (
          <SpecsTable specs={specs} compact />
        ) : (
          <p className="muted text-sm">
            No gauge spec on file for this model.{" "}
            <Link href={`/specs?q=${encodeURIComponent(brand)}`} className="link">
              See other {brand} specs
            </Link>
            .
          </p>
        )}
      </Section>
      <Section title="Important facts and gotchas">
        <Gotchas shopId={shopId} brand={brand} model={model} />
      </Section>
      <Section title="Manuals on this PC">
        <LocalManuals brand={brand} model={model} />
      </Section>
    </div>
  );
}
