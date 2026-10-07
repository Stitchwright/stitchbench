// One approval the register asked the owner for (shop-features-round-2-design.md 7.5): the link in her email. She signs
// in, sees the sale and the reason, and taps Approve or Not this time; the register moves on by itself.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { approvalView } from "@/lib/approvals";
import { storeOfRow } from "@/lib/stores";
import { fmtDateTime, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { decideApproval } from "@/actions/stores";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { PageHeader } from "@/components/ui";

const STATUS_WORDS: Record<string, string> = { APPROVED: "Approved", REFUSED: "Not this time", EXPIRED: "Ran out (the register can ask again)", USED: "Approved and used" };

export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const a = await approvalView(user.shopId, id);
  if (!a) notFound();
  const [store, tz] = await Promise.all([storeOfRow(user.shopId, a.storeId), shopTimeZone(user.shopId)]);
  const open = a.status === "ASKED" && a.expiresAt > new Date();
  return (
    <div className="max-w-xl space-y-4">
      <PageHeader title={`Approve ${a.words}?`} back={{ href: "/today", label: "Today" }} sub={`${a.askedBy ?? "Someone"}${store ? ` at ${store.name}` : ""}, ${fmtDateTime(a.at, tz)}`} />
      {a.reason && <p className="card card-pad text-base">&ldquo;{a.reason}&rdquo;</p>}
      {a.draft.lines.length > 0 && (
        <div className="card card-pad">
          <ul className="space-y-1 text-base">
            {a.draft.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>
                  {l.qty !== 1 ? `${l.qty} × ` : ""}
                  {l.description}
                </span>
                <span className="num">
                  {money(Math.round(l.qty * l.unitPriceCents))}
                  {l.discountCents ? ` less ${money(l.discountCents)}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {a.draft.totalCents != null && <p className="mt-2 text-right text-lg font-semibold">Total {money(a.draft.totalCents)}</p>}
          {a.draft.customer && <p className="muted text-sm">For {a.draft.customer}</p>}
        </div>
      )}
      {open ? (
        user.role === "OWNER" ? (
          <div className="space-y-3">
            <ActionButton action={decideApproval.bind(null, a.id, true)} className="btn btn-primary btn-lg w-full" success="Approved: the register goes on">
              Approve
            </ActionButton>
            <ActionForm action={decideApproval.bind(null, a.id, false)} success="They'll see Not this time" className="space-y-2">
              <label htmlFor="appr-note" className="label">
                Not this time (a word for them, optional)
              </label>
              <input id="appr-note" name="note" className="input" placeholder="Offer store credit instead" />
              <Submit className="btn w-full">Not this time</Submit>
            </ActionForm>
          </div>
        ) : (
          <p className="text-base">Waiting for the owner.</p>
        )
      ) : (
        <p className="pill tone-neutral inline-block text-base">{STATUS_WORDS[a.status] ?? a.status}</p>
      )}
      <Link href="/today" className="link text-sm">
        Today at every store
      </Link>
    </div>
  );
}
