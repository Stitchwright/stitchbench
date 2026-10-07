// Tiny dependency-free PNG maker for the demo's fabric-swatch photos (no downloads, no image libraries): a pattern
// function paints each pixel, zlib compresses the rows. Used by seed-demo.ts for the online shop's item photos.
import zlib from "node:zlib";

type RGB = [number, number, number];
export type SwatchKind = "gingham" | "stripes" | "dots" | "plaid" | "gradient" | "solid" | "leaves" | "squares";

function crc32(buf: Buffer): number {
  return zlib.crc32(buf) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encode(w: number, h: number, px: (x: number, y: number) => RGB): Uint8Array<ArrayBuffer> {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

const mix = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

/** A square swatch of one pattern in two or three colours (hex strings like "#c0561f"). */
export function swatchPng(kind: SwatchKind, colors: string[], size = 320): Uint8Array<ArrayBuffer> {
  const c = colors.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as RGB);
  const [a, b = c[0], d = c[1] ?? c[0]] = c;
  const cell = Math.round(size / 8);
  const px = (x: number, y: number): RGB => {
    // A faint weave texture so it reads as cloth, not a flat fill.
    const weave = ((x + y) % 4 === 0 ? -6 : 0) + ((x * 7 + y * 13) % 5) - 2;
    const t = (col: RGB): RGB => [col[0] + weave, col[1] + weave, col[2] + weave].map((v) => Math.max(0, Math.min(255, v))) as RGB;
    switch (kind) {
      case "gingham": {
        const bx = Math.floor(x / cell) % 2, by = Math.floor(y / cell) % 2;
        return t(bx && by ? mix(a, b, 0.9) : bx || by ? mix(a, b, 0.45) : a);
      }
      case "stripes":
        return t(Math.floor(x / (cell / 1.5)) % 2 ? b : a);
      case "dots": {
        const cx = (x % cell) - cell / 2, cy = (y % cell) - cell / 2;
        const off = Math.floor(y / cell) % 2 ? cell / 2 : 0;
        const dx = ((x + off) % cell) - cell / 2;
        return t(dx * dx + cy * cy < (cell * 0.22) ** 2 ? b : a);
        void cx;
      }
      case "plaid": {
        const vx = Math.floor(x / cell) % 4 === 0 ? 1 : Math.floor(x / cell) % 4 === 2 ? 0.5 : 0;
        const vy = Math.floor(y / cell) % 4 === 0 ? 1 : Math.floor(y / cell) % 4 === 2 ? 0.5 : 0;
        const thin = x % (cell * 2) < 3 || y % (cell * 2) < 3 ? d : null;
        return t(thin ?? mix(a, b, Math.max(vx, vy) * 0.7 + (vx && vy ? 0.2 : 0)));
      }
      case "gradient":
        return t(mix(a, b, (x + y) / (2 * size)));
      case "leaves": {
        const gx = (x % (cell * 2)) - cell, gy = (y % (cell * 2)) - cell;
        const sh = ((Math.floor(x / (cell * 2)) + Math.floor(y / (cell * 2))) % 2) ? b : d;
        return t(Math.abs(gx) + Math.abs(gy) < cell * 0.8 ? sh : a);
      }
      case "squares": {
        const sq = (Math.floor(x / cell) + Math.floor(y / cell)) % 3;
        const gap = x % cell < 2 || y % cell < 2;
        return t(gap ? d : sq === 0 ? a : sq === 1 ? b : mix(a, b, 0.5));
      }
      default:
        return t(a);
    }
  };
  return encode(size, size, px);
}
