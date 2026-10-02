// On a partner job's page (scheduling-messaging-design.md 13.6): "Going on the run {day}" / "Coming back on the run
// {day}" / "Handed to the driver {day}".
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";

export async function JobRunSlot({ jobId, user }: { jobId: string; user: CurrentUser }) {
  const shopId = user.shopId;
  const job = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id: jobId } }, select: { id: true, linkId: true } });
  if (!job) return null;
  const runs = await db.partnerRun.findMany({
    where: { shopId, linkId: job.linkId, status: { not: "CANCELLED" }, OR: [{ collect: { has: job.id } }, { deliver: { has: job.id } }, { collected: { has: job.id } }, { delivered: { has: job.id } }] },
    orderBy: { startsAt: "desc" },
    take: 3,
  });
  if (!runs.length) return null;
  const tz = await shopTimeZone(shopId);
  const lines = runs.map((r) => {
    const day = fmtWhen(r.startsAt, tz);
    const href = `/partners/${r.linkId}/runs/${r.id}`;
    let text: string;
    if (r.delivered.includes(job.id)) text = `Arrived on the run ${day}`;
    else if (r.collected.includes(job.id)) text = `Handed to the driver ${day}`;
    else if (r.status === "DONE") text = `On the run ${day} (${r.collect.includes(job.id) ? "going" : "coming back"})`;
    else text = r.collect.includes(job.id) ? `Going on the run ${day}` : `Coming back on the run ${day}`;
    return { id: r.id, href, text };
  });
  return (
    <p className="card card-pad text-sm">
      {lines.map((l, i) => (
        <span key={l.id}>
          {i > 0 && " · "}
          <Link href={l.href} className="link">
            {l.text}
          </Link>
        </span>
      ))}
    </p>
  );
}
