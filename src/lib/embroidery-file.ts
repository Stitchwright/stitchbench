// Reading what a customer's (or StitchFoundry's) embroidery file says about itself, so an order needn't have the stitch
// count typed in. Pure: pages, the server and checks share it, and it never throws (a file it can't read gives nulls).
//
// Only Tajima DST is read: it is the format every machine takes and StitchFoundry writes it. Its layout is public (a 512-byte
// text header, "LA:" the label, "ST:" the stitch records, "CO:" the colour changes, "+X: -X: +Y: -Y:" the extents in
// tenths of a millimetre, then 3-byte stitch records whose x and y movements are sums of the weights 1, 3, 9, 27 and 81,
// with a jump flag, a colour-change flag and an end record). Every other format (PES, JEF, EXP, VP3, XXX, U01...) is kept
// as the customer's file and named, but its numbers are typed in: reading them from a format without a sample file to
// check against would be a guess.
export type EmbroideryInfo = {
  format: string; // DST, or the file's extension in capitals, or "FILE"
  readable: boolean; // the numbers below come from the file
  label: string | null;
  stitches: number | null; // needle penetrations: the normal stitch records, not jumps, trims, colour changes or the end record
  colors: number | null; // colour changes + 1
  widthMm: number | null;
  heightMm: number | null;
};

export const MAX_DESIGN_BYTES = 10 * 1024 * 1024;
const MAX_RECORDS = 2_000_000;

const unreadable = (format: string): EmbroideryInfo => ({ format, readable: false, label: null, stitches: null, colors: null, widthMm: null, heightMm: null });

/** The extension in capitals ("left-chest.DST" -> "DST"), or "FILE". */
export function formatOf(fileName: string): string {
  const m = /\.([A-Za-z0-9]{2,4})$/.exec(fileName.trim());
  return m ? m[1].toUpperCase() : "FILE";
}

/** One 3-byte DST record: the movement in tenths of a millimetre and what kind of record it is. */
export function decodeDstRecord(b0: number, b1: number, b2: number): { dx: number; dy: number; kind: "stitch" | "jump" | "color" | "end" } {
  // x: b0 bits 0..3 (1, -1, 9, -9), b1 bits 0..3 (3, -3, 27, -27), b2 bits 2..3 (81, -81); y the same from the high bits
  const x = (b0 & 0x01 ? 1 : 0) - (b0 & 0x02 ? 1 : 0) + (b0 & 0x04 ? 9 : 0) - (b0 & 0x08 ? 9 : 0) + (b1 & 0x01 ? 3 : 0) - (b1 & 0x02 ? 3 : 0) + (b1 & 0x04 ? 27 : 0) - (b1 & 0x08 ? 27 : 0) + (b2 & 0x04 ? 81 : 0) - (b2 & 0x08 ? 81 : 0);
  const y = (b0 & 0x80 ? 1 : 0) - (b0 & 0x40 ? 1 : 0) + (b0 & 0x20 ? 9 : 0) - (b0 & 0x10 ? 9 : 0) + (b1 & 0x80 ? 3 : 0) - (b1 & 0x40 ? 3 : 0) + (b1 & 0x20 ? 27 : 0) - (b1 & 0x10 ? 27 : 0) + (b2 & 0x20 ? 81 : 0) - (b2 & 0x10 ? 81 : 0);
  const kind = b2 === 0xf3 ? "end" : (b2 & 0xc3) === 0xc3 ? "color" : (b2 & 0x83) === 0x83 ? "jump" : "stitch";
  return { dx: x, dy: y, kind };
}

const num = (header: string, tag: string): number | null => {
  const m = new RegExp(`${tag.replace(/[+-]/g, (c) => `\\${c}`)}:\\s*(\\d+)`).exec(header);
  return m ? Number(m[1]) : null;
};

function readDst(bytes: Uint8Array): EmbroideryInfo {
  if (bytes.length < 515) return unreadable("DST");
  const header = Array.from(bytes.subarray(0, 512), (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : " ")).join("");
  if (!/\bLA:/.test(header) || !/\bST:/.test(header)) return unreadable("DST");
  const label = /LA:(.{0,16})/.exec(header)?.[1]?.trim() || null;
  // The records are the truth when the header disagrees (a hand-edited or damaged header). The header's ST: counts every record
  // (jumps, trims and the end included), so it is not the stitch count; a stitch count is the normal stitch records only, since a
  // trim is a few small jumps and a long move several, and none of them sews.
  let stitches = 0;
  let colorChanges = 0;
  let x = 0;
  let y = 0;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  const end = Math.min(bytes.length - 2, 512 + MAX_RECORDS * 3);
  for (let i = 512; i < end; i += 3) {
    const r = decodeDstRecord(bytes[i], bytes[i + 1], bytes[i + 2]);
    if (r.kind === "end") break;
    if (r.kind === "stitch") stitches += 1;
    if (r.kind === "color") colorChanges += 1;
    x += r.dx;
    y += r.dy;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (stitches === 0) return unreadable("DST"); // nothing that sews: no count to price
  const px = num(header, "+X");
  const nx = num(header, "-X");
  const py = num(header, "+Y");
  const ny = num(header, "-Y");
  const headerWidth = px != null && nx != null ? (px + nx) / 10 : null;
  const headerHeight = py != null && ny != null ? (py + ny) / 10 : null;
  const widthMm = headerWidth ?? (maxX - minX) / 10;
  const heightMm = headerHeight ?? (maxY - minY) / 10;
  return { format: "DST", readable: true, label, stitches, colors: colorChanges + 1, widthMm: Math.round(widthMm * 10) / 10, heightMm: Math.round(heightMm * 10) / 10 };
}

export function readEmbroidery(fileName: string, bytes: Uint8Array): EmbroideryInfo {
  const format = formatOf(fileName);
  try {
    if (bytes.length === 0 || bytes.length > MAX_DESIGN_BYTES) return unreadable(format);
    if (format === "DST") return readDst(bytes);
  } catch {
    // a damaged file is still the customer's file: kept, just not read
  }
  return unreadable(format);
}
