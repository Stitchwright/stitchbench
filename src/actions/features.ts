"use server";

// Settings → Features: switching an add-on on or off for the signed-in company. The body is in src/lib/features.ts.
import { safe } from "@/lib/action";
import { requireAdmin } from "@/lib/session";
import { setFeatureFor } from "@/lib/features";

export const setFeature = safe(async function setFeature(id: string, on: boolean) {
  await setFeatureFor(await requireAdmin(), String(id), on === true);
});
