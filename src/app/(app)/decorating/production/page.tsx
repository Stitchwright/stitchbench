// The production list (docs/plans/decorators-proposal.md, package D4): orders that are approved or in production, soonest due
// first, with the machine time each needs at the shop's set speed, and the total queued.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { productionFor } from "@/lib/decor";
import { DECOR_TONE, decorStatusLabel, formatMinutes } from "@/lib/decor-math";
import { Empty, Section } from "@/components/ui";
import { DecorFrame, decorPageState } from "@/components/decorating/decor-page";

export default async function DecorProductionPage() {
  const user = await requireUser();
  const [s, prod, tz] = await Promise.all([decorPageState(user, true), productionFor(user.shopId), shopTimeZone(user.shopId)]);
  return (
    <DecorFrame
      title="Production list"
      what="The production list"
      sub="Approved orders and orders in production, soonest due first, with the machine time each needs at the speed set in your prices."
      actions={
        <Link href="/decorating" className="btn">
          All orders
        </Link>
      }
      {...s}
    >
      <Section title={`In the queue (${prod.rows.length})`}>
        {prod.rows.length ? (
          <>
            <ul className="divide-y divide-line">
              {prod.rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-base">
                    <Link href={`/decorating/${r.id}`} className="link">
                      #{r.number} {r.title}
                    </Link>{" "}
                    <span className="muted text-sm">
                      · {r.name} · {r.pieces} {r.pieces === 1 ? "piece" : "pieces"} · {r.placements} {r.placements === 1 ? "decoration" : "decorations"}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-base">
                    <span className="num">{formatMinutes(r.minutes)}</span>
                    {r.dueAt && <span className={r.overdue ? "pill tone-bad" : "muted text-sm"}>{r.overdue ? "late: " : "by "}{fmtDate(r.dueAt, tz)}</span>}
                    <span className={`pill ${DECOR_TONE[r.status] ?? ""}`}>{decorStatusLabel(r.status)}</span>
                    <Link href={`/decorating/${r.id}/print`} className="btn btn-sm" target="_blank">
                      Worksheet
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-base font-semibold">
              Machine time queued: {formatMinutes(prod.totalMinutes)}
              {prod.lateCount > 0 ? ` · ${prod.lateCount} ${prod.lateCount === 1 ? "order is" : "orders are"} late` : ""}
            </p>
            <p className="muted text-sm">Time is stitches at your set machine speed plus colour changes, for every decoration on every piece. It does not count hooping, trimming or the garments&apos; handling.</p>
          </>
        ) : (
          <Empty>Nothing in the queue. An order appears here once the customer has approved it.</Empty>
        )}
      </Section>
    </DecorFrame>
  );
}
