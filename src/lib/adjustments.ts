// Timing and core adjustments, in the order a tech works through a machine.
export const ADJUSTMENTS: { key: string; name: string; group: string }[] = [
  { key: "needle_bar_height", name: "Needle bar height", group: "Needle and hook" },
  { key: "hook_timing_rise", name: "Hook timing (needle bar rise)", group: "Needle and hook" },
  { key: "hook_timing_degrees", name: "Hook timing (degrees)", group: "Needle and hook" },
  { key: "hook_point_height", name: "Hook point to needle eye", group: "Needle and hook" },
  { key: "needle_hook_clearance", name: "Hook to needle gap", group: "Needle and hook" },
  { key: "needle_guard", name: "Needle guard", group: "Needle and hook" },
  { key: "needle_centering", name: "Needle centering / swing clearance", group: "Needle and hook" },
  { key: "needle_swing_timing", name: "Zigzag swing timing", group: "Needle and hook" },
  { key: "bobbin_case", name: "Bobbin case / opener", group: "Needle and hook" },
  { key: "looper", name: "Looper", group: "Loopers and knives" },
  { key: "knife", name: "Knife / thread trimmer", group: "Loopers and knives" },
  { key: "feed_dog_height", name: "Feed dog height", group: "Feed and presser" },
  { key: "feed_dog_position", name: "Feed dog position", group: "Feed and presser" },
  { key: "feed_timing", name: "Feed timing", group: "Feed and presser" },
  { key: "presser_foot_height", name: "Presser foot height / lift", group: "Feed and presser" },
  { key: "presser_foot_pressure", name: "Presser foot pressure", group: "Feed and presser" },
  { key: "take_up_spring", name: "Take-up spring", group: "Other" },
  { key: "belt", name: "Belt deflection", group: "Other" },
  { key: "other", name: "Other", group: "Other" },
];

export const ADJ_NAME: Record<string, string> = Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, a.name]));
export const ADJ_ORDER: Record<string, number> = Object.fromEntries(ADJUSTMENTS.map((a, i) => [a.key, i]));

export function unitLabel(u: string | null | undefined) {
  if (u === "deg") return "°";
  if (u === "other" || !u) return "";
  return ` ${u}`;
}

/** "2.9-3.3 mm", "0.1 mm or less", "at least 0.2 mm", "201°" */
export function valueRange(min: number | null, max: number | null, unit: string | null | undefined): string {
  const u = unitLabel(unit);
  const f = (x: number) => (Math.round(x * 1000) / 1000).toString();
  if (min == null && max == null) return "";
  if (min == null) return `${f(max!)}${u} or less`;
  if (max == null) return `${f(min)}${u} or more`;
  if (min === max) return `${f(min)}${u}`;
  return `${f(min)}-${f(max)}${u}`;
}
