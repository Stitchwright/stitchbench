// The order of backup folders: newest first, by the numbers in the name, so ten or more backups in one second (a
// fast machine running the tests, or "Back up now" clicked twice) still prune the right ones. No database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBackups, newestFirst } from "../backup.mjs";

test("backups in the same second sort by their number, not as text", () => {
  const names = ["stitchbench-2026-09-30-13-47-56-10", "stitchbench-2026-09-30-13-47-56-9", "stitchbench-2026-09-30-13-47-56", "stitchbench-2026-09-30-13-47-56-2", "stitchbench-2026-09-30-13-47-57", "stitchbench-2026-09-30-13-47-55-3"];
  assert.deepEqual([...names].sort(newestFirst), [
    "stitchbench-2026-09-30-13-47-57",
    "stitchbench-2026-09-30-13-47-56-10",
    "stitchbench-2026-09-30-13-47-56-9",
    "stitchbench-2026-09-30-13-47-56-2",
    "stitchbench-2026-09-30-13-47-56",
    "stitchbench-2026-09-30-13-47-55-3",
  ]);
  // Names from before 1.4.2 had no seconds: still older than anything from a later minute, newer than an earlier one.
  assert.deepEqual(["stitchbench-2026-09-27-01-04", "stitchbench-2026-09-27-01-05-00", "stitchbench-2026-09-27-01-03-59"].sort(newestFirst), [
    "stitchbench-2026-09-27-01-05-00",
    "stitchbench-2026-09-27-01-04",
    "stitchbench-2026-09-27-01-03-59",
  ]);
});

test("listBackups lists the newest first even past nine in one second", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-order-"));
  try {
    const stamp = "stitchbench-2026-09-30-13-47-56";
    for (const n of [stamp, ...Array.from({ length: 11 }, (_, i) => `${stamp}-${i + 2}`)]) {
      fs.mkdirSync(path.join(root, n));
      fs.writeFileSync(path.join(root, n, "manifest.json"), "{}");
    }
    const listed = listBackups(root).map((p) => path.basename(p));
    assert.equal(listed[0], `${stamp}-12`);
    assert.equal(listed[1], `${stamp}-11`);
    assert.equal(listed.at(-1), stamp);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
