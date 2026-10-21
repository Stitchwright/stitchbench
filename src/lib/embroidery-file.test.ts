import test from "node:test";
import assert from "node:assert/strict";
import { decodeDstRecord, formatOf, readEmbroidery } from "./embroidery-file";

// Test files are written here from the format's public description (balanced-ternary weights 1, 3, 9, 27, 81), never taken from a program.
function digits(v: number): number[] {
  // balanced ternary, least significant first, five digits (|v| <= 121)
  const d: number[] = [];
  let n = v;
  for (let i = 0; i < 5; i++) {
    let r = ((n % 3) + 3) % 3;
    if (r === 2) r = -1;
    d.push(r);
    n = (n - r) / 3;
  }
  assert.equal(n, 0, `${v} is out of range`);
  return d;
}
function record(dx: number, dy: number, flag: "stitch" | "jump" | "color" = "stitch"): number[] {
  const [x1, x3, x9, x27, x81] = digits(dx);
  const [y1, y3, y9, y27, y81] = digits(dy);
  const b0 = (x1 > 0 ? 0x01 : 0) | (x1 < 0 ? 0x02 : 0) | (x9 > 0 ? 0x04 : 0) | (x9 < 0 ? 0x08 : 0) | (y9 < 0 ? 0x10 : 0) | (y9 > 0 ? 0x20 : 0) | (y1 < 0 ? 0x40 : 0) | (y1 > 0 ? 0x80 : 0);
  const b1 = (x3 > 0 ? 0x01 : 0) | (x3 < 0 ? 0x02 : 0) | (x27 > 0 ? 0x04 : 0) | (x27 < 0 ? 0x08 : 0) | (y27 < 0 ? 0x10 : 0) | (y27 > 0 ? 0x20 : 0) | (y3 < 0 ? 0x40 : 0) | (y3 > 0 ? 0x80 : 0);
  const b2 = 0x03 | (x81 > 0 ? 0x04 : 0) | (x81 < 0 ? 0x08 : 0) | (y81 < 0 ? 0x10 : 0) | (y81 > 0 ? 0x20 : 0) | (flag === "jump" ? 0x80 : flag === "color" ? 0xc0 : 0);
  return [b0, b1, b2];
}
function dst(records: number[][], header: Record<string, string | number> = {}): Uint8Array {
  const h = `LA:${String(header.LA ?? "TEST").padEnd(16)}\rST:${String(header.ST ?? records.length).padStart(7)}\rCO:${String(header.CO ?? 1).padStart(3)}\r`
    + `+X:${String(header.PX ?? 0).padStart(5)}\r-X:${String(header.NX ?? 0).padStart(5)}\r+Y:${String(header.PY ?? 0).padStart(5)}\r-Y:${String(header.NY ?? 0).padStart(5)}\r`;
  const out = new Uint8Array(512 + records.length * 3 + 3);
  out.fill(0x20, 0, 512);
  for (let i = 0; i < h.length; i++) out[i] = h.charCodeAt(i);
  records.forEach((r, i) => out.set(r, 512 + i * 3));
  out.set([0, 0, 0xf3], 512 + records.length * 3);
  return out;
}

test("single records decode as the format describes", () => {
  assert.deepEqual(decodeDstRecord(0x01, 0x00, 0x03), { dx: 1, dy: 0, kind: "stitch" });
  assert.deepEqual(decodeDstRecord(0x80, 0x00, 0x03), { dx: 0, dy: 1, kind: "stitch" });
  assert.deepEqual(decodeDstRecord(0x00, 0x00, 0xc3).kind, "color");
  assert.deepEqual(decodeDstRecord(0x00, 0x00, 0x83).kind, "jump");
  assert.deepEqual(decodeDstRecord(0x00, 0x00, 0xf3).kind, "end");
});

test("every movement from -121 to 121 survives writing and reading", () => {
  for (let v = -121; v <= 121; v++) {
    const r = record(v, 0 - v);
    const d = decodeDstRecord(r[0], r[1], r[2]);
    assert.equal(d.dx, v);
    assert.equal(d.dy, 0 - v);
  }
});

test("a file's stitch count, colours and size come from it", () => {
  // a 20 x 10 mm box (200 x 100 tenths of a millimetre), sewn in two colours
  const recs = [record(100, 0), record(100, 0), record(0, 100), record(0, 0, "color"), record(-100, 0), record(-100, 0), record(0, -100)];
  const info = readEmbroidery("box.DST", dst(recs, { CO: 1, PX: 200, NX: 0, PY: 100, NY: 0 }));
  assert.equal(info.readable, true);
  assert.equal(info.format, "DST");
  assert.equal(info.stitches, 7);
  assert.equal(info.colors, 2);
  assert.equal(info.widthMm, 20);
  assert.equal(info.heightMm, 10);
  assert.equal(info.label, "TEST");
});

test("the records win over a wrong header, and a header with no extents is measured", () => {
  const recs = [record(100, 0), record(0, 50), record(-100, 0)];
  const wrong = readEmbroidery("a.dst", dst(recs, { ST: 999, CO: 7 }));
  assert.equal(wrong.stitches, 3);
  assert.equal(wrong.colors, 1);
  assert.equal(wrong.widthMm, 0); // the header says zero extents, so the header is used as written
  const bare = dst(recs).slice();
  const text = Array.from(bare.subarray(0, 512)).map((c) => String.fromCharCode(c)).join("").replace(/\+X:|-X:|\+Y:|-Y:/g, "xx:");
  for (let i = 0; i < 512; i++) bare[i] = text.charCodeAt(i);
  const measured = readEmbroidery("a.dst", bare);
  assert.equal(measured.widthMm, 10);
  assert.equal(measured.heightMm, 5);
});

test("other formats are kept, named and not read; damaged files never throw", () => {
  assert.deepEqual(readEmbroidery("heart.pes", new Uint8Array([35, 80, 69, 83])), { format: "PES", readable: false, label: null, stitches: null, colors: null, widthMm: null, heightMm: null });
  assert.equal(readEmbroidery("x.dst", new Uint8Array(10)).readable, false);
  assert.equal(readEmbroidery("x.dst", new Uint8Array(600)).readable, false);
  assert.equal(readEmbroidery("noext", new Uint8Array(0)).format, "FILE");
  assert.equal(formatOf("Logo.Final.Dst"), "DST");
});
