// A swatch color as a small square beside its words (shop-features-round-2-design.md 2.1). Never the only sign of a color:
// the color number or name is always written next to it.
export function ColorDot({ hex, size = "md" }: { hex: string | null | undefined; size?: "md" | "lg" }) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const box = size === "lg" ? "h-12 w-12" : "h-5 w-5";
  return <span aria-hidden="true" className={`inline-block shrink-0 rounded border border-line align-middle ${box}`} style={{ backgroundColor: hex }} />;
}
