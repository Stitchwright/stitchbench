"use server";

// Sending an estimate to the customer, recording how they answered, and stopping a link
// (scheduling-messaging-design.md section 10.3). The work is in src/lib/estimate-links.ts.
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { recordEstimateAnswerAs, revokeEstimateLinkAs, sendEstimateAs } from "@/lib/estimate-links";

function targetOf(t: unknown): "ticket" | "job" {
  if (t !== "ticket" && t !== "job") throw new UserError("Pick a ticket or a repair.");
  return t;
}

/** Text and / or email the estimate, with a link to approve it when this install has a public address. Needs Marketing. */
export const sendEstimate = safe(async function sendEstimate(target: "ticket" | "job", id: string, formData: FormData) {
  const user = await requireUser();
  await sendEstimateAs(user, targetOf(target), String(id), { email: formData.get("email") != null, sms: formData.get("sms") != null, note: str(formData.get("note")) });
});

/** "They approved" / "They declined" from a text reply or a phone call. */
export const recordEstimateAnswer = safe.whileLapsed("recordEstimateAnswer")(async function recordEstimateAnswer(target: "ticket" | "job", id: string, formData: FormData) {
  const user = await requireUser();
  await recordEstimateAnswerAs(user, targetOf(target), String(id), { answer: String(formData.get("answer") ?? ""), via: String(formData.get("via") ?? ""), note: str(formData.get("note")) });
});

/** Stop an open estimate link. */
export const revokeEstimateLink = safe(async function revokeEstimateLink(linkId: string) {
  const user = await requireUser();
  await revokeEstimateLinkAs(user, linkId);
});
