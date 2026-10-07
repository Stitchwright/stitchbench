import { HistoryLink } from "@/components/history-link";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money, ticketNo } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";
import { ticketTotals } from "@/lib/ticket-math";
import { ORDER_STATUS_LABEL, type OrderStatus } from "@/lib/shop/online-shop";
import { PageHeader, Section, StatusPill, Empty } from "@/components/ui";
import { CustomerForm } from "@/components/customer-form";
import { CustomerMessages } from "@/components/customer-messages";
import { CustomerClassesSlot } from "@/components/slots/customer-classes";
import { CustomerAppointmentsSlot } from "@/components/slots/customer-appointments";
import { gateFor } from "@/lib/module-gate";
import { saveCustomer } from "@/actions/records";
import { CustomerMergePanel, type MergeParams } from "@/components/merge-panel";
import { firstValues } from "@/lib/search-params";
import { ordersOfCustomer } from "@/lib/longarm";
import { STATUS_LABEL as LONGARM_STATUS } from "@/lib/longarm-math";
import { CertifyButton } from "@/components/longarm-forms";
import { StoreCreditSection } from "@/components/store-credit-section";
import { classCreditsFor } from "@/lib/units/units";
import { CustomerLayaways } from "@/components/customer-layaways";
import { CustomerColors } from "@/components/customer-colors";
import { CustomerFitsSection } from "@/components/customer-fits";

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<MergeParams> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const { id } = await params;
  const sp = firstValues(await searchParams);
  const c = await db.customer.findFirst({
    where: { id, shopId: user.shopId },
    include: {
      machines: { orderBy: { createdAt: "desc" } },
      tickets: { where: { shopId: user.shopId }, orderBy: { intakeAt: "desc" }, include: { machine: true, lines: true, payments: true } },
      viaTickets: { where: { shopId: user.shopId }, orderBy: { intakeAt: "desc" }, include: { machine: true, customer: true, lines: true, payments: true } },
    },
  });
  if (!c) notFound();
  // Machines from a partner sewing shop earn it the partnership's commission (as billed on the statement).
  const partnerCommission = new Map(
    (await db.repairJob.findMany({ where: { shopId: user.shopId, side: "repair", ticketId: { in: c.viaTickets.map((t) => t.id) } }, select: { ticketId: true, commissionCents: true } })).map(
      (j) => [j.ticketId!, j.commissionCents],
    ),
  );
  // The customer's online orders, newest first (WebOrder.customerId is a plain column, so its own query).
  const orders = await db.webOrder.findMany({
    where: { shopId: user.shopId, customerId: c.id },
    orderBy: [{ createdAt: "desc" }, { number: "desc" }],
    select: { id: true, number: true, status: true, fulfil: true, totalCents: true, createdAt: true },
  });
  const quilts = await ordersOfCustomer(user.shopId, c.id);
  const shopRow = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  const tickets = c.kind === "TRADE" ? c.viaTickets : c.tickets;
  const owed = tickets.reduce((s, t) => s + Math.max(0, ticketTotals(t.lines, t.payments, t.taxRatePct).balance), 0);
  const commission =
    c.kind === "TRADE"
      ? c.viaTickets.filter((t) => t.status === "COLLECTED").reduce((s, t) => s + ticketTotals(t.lines, t.payments, t.taxRatePct, t.tradeCommissionPct ?? c.commissionPct, partnerCommission.get(t.id)).commission, 0)
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><HistoryLink role={user.role} type="Customer" id={c.id} /></div>
      <PageHeader
        back={{ href: "/customers", label: "Customers" }}
        title={c.name}
        sub={
          <>
            {c.kind === "TRADE" ? `Shop account ${c.code ?? ""}${c.routeDay ? ` · route day ${c.routeDay}` : ""}` : "Retail customer"}
            {owed > 0 && ` · ${money(owed)} owed`}
            {commission > 0 && ` · ${money(commission)} commission earned on collected tickets`}
          </>
        }
        actions={
          c.kind === "RETAIL" ? (
            <>
              {shopRow.sellsRetail && (
                <Link href={`/register/pay-links?customer=${c.id}`} className="btn">
                  Send a pay link
                </Link>
              )}
              <Link href={`/tickets/new?customerId=${c.id}`} className="btn btn-primary">
                Check in a machine
              </Link>
            </>
          ) : undefined
        }
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title={c.kind === "TRADE" ? "Tickets through this shop" : "Tickets"}>
          {tickets.length === 0 ? (
            <Empty>No tickets yet.</Empty>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {tickets.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex items-center gap-2">
                    <Link href={`/tickets/${t.id}`} className="link mono">
                      #{ticketNo(t.number)}
                    </Link>
                    {t.machine.brand} {t.machine.model}
                    {"customer" in t && t.customer ? <span className="muted">({(t.customer as { name: string }).name})</span> : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="num muted">{fmtDate(t.intakeAt, tz)}</span>
                    <StatusPill status={t.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        {c.kind === "RETAIL" && (
          <Section title="Machines">
            {c.machines.length === 0 ? (
              <Empty>None on file.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {c.machines.map((m) => (
                  <li key={m.id} className="py-2">
                    <Link href={`/machines/${m.id}`} className="link">
                      {m.brand} {m.model}
                    </Link>{" "}
                    {m.serial && <span className="mono muted">SN {m.serial}</span>}
                  </li>
                ))}
              </ul>
            )}
            {(await classCreditsFor(user.shopId, c.id)).map((x) => (
              <p key={x.unitId} className="mt-2 text-sm">
                <span className={`pill ${x.left ? "tone-ready" : "tone-neutral"}`}>
                  Owner&apos;s classes: {x.left} of {x.granted} left
                </span>{" "}
                <span className="muted">came with the {x.machine}; book them from a class&apos;s sign-up list</span>
              </p>
            ))}
          </Section>
        )}
        {c.kind === "RETAIL" && <CustomerLayaways shopId={user.shopId} customerId={c.id} />}
        {c.kind === "RETAIL" && shopRow.sellsRetail && <CustomerColors shopId={user.shopId} customerId={c.id} />}
        {c.kind === "RETAIL" && shopRow.sellsRetail && <CustomerFitsSection shopId={user.shopId} customerId={c.id} />}
        {c.kind === "RETAIL" && <StoreCreditSection shopId={user.shopId} role={user.role} customerId={c.id} timeZone={tz} />}
        {orders.length > 0 && (
          <Section title="Online orders">
            <ul className="divide-y divide-line text-sm">
              {orders.map((o) => {
                const status = o.status as OrderStatus;
                // Paid and ready orders are on the staff page's to-do list; the rest show under "Show all".
                const href = status === "PAID" || status === "READY" ? "/register/online" : "/register/online?all=1";
                return (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="flex items-center gap-2">
                      <Link href={href} className="link mono">
                        #{o.number}
                      </Link>
                      <span className="pill">{ORDER_STATUS_LABEL[status] ?? o.status}</span>
                      <span className="muted">{o.fulfil === "ship" ? "Ship" : "Pickup"}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="num">{money(o.totalCents)}</span>
                      <span className="num muted">{fmtWhen(o.createdAt, tz)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}
        {(quilts.length > 0 || (shopRow.sellsRetail && c.kind === "RETAIL")) && (
          <Section title="Longarm">
            {shopRow.sellsRetail && c.kind === "RETAIL" && (
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                {c.longarmCertifiedAt ? <span className="pill tone-ready">Certified to rent since {fmtDate(c.longarmCertifiedAt, tz)}</span> : <span className="pill tone-neutral">Not certified to rent the longarm</span>}
                {user.role !== "TECH" && <CertifyButton customerId={c.id} certified={!!c.longarmCertifiedAt} />}
              </div>
            )}
            {quilts.length === 0 ? (
              <Empty>No quilting work orders.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {quilts.map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="flex items-center gap-2">
                      <Link href={`/longarm/${q.id}`} className="link mono">
                        #{q.number}
                      </Link>
                      {q.widthIn} x {q.lengthIn} in
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="num">{money(q.totalCents)}</span>
                      <span className="num muted">{q.dueAt ? `due ${fmtDate(q.dueAt, tz)}` : fmtDate(q.receivedAt, tz)}</span>
                      <span className="pill">{LONGARM_STATUS[q.status]}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
        <CustomerClassesSlot customerId={c.id} user={user} />
        <CustomerAppointmentsSlot customerId={c.id} user={user} />
        <Section title="Details">
          <CustomerForm action={saveCustomer.bind(null, c.id)} customer={{ ...c, taxExemptUntil: c.taxExemptUntil?.toISOString().slice(0, 10) ?? null }} taxFields={user.role !== "TECH"} submitLabel="Save" marketingHidden={(await gateFor(user.shopId, "marketing")) === "hidden"} />
        </Section>
        <CustomerMessages customerId={c.id} user={user} />
        <CustomerMergePanel user={user} customer={{ id: c.id, name: c.name }} sp={sp} />
      </div>
    </div>
  );
}
