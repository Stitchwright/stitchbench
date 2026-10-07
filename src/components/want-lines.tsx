// Want list lines (shop-features-round-2-design.md 1.4), on a customer's page or the Want lists page: what she wants,
// "Here now" with the item when something matching came in, "Let her know" (one tap: the message) and "Done".
import Link from "next/link";
import { fmtDate } from "@/lib/format";
import { qtyText } from "@/lib/register-math";
import type { WantView } from "@/lib/want-lists";
import { doneWant, tellWant } from "@/actions/want-lists";
import { ActionButton } from "@/components/action-form";

export function WantLines({ rows, tz, showCustomer }: { rows: WantView[]; tz: string; showCustomer: boolean }) {
  return (
    <ul className="divide-y divide-line text-base">
      {rows.map((w) => (
        <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span>
            {showCustomer && (
              <>
                <Link href={`/customers/${w.customer.id}`} className="link font-semibold">
                  {w.customer.name}
                </Link>
                :{" "}
              </>
            )}
            {w.what}
            {w.note && <span className="muted"> ({w.note})</span>}
            {w.here ? (
              <span className="block">
                <span className="pill tone-ready mr-1">Here now</span>
                <Link href={`/parts/${w.here.partId}`} className="link">
                  {w.here.description}
                </Link>
                <span className="muted text-sm">
                  {" "}
                  · {qtyText(Math.max(0, w.here.qtyOnHand), null)} on the shelf
                  {w.toldAt ? ` · told ${fmtDate(w.toldAt, tz)}` : ""}
                </span>
              </span>
            ) : (
              <span className="muted block text-sm">Watching since {fmtDate(w.createdAt, tz)}</span>
            )}
          </span>
          <span className="flex flex-wrap gap-2">
            {w.here && !w.toldAt && (
              <ActionButton action={tellWant.bind(null, w.id, w.customer.id)} className="btn btn-primary min-h-11">
                Let her know
              </ActionButton>
            )}
            <ActionButton action={doneWant.bind(null, w.id, w.customer.id)} className="btn min-h-11" success="Taken off her list">
              Done
            </ActionButton>
          </span>
        </li>
      ))}
    </ul>
  );
}
