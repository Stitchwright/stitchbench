// The estimate link on a partner repair job, below the counter's own answer form (scheduling-messaging-design.md 7.3, 10.5).
import type { CurrentUser } from "@/lib/session";
import { EstimatePanel } from "@/components/slots/ticket-estimate";

export async function JobEstimateSlot({ jobId, user }: { jobId: string; user: CurrentUser }) {
  return <EstimatePanel target="job" id={jobId} user={user} />;
}
