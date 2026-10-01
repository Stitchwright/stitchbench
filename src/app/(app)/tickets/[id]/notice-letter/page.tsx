import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { NoticeLetter } from "@/components/slots/ticket-notices";

/** An uncollected-machine notice as a letter to print (scheduling-messaging-design.md section 9.5). No module check. */
export default async function TicketNoticeLetter({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ stage?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { stage } = await searchParams;
  const t = await db.ticket.findFirst({ where: { id, shopId: user.shopId }, select: { id: true } });
  if (!t) notFound();
  return <NoticeLetter user={user} ref_={{ ticketId: t.id }} stage={typeof stage === "string" ? stage : null} />;
}
