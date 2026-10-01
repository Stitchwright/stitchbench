import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { NoticeLetter } from "@/components/slots/ticket-notices";

/** An uncollected-machine notice for a partner repair job's customer, as a letter to print. No module check. */
export default async function JobNoticeLetter({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ stage?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { stage } = await searchParams;
  const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId: user.shopId, id } }, select: { id: true, side: true } });
  if (!j || j.side !== "retail") notFound();
  return <NoticeLetter user={user} ref_={{ jobId: j.id }} stage={typeof stage === "string" ? stage : null} />;
}
