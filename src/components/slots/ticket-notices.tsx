/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the notices package fills in the body */
// Uncollected-machine notices and messages on a ticket (scheduling-messaging-design.md section 7.3). Foundation stub: renders nothing.
import type { CurrentUser } from "@/lib/session";

export async function TicketNoticesSlot(_props: { ticketId: string; user: CurrentUser }) {
  return null;
}
