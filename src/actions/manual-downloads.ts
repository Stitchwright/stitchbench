"use server";

// "Download everything" into the manual library: queue the links for a model, a brand, or every link not yet here;
// take a job off the queue; clear a finished one from the list. The server's timer does the downloading.
import { revalidatePath } from "next/cache";
import { safe, UserError } from "@/lib/action";
import { cancelJob, clearJob, queueDownloads } from "@/lib/manual-downloads";
import { requireUser } from "@/lib/session";

function refresh() {
  revalidatePath("/", "layout");
}

export const downloadModelManuals = safe(async function downloadModelManuals(brand: string, model: string) {
  const user = await requireUser();
  if (!brand.trim() || !model.trim()) throw new UserError("Say which brand and model.");
  await queueDownloads(user, { kind: "model", brand: brand.trim(), model: model.trim() });
  refresh();
});

export const downloadBrandManuals = safe(async function downloadBrandManuals(brand: string) {
  const user = await requireUser();
  if (!brand.trim()) throw new UserError("Say which brand.");
  await queueDownloads(user, { kind: "brand", brand: brand.trim() });
  refresh();
});

export const downloadAllManuals = safe(async function downloadAllManuals() {
  const user = await requireUser();
  await queueDownloads(user, { kind: "all" });
  refresh();
});

export const cancelManualDownloads = safe(async function cancelManualDownloads(jobId: string) {
  const user = await requireUser();
  await cancelJob(user.shopId, jobId);
  refresh();
});

export const clearManualDownloads = safe(async function clearManualDownloads(jobId: string) {
  const user = await requireUser();
  await clearJob(user.shopId, jobId);
  refresh();
});
