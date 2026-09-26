import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money, ticketNo } from "@/lib/format";
import { acceptedBoth, CUSTOMERS_PAY_LABEL, normalizeTerms, type Accepted } from "@/lib/partner-terms";
import { monthPeriod, statementFor } from "@/lib/partners";
import { PageHeader, Section, Empty, KV, JobStatusPill, OrderStatusPill } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { endPartner } from "@/actions/partners";

export default async function PartnerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId: user.shopId, id } } });
  if (!link) notFound();
  const terms = normalizeTerms(link.terms);
  const accepted = (link.accepted as Accepted) ?? {};
  const agreed = acceptedBoth(accepted, link.termsVersion);
  const iAccepted = accepted[link.side as "repair" | "retail"]?.version === link.termsVersion;
  const repairSide = link.side === "repair";
  const tz = (await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true } })).timeZone;
  const { from, to, month } = monthPeriod(null, tz);
  const [jobs, orders, consign, st] = await Promise.all([
    db.repairJob.findMany({ where: { shopId: user.shopId, linkId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.partnerOrder.findMany({ where: { shopId: user.shopId, linkId: id }, orderBy: { createdAt: "desc" }, take: 30 }),
    db.consignItem.findMany({ where: { shopId: user.shopId, linkId: id } }),
    statementFor(user.shopId, id, from, to),
  ]);
  const onShelf = consign.reduce((a, c) => a + (c.placed - c.sold - c.returned) * c.priceCents, 0);
  const balance = st.balanceCents;

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/partners", label: "Partners" }}
        title={link.partnerName}
        sub={`${repairSide ? "Sewing shop partner" : "Your repair shop"} since ${fmtDate(link.createdAt)}${link.status === "ENDED" ? " · partnership ended" : ""}`}
        actions={
          <>
            <Link href={`/partners/${id}/agreement`} className="btn">
              Agreement
            </Link>
            <Link href={`/partners/${id}/statement?month=${month}`} className="btn">
              Statement
            </Link>
            <Link href={`/partners/${id}/consignment`} className="btn">
              Consignment
            </Link>
            {!repairSide && (
              <>
                <Link href={`/partners/${id}/order`} className="btn">
                  Order parts and notions
                </Link>
                <Link href="/repairs/new" className="btn btn-primary">
                  Take in a machine
                </Link>
              </>
            )}
          </>
        }
      />

      {!agreed && (
        <p className="card card-pad text-sm" role="status">
          {iAccepted ? `Waiting for ${link.partnerName} to accept the terms.` : "The terms aren't accepted by you yet."}{" "}
          <Link href={`/partners/${id}/agreement`} className="link">
            Read and accept the agreement
          </Link>
        </p>
      )}
      {link.proposedTerms && link.proposedBy !== link.side && (
        <p className="card card-pad text-sm" role="status">
          {link.partnerName} proposed a change to the terms.{" "}
          <Link href={`/partners/${id}/agreement`} className="link">
            Review it
          </Link>
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card card-pad">
          <KV k="Commission on repairs" v={`${terms.repairCommissionPct}% to the sewing shop`} />
        </div>
        <div className="card card-pad">
          <KV k="Customers pay" v={CUSTOMERS_PAY_LABEL[terms.customersPay]} />
        </div>
        <div className="card card-pad">
          <KV k="Consigned stock on the shelf" v={`${money(onShelf)} at shelf price`} />
        </div>
        <div className="card card-pad">
          <KV
            k="Balance"
            v={
              balance === 0 ? (
                "Settled"
              ) : (
                <span className="font-semibold">
                  {balance > 0 ? (repairSide ? `${link.partnerName} owes you` : `You owe ${link.partnerName}`) : repairSide ? `You owe ${link.partnerName}` : `${link.partnerName} owes you`}{" "}
                  {money(Math.abs(balance))}
                </span>
              )
            }
          />
        </div>
      </div>

      <Section title="Machines" actions={!repairSide ? <Link href="/repairs" className="link text-sm">All repairs</Link> : undefined}>
        {jobs.length === 0 ? (
          <Empty>{repairSide ? `No machines from ${link.partnerName} yet.` : "No machines sent yet."}</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>{repairSide ? "Ticket" : "Customer"}</th>
                  <th>Machine</th>
                  <th>Status</th>
                  <th className="text-right">Bill</th>
                  <th>In</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="mono">{repairSide ? j.tag : <Link href={`/repairs/${j.id}`} className="link">{j.tag}</Link>}</td>
                    <td>
                      {repairSide && j.ticketId ? (
                        <Link href={`/tickets/${j.ticketId}`} className="link mono">
                          #{ticketNo(j.ticketNumber ?? 0)}
                        </Link>
                      ) : (
                        j.customerName
                      )}
                    </td>
                    <td>
                      {j.brand} {j.model}
                    </td>
                    <td>
                      <JobStatusPill status={j.status} side={link.side} />
                      {j.paidAt && <span className="pill tone-done ml-1">paid</span>}
                    </td>
                    <td className="num text-right">{money(j.totalCents)}</td>
                    <td>{fmtDate(j.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Orders">
        {orders.length === 0 ? (
          <Empty>{repairSide ? "No orders from this shop yet." : "No orders yet."}</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <Link href={`/partners/${id}/orders/${o.id}`} className="link mono">
                    {o.number}
                  </Link>{" "}
                  · {fmtDate(o.createdAt)} · {(o.lines as unknown[]).length} items
                </span>
                <span className="flex items-center gap-2">
                  <OrderStatusPill status={o.status} />
                  <span className="num">{money(o.totalCents)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {user.role !== "TECH" && link.status === "ACTIVE" && (
        <Section title="End the partnership">
          <ActionForm action={endPartner.bind(null, id)} className="flex flex-wrap items-end gap-2" success="Partnership ended">
            <div className="field min-w-64 flex-1">
              <label htmlFor="note" className="label">
                Note for {link.partnerName} (optional)
              </label>
              <input id="note" name="note" className="input" />
            </div>
            <Submit className="btn btn-danger">End partnership</Submit>
          </ActionForm>
          <p className="muted mt-2 text-xs">
            Both shops keep their records. Settle the last statement and return any consigned stock ({terms.noticeDays} days&apos; notice, per the agreement).
          </p>
        </Section>
      )}
    </div>
  );
}
