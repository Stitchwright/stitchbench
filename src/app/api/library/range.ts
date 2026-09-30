// HTTP byte-range parsing for /api/library/file, kept free of Next.js/node:fs so it can be unit-tested without a
// running server. Only a single range is understood (pdf.js never asks for more than one at a time); multiple
// ranges fall back to a full response rather than an error, since RFC 7233 allows ignoring a Range a server
// doesn't support in that shape.

export type ByteRange = { start: number; end: number }; // inclusive, 0-indexed, both within [0, size)

/**
 * Parse a `Range: bytes=...` request header against a resource of `size` bytes.
 * - `null`: no usable Range header (serve the whole file with status 200).
 * - `"unsatisfiable"`: it is a byte range, but doesn't fit inside the file (respond 416 with `Content-Range: bytes * /size`).
 * - otherwise: the clamped, inclusive start/end to serve with status 206.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // malformed or multiple ranges: serve the whole file instead of rejecting it
  const [, startStr, endStr] = m;
  if (startStr === "" && endStr === "") return null; // "bytes=-" isn't a real range
  if (size <= 0) return "unsatisfiable";
  if (startStr === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(endStr);
    if (!Number.isInteger(suffix) || suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startStr);
  if (!Number.isInteger(start) || start < 0 || start >= size) return "unsatisfiable";
  const end = endStr === "" ? size - 1 : Number(endStr);
  if (!Number.isInteger(end) || end < start) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

/** Headers for a 206 response carrying `range` of a resource that is `size` bytes long. */
export function partialHeaders(range: ByteRange, size: number): Record<string, string> {
  return { "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${size}` };
}
