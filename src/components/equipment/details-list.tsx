import type { EquipmentKind } from "@/lib/equipment/types";
import { KV } from "@/components/ui";

const show = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : v == null || v === "" ? null : String(v));

/** A machine's intake answers plus this visit's, labelled from the kind; answers under keys the kind no longer asks go under "Other details". */
export function DetailsList({ kind, details, intake }: { kind: EquipmentKind; details: Record<string, unknown>; intake: Record<string, unknown> }) {
  const known = new Map(kind.intakeFields.map((d) => [d.key, d.label]));
  const rows: { k: string; v: string | null }[] = [];
  const other: string[] = [];
  for (const [src, on] of [
    [details, "machine"],
    [intake, "ticket"],
  ] as const) {
    for (const d of kind.intakeFields.filter((d) => d.on === on)) {
      const v = show(src[d.key]);
      if (v != null) rows.push({ k: d.label, v });
    }
    for (const [k, v] of Object.entries(src)) {
      const s = show(v);
      if (!known.has(k) && s != null) other.push(`${k}: ${s}`);
    }
  }
  if (!rows.length && !other.length) return <p className="muted text-sm">Nothing recorded yet.</p>;
  return (
    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
      {rows.map((r) => (
        <KV key={r.k} k={r.k} v={r.v} />
      ))}
      {other.length > 0 && <KV k="Other details" v={other.join("; ")} />}
    </div>
  );
}
