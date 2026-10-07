// Block of the Month: which kit is each month, each month's handout marked done, and the sign-up roster.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { seriesFor } from "@/lib/kits";
import { PageHeader } from "@/components/ui";
import { DeleteSeriesButton, HandoutButton, MonthSlotForm, RemoveMemberButton, RosterAdd } from "@/components/kit-forms";

export default async function SeriesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const { id } = await params;
  const s = await seriesFor(user.shopId, id);
  if (!s) notFound();
  const filled = s.slots.filter((x) => x.kit).length;
  const done = s.slots.filter((x) => x.kit?.handoutDoneAt).length;
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: "/fabric?tab=kits", label: "Kits" }} title={s.name} sub={`${filled} of ${s.months} months have a kit, ${done} handouts done, ${s.members.length} signed up.`} />
      <div className="card card-pad space-y-2">
        <h2 className="text-sm font-semibold">Months</h2>
        <ul className="divide-y divide-line">
          {s.slots.map((m) => (
            <li key={m.month} className="flex flex-wrap items-center gap-3 py-2">
              <span className="num w-16 font-semibold">Month {m.month}</span>
              <div className="min-w-[12rem] flex-1">
                {m.kit ? (
                  <Link href={`/fabric/kits/${m.kit.id}`} className="link">
                    {m.kit.name}
                  </Link>
                ) : (
                  <span className="muted">no kit yet</span>
                )}
                {m.kit?.handoutDoneAt && <span className="pill tone-ready ml-2">handout done {fmtDate(m.kit.handoutDoneAt, s.timeZone)}</span>}
              </div>
              <MonthSlotForm seriesId={s.id} month={m.month} current={m.kit?.id ?? ""} options={m.kit ? [{ id: m.kit.id, name: m.kit.name, series: null }, ...s.free.filter((k) => k.id !== m.kit!.id)] : s.free} />
              {m.kit && <HandoutButton seriesId={s.id} kitId={m.kit.id} done={!!m.kit.handoutDoneAt} />}
            </li>
          ))}
        </ul>
        {s.free.length === 0 && <p className="muted text-xs">Every kit you have is already in this series. Build more kits on the Kits tab.</p>}
      </div>
      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Roster ({s.members.length})</h2>
        {s.members.length === 0 ? (
          <p className="muted text-sm">Nobody has signed up yet.</p>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Contact</th>
                  <th>Signed up</th>
                  <th>Note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link href={`/customers/${m.customerId}`} className="link">
                        {m.name}
                      </Link>
                    </td>
                    <td>{[m.phone, m.email].filter(Boolean).join(" · ") || "-"}</td>
                    <td>{fmtDate(m.signedUpAt, s.timeZone)}</td>
                    <td>{m.note ?? ""}</td>
                    <td className="text-right">
                      <RemoveMemberButton seriesId={s.id} memberId={m.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <RosterAdd seriesId={s.id} />
      </div>
      <div>
        <DeleteSeriesButton seriesId={s.id} />
      </div>
    </div>
  );
}
