import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNewer, parseVersion, signatureMessage, verifyRelease, signRelease, hashFile, readRelease } from "../update.mjs";

const rel = { flavor: "stitchbench", version: "1.7.1", sha256: "ab".repeat(32), size: 1234 };

test("versions compare as numbers", () => {
  assert.equal(isNewer("1.7.1", "1.7.0"), true);
  assert.equal(isNewer("1.10.0", "1.9.9"), true);
  assert.equal(isNewer("1.7.0", "1.7.0"), false);
  assert.equal(isNewer("1.6.9", "1.7.0"), false);
  assert.equal(isNewer("junk", "1.7.0"), false);
  assert.equal(isNewer("2.0.0", undefined), false);
  assert.deepEqual(parseVersion("v1.2.3-beta"), [1, 2, 3]);
});

test("the signed message is exact", () => {
  assert.equal(signatureMessage(rel), `stitch-release-v1\nstitchbench\n1.7.1\n${"ab".repeat(32)}\n1234`);
});

test("a real Ed25519 signature verifies, and any change breaks it", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" });
  const sig = signRelease(privateKey.export({ type: "pkcs8", format: "pem" }), rel);
  assert.equal(verifyRelease(pub, rel, sig), true);
  assert.equal(verifyRelease(pub, { ...rel, size: 1235 }, sig), false);
  assert.equal(verifyRelease(pub, { ...rel, flavor: "stitchshop" }, sig), false);
  assert.equal(verifyRelease(pub, { ...rel, version: "1.7.2" }, sig), false);
  assert.equal(verifyRelease(pub, { ...rel, sha256: "cd".repeat(32) }, sig), false);
  const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.equal(verifyRelease(other, rel, sig), false);
  assert.equal(verifyRelease(null, rel, sig), false);
  assert.equal(verifyRelease("not a key", rel, sig), false);
  assert.equal(verifyRelease(pub, rel, ""), false);
});

test("sha256 and size of a file", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upd-")), "a.bin");
  fs.writeFileSync(f, "hello");
  const r = await hashFile(f);
  assert.equal(r.size, 5);
  assert.equal(r.sha256, crypto.createHash("sha256").update("hello").digest("hex"));
});

test("the hub's answer must be well formed and https", () => {
  const ok = { version: "1.7.1", url: "https://x.test/a.exe", sha256: "AB".repeat(32), size: 10, signature: "c2ln" };
  assert.equal(readRelease(ok)?.sha256, "ab".repeat(32));
  assert.equal(readRelease({ ...ok, url: "http://x.test/a.exe" }), null);
  assert.equal(readRelease({ ...ok, sha256: "zz" }), null);
  assert.equal(readRelease({ ...ok, size: 0 }), null);
  assert.equal(readRelease({ ...ok, signature: "" }), null);
  assert.equal(readRelease(null), null);
});
