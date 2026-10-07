"use server";
// The Assistant's buttons (ai-assistant-scope.md section 2). Nothing here runs on its own: each action is a person pressing
// Draft it / Ask / Read the plate. The bodies are in src/lib/assistant/bodies.ts (requireOn(user, "assistant") in every
// one except the plate reader, which works without the module: 20 free reads a month, counted on the hub). The model
// never changes a record: "Use this" fills a field on the page and the form still has to be saved. Not in WHILE_LAPSED:
// while the program itself is read-only, the Assistant waits too.
import { revalidatePath } from "next/cache";
import { noted, safe, shownOnce } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { draftText, labelRead, likelyCauses, markCall, plateRead, saveSettings, tagFromPicture } from "@/lib/assistant/bodies";
import { askManuals, searchManualText } from "@/lib/assistant/manuals";
import { clearIndex, startIndexing, stopIndexing } from "@/lib/assistant/manuals-index";
import { looksLike, matchColumns, partsForJob } from "@/lib/assistant/parts";

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
    manualsOn: fd.get("manualsOn") === "on",
    partsOn: fd.get("partsOn") === "on",
    fabricOn: fd.get("fabricOn") === "on",
    stockOn: fd.get("stockOn") === "on",
    offerFirstNames: fd.get("offerFirstNames") === "on",
    voice: String(fd.get("voice") ?? "").trim() || null,
  });
  revalidatePath("/settings/assistant");
});

/** "Ask the manuals" on a model page or ticket: the answer with its cited pages goes back to the card (nothing is stored but the log). */
export const askTheManuals = safe(async (brand: string, model: string, question: string, ticketId: string | null) => {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await askManuals(user, { brand, model, question, ticketId })));
});

/** The manuals page's search box: pages of this company's indexed manuals containing the words. No model, no allowance. */
export const searchTheManuals = safe(async (query: string) => {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await searchManualText(user, query)));
});

/** "Index these manuals" (a model's files: anyone) or "Index my whole library" (owner or admin): starts the background indexer. */
export const indexManuals = safe(async (brand: string | null, model: string | null) => {
  const user = brand && model ? await requireUser() : await requireAdmin();
  const n = await startIndexing(user, brand && model ? { brand, model } : { all: true });
  revalidatePath("/manuals");
  revalidatePath("/models", "layout");
  return noted(`Indexing ${n} manual${n === 1 ? "" : "s"} in the background. You can keep working.`);
});

/** Stop the indexer; the pages read so far stay and "Continue" picks up from them. */
export const stopManualIndexing = safe(async () => {
  const user = await requireUser();
  await stopIndexing(user);
  revalidatePath("/manuals");
  revalidatePath("/models", "layout");
});

/** Delete this company's search index (owner or admin); the manuals themselves are not touched. */
export const clearManualIndex = safe(async () => {
  const user = await requireAdmin();
  await clearIndex(user);
  revalidatePath("/manuals");
  revalidatePath("/models", "layout");
});

/** "Looks like" on a part page: likely equivalent parts from this company's stock and the shared cross-reference (links only; nothing is changed). */
export const askLooksLike = safe(async (partId: string) => {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await looksLike(user, { partId })));
});

/** "Parts this job usually needs" on a ticket: from this shop's past jobs on the model and the parts the cross-reference says fit it. */
export const askPartsForJob = safe(async (ticketId: string, instruction: string) => {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await partsForJob(user, { ticketId, instruction })));
});

/** "Match the columns" on the inventory import: the headings and three sample rows in, a proposed field-to-column map out. */
export const askMatchColumns = safe(async (fields: { key: string; label: string }[], headers: string[], sample: string[][]) => {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await matchColumns(user, { fields, headers, sample })));
});

/** "Photograph the bolt label" (Add a collection, a new fabric): the label's words go back to the form to be checked; nothing is saved. */
export const readBoltLabel = safe(async (data: string, mediaType: string) => {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await labelRead(user, data, mediaType)));
});

/** "Tag from the picture" on a fabric (the picture is sent from the browser, shrunk): the colors and themes are added to its tags. */
export const tagFabric = safe(async (partId: string, data: string, mediaType: string) => {
  const user = await requireUser();
  const r = await tagFromPicture(user, partId, data, mediaType);
  revalidatePath(`/parts/${partId}`);
  revalidatePath("/fabric");
  return shownOnce(JSON.stringify(r));
});
