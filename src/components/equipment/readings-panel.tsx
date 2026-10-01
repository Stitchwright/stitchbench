import { inRange } from "@/lib/equipment/form";
import type { ReadingDef } from "@/lib/equipment/types";
import { ActionForm, Submit } from "@/components/action-form";
import { saveReadings } from "@/actions/tickets";

type Values = Record<string, { found?: string | number; left?: string | number }>;

/** A non-sewing kind's readings (What | As found | As left | unit | pill), in place of the tension and timing blocks. */
export function ReadingsPanel({ ticketId, defs, values, readOnly = false }: { ticketId: string; defs: ReadingDef[]; values: Values; readOnly?: boolean }) {
  if (!defs.length) return null;
  const pill = (d: ReadingDef, v: unknown) => {
    const ok = inRange(d, v);
    if (ok === true) return <span className="pill tone-ready">in range</span>;
    if (ok === false) return <span className="pill tone-bad">out</span>;
    if (d.type === "passfail" && v === "fail") return <span className="pill tone-bad">fail</span>;
    if (d.type === "passfail" && v === "pass") return <span className="pill tone-ready">pass</span>;
    return null;
  };
  const box = (d: ReadingDef, side: "found" | "left") => {
    const v = values[d.key]?.[side];
    const name = `${side}:${d.key}`;
    const label = `${d.label} as ${side}`;
    if (d.type === "passfail") {
      return (
        <select name={name} aria-label={label} className="select w-24" defaultValue={typeof v === "string" ? v : ""} disabled={readOnly}>
          <option value="">-</option>
          <option value="pass">Pass</option>
          <option value="fail">Fail</option>
        </select>
      );
    }
    return (
      <input
        name={name}
        aria-label={label}
        defaultValue={v == null ? "" : String(v)}
        inputMode={d.type === "number" ? "decimal" : undefined}
        className={`input ${d.type === "number" ? "num w-24" : "w-40"}`}
        placeholder={d.unit}
        disabled={readOnly}
      />
    );
  };
  return (
    <ActionForm action={saveReadings.bind(null, ticketId)} success="Readings saved">
      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>What</th>
              <th>As found</th>
              <th>As left</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {defs.map((d) => (
              <tr key={d.key}>
                <td className="font-semibold">
                  {d.label}
                  {d.unit && <span className="muted ml-1 text-xs">({d.unit})</span>}
                </td>
                <td>{d.foundLeft ? box(d, "found") : <span className="muted">-</span>}</td>
                <td>{box(d, "left")}</td>
                <td>{pill(d, values[d.key]?.left ?? values[d.key]?.found)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="mt-3 flex justify-end">
          <Submit className="btn">Save readings</Submit>
        </div>
      )}
    </ActionForm>
  );
}
