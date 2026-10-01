import Link from "next/link";
import type { EquipmentKind } from "@/lib/equipment/types";

/** Buttons for the kinds offered (check-in, the tickets and machines lists): the active one is highlighted. */
export function KindChips({ kinds, active, hrefFor, label = "Kind" }: { kinds: EquipmentKind[]; active: string | null; hrefFor: (key: string) => string; label?: string }) {
  if (kinds.length < 2) return null;
  return (
    <div className="no-print flex flex-wrap gap-2 text-sm" role="group" aria-label={label}>
      {kinds.map((k) => (
        <Link key={k.key} href={hrefFor(k.key)} className={`btn btn-sm ${active === k.key ? "btn-primary" : ""}`} aria-current={active === k.key ? "true" : undefined}>
          {k.label}
        </Link>
      ))}
    </div>
  );
}
