// Pay links (shop-features-round-2-design.md 1.3): send a customer a link to pay by card, and the links sent (waiting
// for her, paid, ran out, taken back). A paid link is an online order (paid, then picked up) and a sale in the books.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";
import { fmtWhen } from "@/lib/zoned";
import { payLinkProblem, payLinksFor, payLinkWords } from "@/lib/pay-links";
import { cancelPayLink, resendPayLink } from "@/actions/pay-links";
import { ActionButton } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { PayLinkForm } from "@/components/pay-link-form";
import { Empty, PageHeader } from "@/components/ui";

export default async function PayLinks({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const [shop, problem, links, customer] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true, taxRatePct: true } }),
    payLinkProblem(user.shopId),
    payLinksFor(user.shopId),
    sp.customer ? db.customer.findFirst({ where: { id: sp.customer, shopId: user.shopId }, select: { id: true, name: true, phone: true } }) : null,
  ]);
  const admin = user.role !== "TECH";
  return (
    <div className="space-y-6">
      <PageHeader
        title="Pay links"
        sub="Send a customer a link to pay by card: a balance, a deposit, anything. Paid, it shows under Online orders."
        actions={
          <Link href="/register/online" className="btn">
            Online orders
          </Link>
        }
      />
      {problem ? (
        <p className="card card-pad text-base">
          {problem}{" "}
          {admin && (
            <Link href="/settings/shop" className="link">
              Open Settings, Online shop
            </Link>
          )}
        </p>
      ) : admin ? (
        <PayLinkForm customer={customer} taxRatePct={shop.taxRatePct} />
      ) : (
        <p className="card card-pad text-base">Only an owner or admin can type the amounts on a pay link. Special orders send their own.</p>
      )}
      <section className="space-y-3">
        <h2 className="h2">Links sent</h2>
        {links.length === 0 ? (
          <Empty>No pay links yet. When a customer will pay from home, send her one here.</Empty>
        ) : (
          <ul className="space-y-3">
            {links.map((l) => (
              <li key={l.id} className="card card-pad space-y-2 text-base">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="font-semibold">#{l.number}</span>{" "}
                    {l.customer ? (
                      <Link href={`/customers/${l.customer.id}`} className="link">
                        {l.customer.name}
                      </Link>
                    ) : null}{" "}
                    <span className={`pill ${l.status === "PENDING" ? "tone-wait" : l.status === "CANCELLED" ? "tone-neutral" : "tone-ok"}`}>{payLinkWords(l)}</span>
                  </span>
                  <span className="num text-lg font-semibold">{money(l.totalCents)}</span>
                </div>
                <ul className="muted text-sm">
                  {l.items.map((it, i) => (
                    <li key={i}>
                      {it.description}
                      {it.qty !== 1 ? ` x ${qtyText(it.qty, it.unit)}` : ""} {money(Math.round(it.qty * it.unitPriceCents))}
                    </li>
                  ))}
                </ul>
                <p className="muted text-sm">
                  Sent {fmtWhen(l.createdAt, shop.timeZone)}
                  {l.status === "PENDING" && l.expiresAt ? `, works until ${fmtWhen(l.expiresAt, shop.timeZone)}` : ""}
                  {l.paidAt ? `, paid ${fmtWhen(l.paidAt, shop.timeZone)}` : ""}
                </p>
                {l.status === "PENDING" && (
                  <div className="flex flex-wrap gap-2">
                    {l.link && <CopyButton text={l.link} label="Copy the link" />}
                    <ActionButton action={resendPayLink.bind(null, l.id)} className="btn btn-sm min-h-11">
                      Send it again
                    </ActionButton>
                    <ActionButton action={cancelPayLink.bind(null, l.id)} className="btn btn-sm min-h-11" confirm="Tap again to take it back" success="Taken back. She can't pay it now.">
                      Take it back
                    </ActionButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
