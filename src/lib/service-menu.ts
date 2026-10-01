// Starter service menu for a new shop. Prices come from the Timing & Tension
// draft price sheet (2026-09); every shop edits its own copy in Settings.
export const DEFAULT_SERVICE_MENU: { name: string; priceCents: number }[] = [
  { name: "Clean, oil, time & adjust - mechanical", priceCents: 12900 },
  { name: "Clean, oil, time & adjust - computerized", priceCents: 15900 },
  { name: "Clean, oil, time & adjust - sew & embroidery combo", priceCents: 19900 },
  { name: "Clean, oil, time & adjust - embroidery only", priceCents: 17900 },
  { name: "Clean, oil, time & adjust - premium computerized", priceCents: 24900 },
  { name: "Clean, oil, time & adjust - serger / coverstitch", priceCents: 15900 },
  { name: "Clean, oil, time & adjust - air-threading serger", priceCents: 18900 },
  { name: "Clean, oil, time & adjust - Featherweight 221/222", priceCents: 11900 },
  { name: "Clean, oil, time & adjust - other vintage", priceCents: 13900 },
  { name: "Clean, oil, time & adjust - industrial / straight-stitch quilter", priceCents: 17900 },
  { name: "Sit-down quilter service", priceCents: 22500 },
  { name: "Longarm service, on site", priceCents: 27500 },
  { name: "Longarm with robotics, on site", priceCents: 32500 },
  { name: "Diagnosis & estimate (credited toward approved work)", priceCents: 4900 },
  { name: "Hook timing only", priceCents: 5500 },
  { name: "Serger looper re-timing", priceCents: 5000 },
  { name: "Rush - back mid-week", priceCents: 5000 },
  { name: "Storage fee (after 60 days)", priceCents: 4500 },
];

// Service checklist from the price sheet's "Every service includes" list.
// Each shop edits its own copy in Settings.
export const DEFAULT_CHECKLIST: string[] = [
  "Covers off: lint and old oil cleaned from hook, feed and bobbin area",
  "Lubricated to the manufacturer's service manual",
  "Hook-to-needle timing checked and set",
  "Needle-bar height and needle centering checked and set",
  "Feed dog height and timing adjusted",
  "Presser-foot pressure adjusted",
  "Upper and bobbin tension balanced (gauge readings recorded)",
  "Motor, belts and electrical checked",
  "New needle installed",
  "Full stitch-out test done, sew-out attached",
  "Note written of anything else found",
];

/**
 * Which kind a starter service item is for: the storage fee, rush and diagnosis items are offered for every kind
 * (null); everything else on the starter list is a sewing-machine service. The same rule as the paid_modules
 * migration's backfill and the Windows restore fix-up (desktop/backup.mjs), so the seed, new companies and restores agree.
 */
export function starterKindFor(name: string): string | null {
  return /^(storage fee|rush|diagnosis)/i.test(name) ? null : "sewing";
}
