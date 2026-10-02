// On /repairs (scheduling-messaging-design.md 13.6): "Next run {day} {time}: {n} going, {m} coming back" + link.
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";

export async function RepairsRunsSlot({ user }: { user: CurrentUser }) {
  const shopId = user.shopId;
  const run = await db.partnerRun.findFirst({ where: { shopId, status: "SCHEDULED", startsAt: { gte: new Date(new Date().getTime() - 86_400_000) } }, orderBy: { startsAt: "asc" } });
  if (!run) return null;
  const [tz, link] = await Promise.all([shopTimeZone(shopId), db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: run.linkId } }, select: { partnerName: true } })]);
  return (
    <p className="card card-pad text-sm">
      <Link href={`/partners/${run.linkId}/runs/${run.id}`} className="link">
        Next run {fmtWhen(run.startsAt, tz)}
      </Link>
      : {run.collect.length} going, {run.deliver.length} coming back{link ? ` (${link.partnerName})` : ""}.
    </p>
  );
}
