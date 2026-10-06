import "server-only";
// What a page shows for an Assistant entry point: nothing, the button, or the plain reason it can't work now.
import { assistantAvailable } from "./client";
import { OFFLINE_MESSAGE, type FeatureGroup } from "./features";

export type Entry = { show: false } | { show: true; unavailable?: string };

/**
 * `module: false` for the plate reader (free reads without the module). Hidden when the Assistant can't ever work here
 * (switched off in Settings or on the server, the module off, never joined a hub); the offline reason when the internet is down.
 */
export async function entryFor(shopId: string, group: FeatureGroup, o: { module?: boolean } = {}): Promise<Entry> {
  const a = await assistantAvailable(shopId, { module: o.module, group });
  if (a.ok) return { show: true };
  if (a.why === "no-hub" && group === "plate") return { show: false };
  if (a.why === "offline" || a.why === "no-hub") return { show: true, unavailable: OFFLINE_MESSAGE };
  return { show: false };
}
