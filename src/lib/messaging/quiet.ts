// Quiet hours for texts (scheduling-messaging-design.md section 4.1). Pure.
import { recipientZones } from "@/lib/phone";
import { wall } from "@/lib/zoned";

export type QuietRules = { quietStart: number; quietEnd: number; noSundayMarketing: boolean };

const STEP = 15 * 60_000;
const MAX = 8 * 24 * 60 * 60_000;

function okAt(t: Date, zones: string[], r: QuietRules, marketing: boolean) {
  for (const tz of zones) {
    const w = wall(t, tz);
    const m = w.hour * 60 + w.minute;
    if (m < r.quietStart || m >= r.quietEnd) return false;
    if (marketing && r.noSundayMarketing && w.weekday === 0) return false;
  }
  return true;
}

/**
 * When a text may go: `now` when the wall clock is inside [quietStart, quietEnd) in the shop's zone (and, for marketing,
 * in every zone the number may be in, with no Sunday marketing), else the first allowed quarter hour after it.
 */
export function nextTextTime(now: Date, shopTz: string, r: QuietRules, marketing: boolean, to: string): Date {
  const zones = [...new Set([shopTz, ...(marketing ? recipientZones(to) : [])])];
  if (okAt(now, zones, r, marketing)) return now;
  // The next quarter hour on the clock, then every quarter hour after it.
  let t = Math.ceil((now.getTime() + 1) / STEP) * STEP;
  const end = now.getTime() + MAX;
  while (t <= end) {
    const d = new Date(t);
    if (okAt(d, zones, r, marketing)) return d;
    t += STEP;
  }
  return new Date(end);
}
