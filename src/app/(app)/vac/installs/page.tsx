// Central vac installs (modules-design.md 10.d): upcoming, done or all, with when, customer, address, power unit and
// status; "New install" while Vac Shop is active.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { ticketNo } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { SITE_STATUS_LABEL, STATUS_TONE } from "@/lib/constants";
import { isInstallTab, listInstalls } from "@/lib/vac/installs";
import { fmtRange } from "@/lib/zoned";
import { Empty } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

const TABS = [
  { key: "upcoming", label: "Upcoming" },
  { key: "done", label: "Done" },
  { key: "all", label: "All" },
] as const;

export default async function Installs({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = isInstallTab(sp.tab) ? sp.tab : "upcoming";
  const [installs, tz] = await Promise.all([listInstalls(user.shopId, tab), shopTimeZone(user.shopId)]);
  const s = await vacPageState(user, installs.length > 0);
  return (
    <VacFrame title="Central vac installs" tab="installs" what="Your installs" {...s}>
      <div className="flex flex-wrap items-center gap-2" role="navigation" aria-label="Installs">
        {TABS.map((t) => (
          <Link key={t.key} href={`/vac/installs?tab=${t.key}`} className={`btn btn-sm ${tab === t.key ? "btn-primary" : ""}`}>
            {t.label}
          </Link>
        ))}
        {s.gate === "write" && (
          <Link href="/vac/installs/new" className="btn btn-primary ml-auto">
            New install
          </Link>
        )}
      </div>
      {installs.length === 0 ? (
        <Empty>{tab === "upcoming" ? "No installs coming up." : tab === "done" ? "No installs finished yet." : "No installs yet."}</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Install</th>
                <th>Customer</th>
                <th>Where</th>
                <th>Power unit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {installs.map((j) => (
                <tr key={j.ticketId}>
                  <td className="whitespace-nowrap">{j.startsAt && j.endsAt ? fmtRange(j.startsAt, j.endsAt, tz) : <span className="pill tone-wait">Not scheduled</span>}</td>
                  <td>
                    <Link href={`/tickets/${j.ticketId}`} className="link mono">
                      #{ticketNo(j.number)}
                    </Link>
                  </td>
                  <td>
                    {j.customerId ? (
                      <Link href={`/customers/${j.customerId}`} className="link">
                        {j.customerName}
                      </Link>
                    ) : (
                      (j.customerName ?? "")
                    )}
                  </td>
                  <td>{j.address}</td>
                  <td>{j.unit ?? <span className="muted">to be chosen</span>}</td>
                  <td>
                    <span className={`pill tone-${STATUS_TONE[j.status] ?? "neutral"}`}>{SITE_STATUS_LABEL[j.status] ?? j.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </VacFrame>
  );
}
