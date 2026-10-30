// The macOS copy of the server folder (server-dir.mjs): copied once per build, again for a new build, never written into the source.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writableServerDir } from "../server-dir.mjs";

function bundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sbdir-"));
  const from = path.join(root, "app", "server");
  fs.mkdirSync(path.join(from, "_node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(from, "server.js"), "// server");
  fs.writeFileSync(path.join(from, "_node_modules", "x", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  return { root, from, to: path.join(root, "data", "server") };
}

test("copies the server, keeps modes, leaves the source alone", () => {
  const { root, from, to } = bundle();
  const before = fs.readdirSync(from).sort();
  assert.equal(writableServerDir(from, to), to);
  assert.ok(fs.existsSync(path.join(to, "server.js")));
  assert.equal(fs.statSync(path.join(to, "_node_modules", "x", "run.sh")).mode & 0o111, 0o111);
  // the program renames inside the copy; the bundled folder must be untouched
  fs.renameSync(path.join(to, "_node_modules"), path.join(to, "node_modules"));
  assert.deepEqual(fs.readdirSync(from).sort(), before);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the same build is not copied again, and a new build is", () => {
  const { root, from, to } = bundle();
  writableServerDir(from, to);
  fs.renameSync(path.join(to, "_node_modules"), path.join(to, "node_modules"));
  writableServerDir(from, to);
  assert.ok(fs.existsSync(path.join(to, "node_modules")), "an unchanged build keeps the unpacked copy");
  assert.ok(!fs.existsSync(path.join(to, "_node_modules")));
  fs.writeFileSync(path.join(from, "server.js"), "// newer", { mode: 0o644 });
  fs.utimesSync(path.join(from, "server.js"), new Date(), new Date(Date.now() + 5000));
  writableServerDir(from, to);
  assert.ok(fs.existsSync(path.join(to, "_node_modules")), "a new build is copied fresh");
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unfinished copy (no marker) is redone", () => {
  const { root, from, to } = bundle();
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, "junk"), "half");
  writableServerDir(from, to);
  assert.ok(!fs.existsSync(path.join(to, "junk")));
  assert.ok(fs.existsSync(path.join(to, "server.js")));
  fs.rmSync(root, { recursive: true, force: true });
});
