import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { startOfMonth } from "@/lib/time-zone";
import { shopTimeZone } from "@/lib/shop-zone";
import { PageHeader, Section, Empty, JobStatusPill } from "@/components/ui";

const GROUPS: { title: string; statuses: string[] }[] = [
  { title: "Needs the customer's OK", statuses: ["WAITING_CUSTOMER_OK"] },
  { title: "Ready for the customer", statuses: ["READY_FOR_PICKUP", "READY_IN_TRUCK"] },
  { title: "Here, waiting for the repair shop", statuses: ["AT_SHOP_AWAITING_PICKUP"] },
  { title: "At the repair shop", statuses: ["IN_TRUCK", "ON_BENCH", "WAITING_PARTS"] },
];
const DONE = ["COLLECTED", "ABANDONED", "RETURNED_UNREPAIRED"];

/** The sewing shop's view of every machine it took in: where each one is, and what the customer owes. */
export default async function Repairs() {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const jobs = await db.repairJob.findMany({
    where: { shopId: user.shopId, side: "retail" },
    include: { customer: { select: { name: true, phone: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const partners = new Map((await db.partnerLink.findMany({ where: { shopId: user.shopId } })).map((l) => [l.id, l.partnerName]));
  const open = jobs.filter((j) => !DONE.includes(j.status) || (j.status === "RETURNED_UNREPAIRED" && !j.pickedUpAt));
  const done = jobs.filter((j) => !open.includes(j)).slice(0, 50);
  const commission = jobs.filter((j) => j.paidAt && j.paidAt >= startOfMonth(tz)).reduce((a, j) => a + (j.commissionCents ?? 0), 0);

  const table = (list: typeof jobs) => (
    <div className="scroll-x">
      <table className="table">
        <thead>
          <tr>
            <th>Tag</th>
            <th>Customer</th>
            <th>Machine</th>
            <th>Status</th>
            <th className="text-right">Bill</th>
            <th>In</th>
          </tr>
        </thead>
        <tbody>
          {list.map((j) => (
            <tr key={j.id}>
              <td className="mono">
                <Link href={`/repairs/${j.id}`} className="link font-semibold">
                  {j.tag}
                </Link>
              </td>
              <td>
                {j.customer?.name ?? j.customerName} <span className="muted text-xs">{j.customer?.phone}</span>
              </td>
              <td>
                {j.brand} {j.model}
                <div className="muted text-xs">{partners.get(j.linkId)}</div>
              </td>
              <td>
                <JobStatusPill status={j.status} side="retail" />
                {j.paidAt && <span className="pill tone-done ml-1">paid</span>}
              </td>
              <td className="num text-right">{money(j.totalCents)}</td>
              <td>{fmtDate(j.createdAt, tz)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Repairs"
        sub={`${open.length} machines in progress · ${money(commission)} commission earned this month`}
        actions={
          <Link href="/repairs/new" className="btn btn-primary">
            Take in a machine
          </Link>
        }
      />
      {open.length === 0 && <Empty>No machines in progress.</Empty>}
      {GROUPS.map((g) => {
        const list = open.filter((j) => g.statuses.includes(j.status));
        return list.length ? (
          <Section key={g.title} title={`${g.title} (${list.length})`}>
            {table(list)}
          </Section>
        ) : null;
      })}
      {open.some((j) => j.status === "RETURNED_UNREPAIRED") && <Section title="Returned unrepaired">{table(open.filter((j) => j.status === "RETURNED_UNREPAIRED"))}</Section>}
      {done.length > 0 && <Section title="Finished (latest 50)">{table(done)}</Section>}
    </div>
  );
}
