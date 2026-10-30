// Absolute symbolic links in the server folder become real copies (materialize-links.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeLinks, remainingLinks } from "../materialize-links.mjs";

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sblink-"));
  const standalone = path.join(root, "standalone", "node_modules", "pg");
  fs.mkdirSync(path.join(standalone, "lib"), { recursive: true });
  fs.writeFileSync(path.join(standalone, "package.json"), '{"name":"pg"}');
  fs.writeFileSync(path.join(standalone, "lib", "index.js"), "// pg");
  const out = path.join(root, "out");
  fs.mkdirSync(path.join(out, ".next", "node_modules", "@prisma"), { recursive: true });
  fs.symlinkSync(standalone, path.join(out, ".next", "node_modules", "pg-abc123"));
  fs.symlinkSync(standalone, path.join(out, ".next", "node_modules", "@prisma", "client-def456"));
  fs.writeFileSync(path.join(out, "server.js"), "// server");
  return { root, out, standalone };
}

test("every link becomes a real directory with the target's files", () => {
  const { root, out } = tree();
  assert.equal(remainingLinks(out).length, 2);
  assert.equal(materializeLinks(out).length, 2);
  assert.deepEqual(remainingLinks(out), []);
  for (const p of [".next/node_modules/pg-abc123", ".next/node_modules/@prisma/client-def456"]) {
    assert.equal(fs.lstatSync(path.join(out, p)).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(out, p, "lib", "index.js"), "utf8"), "// pg");
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("a copy no longer depends on the original", () => {
  const { root, out } = tree();
  materializeLinks(out);
  fs.rmSync(path.join(root, "standalone"), { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(out, ".next", "node_modules", "pg-abc123", "package.json")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a link to something that is not there stops the build with a clear message", () => {
  const { root, out } = tree();
  fs.rmSync(path.join(root, "standalone"), { recursive: true, force: true });
  assert.throws(() => materializeLinks(out), /does not exist on this machine/);
  fs.rmSync(root, { recursive: true, force: true });
});
