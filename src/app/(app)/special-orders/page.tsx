// Special orders and pre-orders (shop-features-round-2-design.md 1.2) in three tabs: waiting for the supplier (not
// ordered yet first, with "Order them"), here (waiting for the customer; the ones to call and the ones here too long
// marked), and done. Taken at the register ("Special order") or from a customer's page.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { qtyText } from "@/lib/register-math";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtYmdLong } from "@/lib/units/units";
import { specialOrderCounts, specialOrderDepositsHeld, specialOrdersFor, type Tab } from "@/lib/special-orders";
import { orderSpecialOrders } from "@/actions/special-orders";
import { ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader } from "@/components/ui";

const TABS: { key: Tab; label: string }[] = [
  { key: "waiting", label: "Waiting for the supplier" },
  { key: "here", label: "Here" },
  { key: "done", label: "Done" },
];

export default async function SpecialOrders({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "waiting";
  const [rows, counts, held, tz] = await Promise.all([specialOrdersFor(user.shopId, { tab }), specialOrderCounts(user.shopId), specialOrderDepositsHeld(user.shopId), shopTimeZone(user.shopId)]);
  const notOrdered = rows.filter((r) => r.status === "WAITING");
  return (
    <div className="space-y-4">
      <PageHeader
        title="Special orders"
        sub="Things customers asked for that aren't on the shelf, and pre-orders of coming-soon items. Take one at the register: Special order."
        back={{ href: "/register", label: "Register" }}
        actions={
          <Link href="/want-lists" className="btn min-h-11">
            Want lists
          </Link>
        }
      />
      <p className="text-base">
        Deposits held for customers: <span className="num font-semibold">{money(held)}</span>
      </p>
      <div className="flex flex-wrap gap-2" role="navigation" aria-label="Special orders">
        {TABS.map((t) => (
          <Link key={t.key} href={`/special-orders?tab=${t.key}`} className={`btn min-h-11 ${tab === t.key ? "btn-primary" : ""}`}>
            {t.label}
            {t.key === "waiting" && counts.waiting + counts.ordered > 0 ? ` (${counts.waiting + counts.ordered})` : ""}
            {t.key === "here" && counts.here > 0 ? ` (${counts.here})` : ""}
          </Link>
        ))}
      </div>
      {tab === "waiting" && notOrdered.length > 0 && (
        <ActionForm action={orderSpecialOrders} className="card card-pad flex flex-wrap items-center justify-between gap-3 text-base">
          {notOrdered.map((r) => (
            <input key={r.id} type="hidden" name="id" value={r.id} />
          ))}
          <span>
            {notOrdered.length} not ordered yet. Put {notOrdered.length === 1 ? "it" : "them"} on {notOrdered.length === 1 ? "its supplier's" : "their suppliers'"} next order?
          </span>
          <Submit className="btn btn-primary min-h-11">Order {notOrdered.length === 1 ? "it" : "them"}</Submit>
        </ActionForm>
      )}
      {tab === "here" && counts.call > 0 && (
        <p className="card card-pad text-base">
          <span className="pill tone-wait mr-2">Call these</span>
          {counts.call} {counts.call === 1 ? "customer takes" : "customers take"} no messages (or Marketing is off): call {counts.call === 1 ? "her" : "them"} and mark it called.
        </p>
      )}
      {rows.length === 0 ? (
        <Empty>
          {tab === "waiting"
            ? "No special orders yet. When a customer wants something you don't have, tap Special order at the register."
            : tab === "here"
              ? "Nothing waiting for a customer."
              : "None done yet."}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="card card-pad flex flex-wrap items-baseline justify-between gap-2 text-base">
              <span>
                <Link href={`/special-orders/${r.id}`} className="link font-semibold">
                  {r.kind === "PREORDER" ? "Pre-order" : "Special order"} {r.number}
                </Link>{" "}
                {r.customer ? (
                  <Link href={`/customers/${r.customer.id}`} className="link">
                    {r.customer.name}
                  </Link>
                ) : null}
                <span className="block">
                  {r.description}
                  {r.qty !== 1 ? ` x ${qtyText(r.qty, r.unit)}` : ""}
                </span>
                <span className="muted block text-sm">
                  {r.statusWords}
                  {r.expectedOn && (r.status === "WAITING" || r.status === "ORDERED") ? `, expected ${fmtYmdLong(r.expectedOn)}` : ""}
                  {r.hereAt && r.status === "HERE" ? `, here since ${fmtDate(r.hereAt, tz)}` : ""}
                  {r.status === "HERE" && !r.noticedAt && !r.calledAt ? ", not told yet" : ""}
                </span>
              </span>
              <span className="text-right">
                <span className="num block">{money(r.owedCents)}</span>
                {r.status !== "DONE" && r.status !== "CANCELLED" && <span className="muted block text-sm">{r.leftCents > 0 ? `${money(r.leftCents)} left` : "paid in full"}</span>}
                {r.late && <span className="pill tone-wait">Not picked up after {counts.days} days</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
