// The pure parts of "A new version is ready" (docs/plans/ease-of-use-design.md section 1): comparing versions, the text
// the release signature covers, checking the signature, hashing the downloaded file. No Electron here, so it can be tested.
import crypto from "node:crypto";
import fs from "node:fs";

/** "1.7.10" -> [1,7,10]; null when it isn't plain x.y.z (a leading "v" and a "-pre"/"+build" tail are ignored). */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True only when `candidate` is a newer version than `current`; anything unreadable is "not newer". */
export function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The exact text the Ed25519 signature covers (no trailing newline). */
export function signatureMessage({ flavor, version, sha256, size }) {
  return `stitch-release-v1\n${flavor}\n${version}\n${String(sha256).toLowerCase()}\n${size}`;
}

/** True when `signature` (base64) is a good signature over the release's message by the PEM public key. Never throws. */
export function verifyRelease(publicKeyPem, release, signature) {
  try {
    if (!publicKeyPem || typeof signature !== "string" || !signature) return false;
    return crypto.verify(null, Buffer.from(signatureMessage(release)), crypto.createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** Signs a release (used by scripts/release/publish-release.mjs); returns base64. */
export function signRelease(privateKeyPem, release) {
  return crypto.sign(null, Buffer.from(signatureMessage(release)), crypto.createPrivateKey(privateKeyPem)).toString("base64");
}

/** The sha256 (hex) and size (bytes) of a file, read in a stream. */
export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    let size = 0;
    fs.createReadStream(file)
      .on("data", (d) => {
        h.update(d);
        size += d.length;
      })
      .on("error", reject)
      .on("end", () => resolve({ sha256: h.digest("hex"), size }));
  });
}

/** Checks the shape of the hub's answer; returns the clean release or null. `url` must be https. */
export function readRelease(body) {
  if (!body || typeof body !== "object") return null;
  const { version, url, sha256, size, signature } = body;
  if (!parseVersion(version) || typeof url !== "string" || !/^[0-9a-f]{64}$/i.test(String(sha256)) || !Number.isInteger(size) || size <= 0) return null;
  if (typeof signature !== "string" || !signature) return null;
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { version: String(version), url, sha256: String(sha256).toLowerCase(), size, signature };
}
