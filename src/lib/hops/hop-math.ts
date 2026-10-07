// Shop hop passports (shop-features-round-2-design.md 4.6): the pure part. A passport's code as typed or scanned, the
// prize rule in words, and the signature on a stamp the program sends to the hub. StitchHub checks the same string
// (see the Built note: SBHS1). No "server-only", no database.
import crypto from "node:crypto";
import { canonical, sha256hex, type KeyPair } from "@/lib/partner-signing";

/**
 * A passport code as the shopper shows it ("HOP-7K2M-9QXD", a QR code with the same text, or typed "7k2m 9qxd"): the 8
 * letters and digits, upper case, O read as 0 and I or L as 1. Null when it can't be one.
 */
export function passportCode(raw: string | null | undefined): string | null {
  let t = String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  // A QR code may carry the hub's passport address: the code is its last part.
  const m = /HOP([0-9A-Z]{8})$/.exec(t);
  if (m) t = m[1];
  else if (t.startsWith("HOP") && t.length === 11) t = t.slice(3);
  t = t.replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-Z]{8}$/.test(t) ? t : null;
}

/** "HOP-7K2M-9QXD" for the screen. */
export const passportWords = (code: string) => `HOP-${code.slice(0, 4)}-${code.slice(4)}`;

/** The prize rule as saved ("all", "any:6") from the form's choice and number. */
export function ruleOf(kind: string | null | undefined, n: number | null | undefined): string {
  if (kind === "any") {
    const k = Number(n);
    if (!Number.isInteger(k) || k < 1 || k > 200) throw new Error("Say how many shops' stamps win, like 6.");
    return `any:${k}`;
  }
  return "all";
}

/** "Stamps from all 10 shops" / "Stamps from any 6 shops". */
export function ruleWords(rule: string, shops: number): string {
  const m = /^any:(\d+)$/.exec(rule);
  return m ? `Stamps from any ${m[1]} shops` : `Stamps from all ${shops} shop${shops === 1 ? "" : "s"}`;
}

export type StampFields = { hopId: string; shopRef: string; stampId: string; passport: string; at: string };

/** The text a stamp's signature covers: SBHS1, the hop, the shop, the stamp's own id, the passport and the time. */
export const stampString = (f: StampFields) => ["SBHS1", f.hopId, f.shopRef, f.stampId, f.passport, f.at, sha256hex(canonical(f))].join("\n");

export type StampSig = { v: 1; pub: string; sig: string };

/** Signs a stamp with the shop's partner key (Ed25519; the public half goes along, pinned by the hub when the shop joined). */
export function signStamp(key: KeyPair, f: StampFields): StampSig {
  const priv = crypto.createPrivateKey({ key: Buffer.from(key.privateKey, "base64"), format: "der", type: "pkcs8" });
  return { v: 1, pub: key.publicKey, sig: crypto.sign(null, Buffer.from(stampString(f)), priv).toString("base64") };
}

/** The hub's side of the check (and the check script's): true when the signature is the public key's over these fields. */
export function verifyStamp(sig: StampSig, f: StampFields): boolean {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(sig.pub, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(stampString(f)), pub, Buffer.from(sig.sig, "base64"));
  } catch {
    return false;
  }
}
