// The StitchFoundry inbox on /decorating (docs/plans/decorators-proposal.md): files a designer sent from StitchFoundry through the
// Foundry Account, waiting on the hub. Each can go on an open order as a decoration, or start a new order (the page's "Take an order" form).
import Link from "next/link";
import { takeInboxIntoOrder } from "@/actions/decorating";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";
import { PLACEMENTS } from "@/lib/decor-math";
import type { InboxItem, InboxView } from "@/lib/decor-inbox";

const facts = (i: InboxItem) => {
  const m = i.meta;
  return [m.stitches != null ? `${m.stitches.toLocaleString("en-US")} stitches` : "", m.colors ? `${m.colors} ${m.colors === 1 ? "colour" : "colours"}` : "", m.widthMm != null && m.heightMm != null ? `${m.widthMm} × ${m.heightMm} mm` : "", m.hoop ? `hoop ${m.hoop}` : "", m.fabric ?? "", i.preview ? "with a preview picture" : "", `${Math.max(1, Math.round(i.size / 1024))} KB`].filter(Boolean).join(" · ");
};

export function InboxSection({ view, orders }: { view: InboxView; orders: { id: string; number: number; title: string }[] }) {
  if (view.state === "not-joined" || view.state === "not-offered") return null;
  if (view.state === "offline") {
    return (
      <Section title="From StitchFoundry">
        <p className="muted text-sm">The hub can&apos;t be reached just now, so files sent from StitchFoundry can&apos;t be listed. Try again in a minute.</p>
      </Section>
    );
  }
  if (view.state === "not-linked") {
    return (
      <Section title="From StitchFoundry">
        <p className="muted text-sm">To receive files sent from StitchFoundry, tie this shop to your StitchHub account (Settings, Foundry Account), then send a design from StitchFoundry to your shop.</p>
      </Section>
    );
  }
  return (
    <Section title={`From StitchFoundry (${view.items.length})`}>
      {view.items.length === 0 ? (
        <p className="muted text-sm">Nothing waiting. A design sent from StitchFoundry to this shop appears here for 30 days.</p>
      ) : (
        <ul className="divide-y divide-line">
          {view.items.map((i) => (
            <li key={i.id} className="space-y-2 py-3">
              <div className="text-base">
                <span className="font-medium">{i.fileName}</span>
                {i.meta.design ? <span className="muted text-sm"> · {i.meta.design}</span> : null}
                {i.meta.job ? <span className="muted text-sm"> · job {i.meta.job}</span> : null}
                {i.meta.customer ? <span className="muted text-sm"> · for {i.meta.customer}</span> : null}
                <p className="muted text-sm">{facts(i)}</p>
                {i.meta.notes ? <p className="muted text-sm">{i.meta.notes}</p> : null}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                {orders.length > 0 && (
                  <ActionForm action={takeInboxIntoOrder.bind(null, i.id)} className="flex flex-wrap items-end gap-2">
                    <div className="field">
                      <label className="label" htmlFor={`ib-order-${i.id}`}>
                        Add it to
                      </label>
                      <select id={`ib-order-${i.id}`} name="orderId" className="select" defaultValue="">
                        <option value="" disabled>
                          Pick an order
                        </option>
                        {orders.map((o) => (
                          <option key={o.id} value={o.id}>
                            #{o.number} {o.title}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label className="label" htmlFor={`ib-loc-${i.id}`}>
                        Where it goes
                      </label>
                      <input id={`ib-loc-${i.id}`} name="location" list="decor-places-inbox" className="input" maxLength={40} defaultValue={i.meta.placement ?? "Left chest"} />
                    </div>
                    <Submit className="btn">Add to the order</Submit>
                  </ActionForm>
                )}
                <Link href={`/decorating?inbox=${encodeURIComponent(i.id)}#take`} className="btn">
                  Start a new order with it
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      <datalist id="decor-places-inbox">
        {PLACEMENTS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </Section>
  );
}
