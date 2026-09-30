// Unit tests for the Range parsing used by /api/library/file (npm run test:unit). No server needed: signing in
// from curl isn't possible, so this is the way to check the range math instead of hitting the route directly.
import test from "node:test";
import assert from "node:assert/strict";
import { parseRange, partialHeaders } from "./range";

const SIZE = 1000;

test("no Range header: serve the whole file", () => {
  assert.equal(parseRange(null, SIZE), null);
  assert.equal(parseRange(undefined, SIZE), null);
  assert.equal(parseRange("", SIZE), null);
});

test("a plain byte range", () => {
  assert.deepEqual(parseRange("bytes=0-99", SIZE), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=500-599", SIZE), { start: 500, end: 599 });
  assert.deepEqual(parseRange(" bytes=100-100 ", SIZE), { start: 100, end: 100 });
});

test("an open-ended range reads to the end of the file", () => {
  assert.deepEqual(parseRange("bytes=900-", SIZE), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=0-", SIZE), { start: 0, end: 999 });
});

test("a suffix range reads the last N bytes", () => {
  assert.deepEqual(parseRange("bytes=-500", SIZE), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=-10000", SIZE), { start: 0, end: 999 }, "asking for more than the file clamps to the start");
});

test("an end past the file is clamped, not rejected", () => {
  assert.deepEqual(parseRange("bytes=999-5000", SIZE), { start: 999, end: 999 });
});

test("a range that starts past the end of the file is unsatisfiable", () => {
  assert.equal(parseRange("bytes=1000-1999", SIZE), "unsatisfiable");
  assert.equal(parseRange("bytes=5000-", SIZE), "unsatisfiable");
});

test("a backwards or non-numeric range is unsatisfiable", () => {
  assert.equal(parseRange("bytes=500-100", SIZE), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", SIZE), "unsatisfiable");
});

test("against an empty file, any byte range is unsatisfiable", () => {
  assert.equal(parseRange("bytes=0-0", 0), "unsatisfiable");
  assert.equal(parseRange("bytes=-1", 0), "unsatisfiable");
});

test("malformed or multi-range headers are ignored (served as a full 200, same as no Range header)", () => {
  assert.equal(parseRange("bytes=-", SIZE), null);
  assert.equal(parseRange("bytes=0-99,200-299", SIZE), null);
  assert.equal(parseRange("items=0-99", SIZE), null);
  assert.equal(parseRange("not a range", SIZE), null);
});

test("206 headers carry the chunk length and the Content-Range for the full size", () => {
  assert.deepEqual(partialHeaders({ start: 0, end: 99 }, SIZE), { "Content-Length": "100", "Content-Range": "bytes 0-99/1000" });
  assert.deepEqual(partialHeaders({ start: 999, end: 999 }, SIZE), { "Content-Length": "1", "Content-Range": "bytes 999-999/1000" });
});
