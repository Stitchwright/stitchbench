// "Bigger text" (a setting per person, in Settings). The root font size scales everything rem-based: text, buttons,
// fields, spacing. Pure: no database, so the sign-in page and the print guard can use it too.
export const TEXT_SIZES = ["normal", "large", "larger"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const TEXT_SIZE_PCT: Record<TextSize, number> = { normal: 100, large: 115, larger: 130 };
export const TEXT_SIZE_LABEL: Record<TextSize, string> = { normal: "Normal", large: "Large", larger: "Larger" };
/** Remembered per device so the sign-in page matches the last choice made on it. */
export const TEXT_SIZE_COOKIE = "sb_text_size";

export function parseTextSize(v: unknown): TextSize {
  return (TEXT_SIZES as readonly string[]).includes(v as string) ? (v as TextSize) : "normal";
}

/** The rule for the page's <style>. Print views mark <html data-text-off> (see TextSizeStyle); paper is never scaled. */
export function textSizeCss(size: TextSize): string {
  if (size === "normal") return "";
  return `html:not([data-text-off]){font-size:${TEXT_SIZE_PCT[size]}%}@media print{html{font-size:100%!important}}`;
}
