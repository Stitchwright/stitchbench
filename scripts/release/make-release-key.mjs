// One time: makes the key that signs program releases. The private key goes to <Documents>\StitchBench release key.txt
// (never printed, never in the repo); the public key goes into desktop/release-key.mjs. See README.md here.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const docs = path.join(process.env.USERPROFILE ?? os.homedir(), "Documents");
const keyFile = path.join(docs, "StitchBench release key.txt");
const pubFile = path.join(root, "desktop", "release-key.mjs");

if (fs.existsSync(keyFile)) {
  console.error(`${keyFile} already exists. Not making a new key (programs already installed would stop accepting updates).`);
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const priv = privateKey.export({ type: "pkcs8", format: "pem" });
const pub = publicKey.export({ type: "spki", format: "pem" }).trim();

fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(keyFile, priv, { flag: "wx" });
fs.writeFileSync(
  pubFile,
  `// The public half of the release signing key (docs/plans/ease-of-use-design.md section 1). Written by
// scripts/release/make-release-key.mjs. While it is null the program refuses to update itself.
export const RELEASE_PUBLIC_KEY = ${JSON.stringify(pub + "\n")};
`,
);
console.log(`Saved the private key to ${keyFile}. Keep it safe; never share it.`);
console.log("Public key (now in desktop/release-key.mjs):");
console.log(pub);
