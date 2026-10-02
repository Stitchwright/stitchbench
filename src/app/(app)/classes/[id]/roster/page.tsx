// The roster to print (scheduling-messaging-design.md 12.1): names (the attendee when set), phone, paid, and one blank
// attendance box per meeting.
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { money } from "@/lib/format";
import { fmtPhone } from "@/lib/phone";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtDay, fmtRange } from "@/lib/zoned";
import { ModuleOff } from "@/components/module-off";
import { PrintButton } from "@/components/print-button";
import { PageHeader } from "@/components/ui";

export default async function RosterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const c = await db.shopClass.findFirst({ where: { id, shopId }, include: { meetings: { where: { cancelled: false }, orderBy: { startsAt: "asc" } } } });
  if (!c) notFound();
  const [tz, shop, rows] = await Promise.all([
    shopTimeZone(shopId),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true } }),
    db.enrollment.findMany({ where: { shopId, classId: c.id, status: "ENROLLED" }, orderBy: { createdAt: "asc" }, include: { customer: { select: { phone: true } } } }),
  ]);
  return (
    <div>
      <div className="no-print">
        <PageHeader back={{ href: `/classes/${c.id}`, label: c.title }} title="Roster" actions={<PrintButton />} />
      </div>
      <article className="card mx-auto max-w-4xl bg-white p-8 text-black print:border-0 print:p-0">
        <header className="border-b border-line pb-3">
          <div className="text-xl font-bold">{c.title}</div>
          <div className="text-sm">
            {shop.name}
            {c.teacher ? ` · ${c.teacher}` : ""}
            {c.location ? ` · ${c.location}` : ""}
          </div>
          <div className="mt-1 text-sm">{c.meetings.map((m) => fmtRange(m.startsAt, m.endsAt, tz)).join(" · ")}</div>
        </header>
        <table className="table mt-4">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Paid</th>
              {c.meetings.map((m) => (
                <th key={m.id} className="w-16 text-center text-xs">
                  {fmtDay(m.startsAt, tz)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.attendee ? `${r.attendee} (${r.name})` : r.name}</td>
                <td className="num">{r.customer?.phone ? fmtPhone(r.customer.phone) : ""}</td>
                <td>{r.paidAt ? "Paid" : r.feeCents ? `Owes ${money(r.feeCents)}` : "Free"}</td>
                {c.meetings.map((m) => (
                  <td key={m.id} className="text-center">
                    <span className="inline-block h-5 w-5 border border-black align-middle" aria-label="attendance box" />
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3 + c.meetings.length} className="muted">
                  Nobody signed up yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {c.supplies && (
          <p className="mt-4 text-sm">
            <strong>Bring:</strong> {c.supplies}
          </p>
        )}
      </article>
    </div>
  );
}
