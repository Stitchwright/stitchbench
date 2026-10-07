// Coming in (shop-features-round-2-design.md 4.4): every line still to come on orders sent to suppliers, back orders
// first with the day each is expected and who is waiting for it (repair tickets waiting for the part); "Let them know"
// tells them it's delayed. A line is marked back ordered on its order's page.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { comingIn } from "@/lib/backorders";
import { fmtYmdLong } from "@/lib/units/units";
import { letThemKnow } from "@/actions/repricing";
import { ActionButton } from "@/components/action-form";
import { Empty, PageHeader } from "@/components/ui";

export default async function ComingIn() {
  const user = await requireUser();
  const rows = await comingIn(user.shopId);
  const back = rows.filter((r) => r.backordered).length;
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Coming in"
        sub={`${rows.length} line${rows.length === 1 ? "" : "s"} still to come from suppliers${back ? `, ${back} back ordered` : ""}. Mark a line back ordered on its order's page.`}
        back={{ href: "/parts/orders", label: "Orders to suppliers" }}
      />
      {rows.length === 0 ? (
        <Empty>Nothing is on its way. When you send an order to a supplier, what&apos;s on it shows here until it comes in.</Empty>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.lineId} className="card card-pad space-y-2 text-base">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  {r.partId ? (
                    <Link href={`/parts/${r.partId}`} className="link mono">
                      {r.itemNumber}
                    </Link>
                  ) : (
                    <span className="mono">{r.itemNumber}</span>
                  )}{" "}
                  {r.description}
                </span>
                {r.backordered ? (
                  <span className="pill tone-wait">Back ordered{r.expectedOn ? `, expected ${fmtYmdLong(r.expectedOn)}` : ""}</span>
                ) : (
                  <span className="pill tone-work">On its way</span>
                )}
              </div>
              <p className="muted text-sm">
                {r.stillToCome} still to come ({r.ordered} ordered) on{" "}
                <Link href={`/parts/orders/${r.orderId}`} className="link">
                  order #{r.orderNumber}
                </Link>{" "}
                to {r.supplier}
              </p>
              {r.waiting.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    Waiting:{" "}
                    {r.waiting.map((w, i) => (
                      <span key={w.ticketId}>
                        {i > 0 ? ", " : ""}
                        <Link href={`/tickets/${w.ticketId}`} className="link">
                          {w.name} ({w.ticketNumber})
                        </Link>
                      </span>
                    ))}
                  </span>
                  {r.backordered && r.expectedOn && (
                    <ActionButton action={letThemKnow.bind(null, r.lineId)} className="btn btn-sm min-h-11">
                      Let them know
                    </ActionButton>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
