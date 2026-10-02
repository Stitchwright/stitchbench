// On the repair Dashboard (scheduling-messaging-design.md 13.6): the next 3 runs across partners.
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";
import { Section } from "@/components/ui";

export async function DashboardRunsSlot({ user }: { user: CurrentUser }) {
  const shopId = user.shopId;
  const runs = await db.partnerRun.findMany({ where: { shopId, status: "SCHEDULED", startsAt: { gte: new Date(new Date().getTime() - 86_400_000) } }, orderBy: { startsAt: "asc" }, take: 3 });
  if (!runs.length) return null;
  const [tz, links] = await Promise.all([shopTimeZone(shopId), db.partnerLink.findMany({ where: { shopId, id: { in: [...new Set(runs.map((r) => r.linkId))] } }, select: { id: true, partnerName: true, side: true } })]);
  const name = new Map(links.map((l) => [l.id, l.partnerName]));
  return (
    <Section title="Pickup runs">
      <ul className="space-y-1 text-sm">
        {runs.map((r) => (
          <li key={r.id}>
            <Link href={`/partners/${r.linkId}/runs/${r.id}`} className="link">
              {fmtWhen(r.startsAt, tz)} · {name.get(r.linkId) ?? "partner"}
            </Link>
            <span className="muted">
              {" "}
              · {r.collect.length} to collect, {r.deliver.length} to deliver{r.okRev === r.rev ? " · OK'd" : " · not OK'd yet"}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
