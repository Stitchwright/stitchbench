// Schedule a pickup run (scheduling-messaging-design.md 13.6). Scheduling on; the partner's program must take runs.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { hmOf, wall, ymdOf } from "@/lib/zoned";
import { defaultStart, rideJobs, termsPickupDay } from "@/lib/partner-run-actions";
import { proposeRun } from "@/actions/partner-runs";
import { ModuleOff } from "@/components/module-off";
import { RunForm } from "@/components/run-form";
import { PageHeader, Section } from "@/components/ui";

export default async function NewRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const shopId = user.shopId;
  const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id } } });
  if (!link) notFound();
  const gate = await gateFor(shopId, "scheduling");
  if (gate !== "on") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} what="pickup runs" />;
  const tz = await shopTimeZone(shopId);
  const ride = await rideJobs(shopId, link);
  const start = defaultStart(termsPickupDay(link), tz);
  const w = wall(start, tz);
  const ourSide = link.side as "repair" | "retail";
  const canTake = link.features.includes("pickup");
  return (
    <div className="space-y-4">
      <PageHeader title={`Schedule a run with ${link.partnerName}`} back={{ href: `/partners/${link.id}`, label: link.partnerName }} />
      {!canTake ? (
        <p className="card card-pad text-sm">
          {link.partnerName}&apos;s program is an older version that can&apos;t take runs yet. Ask them to update.{" "}
          <Link href={`/partners/${link.id}`} className="link">
            Back
          </Link>
        </p>
      ) : (
        <Section title="The plan">
          <RunForm
            action={proposeRun.bind(null, link.id)}
            draft={{ date: ymdOf(start, tz), start: hmOf(w.hour * 60 + w.minute), end: "", driver: "repair", collect: ride.collect.filter((j) => !j.onRun).map((j) => j.id), deliver: ride.deliver.filter((j) => !j.onRun).map((j) => j.id), note: null }}
            ride={ride}
            ourSide={ourSide}
            partnerName={link.partnerName}
            tz={tz}
            submitLabel="Schedule it and tell them"
          />
        </Section>
      )}
    </div>
  );
}
