import { createHash } from "node:crypto";

// Must match figure_id() in scripts/library/common.py.
function fmt(x: number): string {
  return String(Number(x.toFixed(3)));
}

export function figureId(sourcePath: string, page: number, box: number[]): string {
  const key = `${sourcePath}|${page}|${box.map(fmt).join(",")}`;
  return createHash("sha1").update(key, "utf8").digest("hex").slice(0, 24);
}
