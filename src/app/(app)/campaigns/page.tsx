// Marketing campaigns: the list (scheduling-messaging-design.md 11.3). Everyone sees it while Marketing isn't hidden;
// admins act.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { fmtDateTime } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { CAMPAIGN_STATUS_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { audienceOf, describeAudience } from "@/lib/messaging/audiences";
import { ModuleOff } from "@/components/module-off";
import { MessagesTabs } from "@/components/messages-tabs";
import { Empty, PageHeader } from "@/components/ui";

const CAMPAIGN_STATUS_TONE: Record<string, string> = { DRAFT: "neutral", QUEUING: "wait", SENDING: "wait", SENT: "done", CANCELLED: "neutral" };

export default async function CampaignsPage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "marketing");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="marketing" admin={user.role !== "TECH"} />;
  const admin = user.role !== "TECH" && gate === "on";
  const [rows, tz] = await Promise.all([db.campaign.findMany({ where: { shopId }, orderBy: { createdAt: "desc" }, take: 200 }), shopTimeZone(shopId)]);
  const classIds = rows.map((r) => audienceOf(r.audience)).flatMap((a) => (a.kind === "class" ? [a.classId] : []));
  const classes = classIds.length ? await db.shopClass.findMany({ where: { shopId, id: { in: classIds } }, select: { id: true, title: true } }) : [];
  const className = new Map(classes.map((c) => [c.id, c.title]));
  const sentCounts = rows.length
    ? await db.outMessage.groupBy({ by: ["campaignId", "status"], where: { shopId, campaignId: { in: rows.map((r) => r.id) } }, _count: { _all: true } })
    : [];
  const counts = new Map<string, { sent: number; notSent: number }>();
  for (const g of sentCounts) {
    if (!g.campaignId) continue;
    const c = counts.get(g.campaignId) ?? { sent: 0, notSent: 0 };
    if (g.status === "SENT") c.sent += g._count._all;
    else if (g.status === "FAILED" || g.status === "SKIPPED" || g.status === "CANCELLED" || g.status === "EXPIRED") c.notSent += g._count._all;
    counts.set(g.campaignId, c);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Campaigns"
        actions={
          admin ? (
            <div className="flex flex-wrap gap-2">
              <Link href="/customers/import" className="btn">
                Bring in your email list
              </Link>
              <Link href="/campaigns/new" className="btn btn-primary">
                New campaign
              </Link>
            </div>
          ) : undefined
        }
      />
      <MessagesTabs active="campaigns" />
      {gate === "readonly" && <ModuleOff shopId={shopId} module="marketing" admin={user.role !== "TECH"} />}
      <p className="muted text-sm">Only send to people who expect to hear from you. Everyone can unsubscribe; that&apos;s the law.</p>
      {rows.length === 0 ? (
        <Empty>No campaigns yet.</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>By</th>
                <th>Who</th>
                <th>Status</th>
                <th>When</th>
                <th className="num">People</th>
                <th className="num">Sent</th>
                <th className="num">Not sent</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const a = audienceOf(r.audience);
                const c = counts.get(r.id) ?? { sent: 0, notSent: 0 };
                const when = r.finishedAt ?? r.queuedAt ?? r.createdAt;
                return (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/campaigns/${r.id}`} className="link">
                        {r.name}
                      </Link>
                    </td>
                    <td>{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                    <td>{describeAudience(a, { className: a.kind === "class" ? className.get(a.classId) : undefined })}</td>
                    <td>
                      <span className={`pill tone-${CAMPAIGN_STATUS_TONE[r.status] ?? "neutral"}`}>{CAMPAIGN_STATUS_LABEL[r.status] ?? r.status}</span>
                    </td>
                    <td className="num whitespace-nowrap">{fmtDateTime(when, tz)}</td>
                    <td className="num">{r.status === "DRAFT" ? "" : r.recipients}</td>
                    <td className="num">{r.status === "DRAFT" ? "" : c.sent}</td>
                    <td className="num">{r.status === "DRAFT" ? "" : c.notSent}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
