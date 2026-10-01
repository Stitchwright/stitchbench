// Notices on a partner repair job (scheduling-messaging-design.md sections 7.3 and 9.5): the same block as a ticket's,
// plus "It's back at the counter" while the repair shop's "ready" hasn't been confirmed here.
import type { CurrentUser } from "@/lib/session";
import { NoticesBlock } from "@/components/slots/ticket-notices";

export async function JobNoticesSlot({ jobId, user }: { jobId: string; user: CurrentUser }) {
  return <NoticesBlock user={user} ref_={{ jobId }} />;
}
