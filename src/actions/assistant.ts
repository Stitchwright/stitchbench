"use server";
// The Assistant's buttons (ai-assistant-scope.md section 2). Nothing here runs on its own: each action is a person pressing
// Draft it / Ask / Read the plate. The bodies are in src/lib/assistant/bodies.ts (requireOn(user, "assistant") in every
// one except the plate reader, which works without the module: 20 free reads a month, counted on the hub). The model
// never changes a record: "Use this" fills a field on the page and the form still has to be saved. Not in WHILE_LAPSED:
// while the program itself is read-only, the Assistant waits too.
import { revalidatePath } from "next/cache";
import { safe, shownOnce } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { draftText, likelyCauses, markCall, plateRead, saveSettings } from "@/lib/assistant/bodies";

/** "Draft it" on a ticket: the shorthand in the field (not yet saved) becomes plain sentences, or the message's text. */
export const draftTicketText = safe(async (ticketId: string, kind: string, shorthand: string, instruction: string) => {
  const user = await requireUser();
  await draftText(user, { ticketId, kind, shorthand, instruction });
  revalidatePath(`/tickets/${ticketId}`);
});

/** "What's likely wrong" (and "Ask again with what I found"): up to five causes with their sources. */
export const askLikelyCauses = safe(async (ticketId: string, instruction: string) => {
  const user = await requireUser();
  await likelyCauses(user, { ticketId, instruction });
  revalidatePath(`/tickets/${ticketId}`);
});

/** "Use this" / "Helped" (true) and "Not useful" (false), on a call of this company. */
export const markAssistantCall = safe(async (callId: string, accepted: boolean) => {
  const user = await requireUser();
  const ticketId = await markCall(user, callId, accepted);
  if (ticketId) revalidatePath(`/tickets/${ticketId}`);
});

/** "Read the plate": the answer goes back to the form through shownOnce (nothing is stored but the log). */
export const readPlate = safe(async (data: string, mediaType: string) => {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await plateRead(user, data, mediaType)));
});

/** Settings → Assistant: a switch per feature group, the voice sample and the first-names switch. */
export const saveAssistantSettings = safe(async (fd: FormData) => {
  const user = await requireAdmin();
  await saveSettings(user, {
    draftOn: fd.get("draftOn") === "on",
    causesOn: fd.get("causesOn") === "on",
    plateOn: fd.get("plateOn") === "on",
    offerFirstNames: fd.get("offerFirstNames") === "on",
    voice: String(fd.get("voice") ?? "").trim() || null,
  });
  revalidatePath("/settings/assistant");
});
