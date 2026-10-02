// Pickup runs on a partner's page (scheduling-messaging-design.md 13.6): upcoming and the last 5, and "Schedule a run".
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";
import { RUN_STATUS_LABEL } from "@/lib/constants";
import { okWords, type Side } from "@/lib/partner-runs";
import { runState } from "@/lib/partner-run-actions";
import { Section } from "@/components/ui";

const TONE: Record<string, string> = { SCHEDULED: "wait", DONE: "done", CANCELLED: "neutral" };

export async function PartnerRunsSlot({ linkId, user }: { linkId: string; user: CurrentUser }) {
  const shopId = user.shopId;
  const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: linkId } } });
  if (!link) return null;
  const now = new Date();
  const [upcoming, past, tz, gate] = await Promise.all([
    db.partnerRun.findMany({ where: { shopId, linkId, status: "SCHEDULED", startsAt: { gte: new Date(now.getTime() - 86_400_000) } }, orderBy: { startsAt: "asc" }, take: 20 }),
    db.partnerRun.findMany({ where: { shopId, linkId, OR: [{ status: { not: "SCHEDULED" } }, { startsAt: { lt: new Date(now.getTime() - 86_400_000) } }] }, orderBy: { startsAt: "desc" }, take: 5 }),
    shopTimeZone(shopId),
    gateFor(shopId, "scheduling"),
  ]);
  const side = link.side as Side;
  const canSchedule = gate === "on" && link.features.includes("pickup") && (link.status === "ACTIVE" || true);
  if (!upcoming.length && !past.length && !canSchedule) return null;
  const row = (r: (typeof upcoming)[number]) => (
    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <Link href={`/partners/${linkId}/runs/${r.id}`} className="link">
        {fmtWhen(r.startsAt, tz)}
      </Link>
      <span className={`pill tone-${TONE[r.status] ?? "neutral"}`}>{RUN_STATUS_LABEL[r.status] ?? r.status}</span>
      <span className="muted">
        {r.collect.length} going · {r.deliver.length} coming back · {r.driver === side ? "you drive" : `${link.partnerName} drives`}
      </span>
      {r.status === "SCHEDULED" && <span className="muted">{okWords(runState(r), link.partnerName, r.ownerSide === side)}</span>}
    </li>
  );
  return (
    <Section
      title="Pickup runs"
      actions={
        canSchedule ? (
          <Link href={`/partners/${linkId}/runs/new`} className="btn btn-sm">
            Schedule a run
          </Link>
        ) : undefined
      }
    >
      <div className="space-y-2 text-sm">
        {!link.features.includes("pickup") && gate === "on" && <p className="muted">{link.partnerName}&apos;s program is an older version that can&apos;t take runs yet.</p>}
        {upcoming.length === 0 && past.length === 0 && <p className="muted">No runs yet.</p>}
        {upcoming.length > 0 && <ul className="divide-y divide-line">{upcoming.map(row)}</ul>}
        {past.length > 0 && (
          <details>
            <summary className="muted cursor-pointer">Earlier runs</summary>
            <ul className="divide-y divide-line">{past.map(row)}</ul>
          </details>
        )}
      </div>
    </Section>
  );
}
