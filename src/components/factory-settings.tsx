import Link from "next/link";
import { ADJUSTMENTS, ADJ_NAME, valueRange } from "@/lib/adjustments";
import type { SettingRowT } from "@/lib/model-info";
import { ManualFigure } from "@/components/manual-figure";

/** Factory timing and core adjustments for a model, grouped the way a tech works, each with its manual figure. */
export function FactorySettings({ settings, brand }: { settings: SettingRowT[]; brand: string }) {
  if (!settings.length)
    return (
      <p className="muted text-sm">
        No timing or adjustment standards on file for this model.{" "}
        <Link href={`/specs?tab=settings&q=${encodeURIComponent(brand)}`} className="link">
          See other {brand} settings
        </Link>
        .
      </p>
    );
  const groups = [...new Set(ADJUSTMENTS.map((a) => a.group))];
  return (
    <div className="space-y-5">
      {groups.map((g) => {
        const rows = settings.filter((s) => (ADJUSTMENTS.find((a) => a.key === s.adjustment)?.group ?? "Other") === g);
        if (!rows.length) return null;
        return (
          <div key={g}>
            <h3 className="label mb-2">{g}</h3>
            <ul className="divide-y divide-line">
              {rows.map((s) => (
                <li key={s.id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="font-semibold">{s.label || ADJ_NAME[s.adjustment]}</div>
                    <div className="num text-lg font-semibold">{valueRange(s.valueMin, s.valueMax, s.unit) || s.valueText}</div>
                  </div>
                  <div className="mt-1 space-y-0.5 text-sm">
                    {s.valueText && <div className="muted">&ldquo;{s.valueText}&rdquo;</div>}
                    {s.reference && (
                      <div>
                        <span className="label">Measured</span> {s.reference}
                      </div>
                    )}
                    {s.conditions && (
                      <div>
                        <span className="label">When</span> {s.conditions}
                      </div>
                    )}
                    {s.tools && (
                      <div>
                        <span className="label">Tools</span> {s.tools}
                      </div>
                    )}
                    {s.confidence && s.confidence !== "high" && (
                      <div>
                        <span className="pill tone-wait">{s.confidence} confidence</span> {s.notes}
                      </div>
                    )}
                    <div className="muted text-xs">
                      {s.models} · {s.sourceFile}
                      {s.pages ? `, p. ${s.pages}` : ""}
                    </div>
                  </div>
                  <div className="mt-2">
                    <ManualFigure file={s.sourceFile} sourcePath={s.sourcePath} page={s.figurePage} box={s.figureBox} figureId={s.figureId} stored={s.figureStored} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
