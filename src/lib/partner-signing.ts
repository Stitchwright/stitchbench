// Signatures on partner messages and invites: the pure part (no database). StitchHub's src/partnersign.mjs is the other
// copy; the two must build the same strings. Ed25519. A public key travels as base64 of its SPKI DER. A message is signed
// over
//   SBPM1 \n link id \n sender's side \n type \n message id \n sequence \n timestamp \n sha256 of the canonical data
// so a changed payload, type, id, link or sender fails, and so does a replay under another id. The keys and the
// bookkeeping (pinning, sequence numbers) are in partner-keys.ts and partners.ts.
import crypto from "node:crypto";

/** JSON with every object's keys sorted: the same text on both sides whatever order a database gives the keys back in. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x === undefined ? null : x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export const sha256hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** A message's data as the hub will carry it (what JSON keeps): what both sides hash. */
export const asSent = (data: unknown): unknown => JSON.parse(JSON.stringify(data ?? null));

export type KeyPair = { publicKey: string; privateKey: string };

/** A new key: the public half as base64 SPKI DER, the private half as base64 PKCS8 DER. */
export function newKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
}

const publicKeyObject = (b64: unknown): crypto.KeyObject | null => {
  if (typeof b64 !== "string" || b64.length > 200) return null;
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch {
    return null;
  }
};
export const isPublicKey = (b64: unknown) => publicKeyObject(b64) !== null;

/** What a company's public key is called out loud: the first 10 bytes of its sha256, five groups of four hex digits. */
export function fingerprint(publicKey: string): string {
  const hex = crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 20).toUpperCase();
  return (hex.match(/.{4}/g) ?? []).join("-");
}

function signText(privateKey: string, text: string): string {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
  return crypto.sign(null, Buffer.from(text), key).toString("base64");
}

function verifyText(publicKey: unknown, text: string, sig: unknown): boolean {
  const key = publicKeyObject(publicKey);
  if (!key || typeof sig !== "string" || sig.length > 200) return false;
  try {
    return crypto.verify(null, Buffer.from(text), key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

// ----- messages -----

export type SigEnvelope = { v: 1; pub: string; seq: string; ts: string; sig: string };
export type SignedFields = { linkId: string; fromSide: string; type: string; id: string; data: unknown };

const messageText = (m: SignedFields & { seq: string; ts: string }) => ["SBPM1", m.linkId, m.fromSide, m.type, m.id, m.seq, m.ts, sha256hex(canonical(asSent(m.data)))].join("\n");

/** The envelope as received, or null when it isn't one. `seq` stays text: it is a millisecond clock, past 32 bits. */
export function sigShape(s: unknown): SigEnvelope | null {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const o = s as Record<string, unknown>;
  if (o.v !== 1 || typeof o.pub !== "string" || typeof o.sig !== "string" || !/^\d{1,18}$/.test(String(o.seq)) || typeof o.ts !== "string" || o.ts.length > 40 || Number.isNaN(Date.parse(o.ts))) return null;
  return { v: 1, pub: o.pub, seq: String(o.seq), ts: o.ts, sig: o.sig };
}

export function signMessage(key: KeyPair, m: SignedFields, seq: string, ts = new Date().toISOString()): SigEnvelope {
  return { v: 1, pub: key.publicKey, seq, ts, sig: signText(key.privateKey, messageText({ ...m, seq, ts })) };
}

/** True when `env` is a valid signature, by the key it names, over exactly this message. Whether that key is the partner's is for the caller. */
export function verifyMessageSig(env: SigEnvelope, m: SignedFields): boolean {
  return verifyText(env.pub, messageText({ ...m, seq: env.seq, ts: env.ts }), env.sig);
}

// ----- invites -----

export type Proof = { issuedAt: string; sig: string };
const inviteText = (o: { publicKey: string; side: string; shopRef: string; terms: unknown; issuedAt: string }) =>
  ["SBINV1", fingerprint(o.publicKey), o.side, o.shopRef, sha256hex(canonical(asSent(o.terms ?? {}))), o.issuedAt].join("\n");
const redeemText = (o: { codeHash: string; shopRef: string; issuedAt: string }) => ["SBRDM1", o.codeHash, o.shopRef, o.issuedAt].join("\n");

/** What the hub is given for a partner code: the digest it keeps (sha256 of the 12 letters and digits). */
export const codeHashOf = (normalizedCode: string) => sha256hex(normalizedCode);

export function signInvite(key: KeyPair, o: { side: string; shopRef: string; terms: unknown }, issuedAt = new Date().toISOString()): Proof {
  return { issuedAt, sig: signText(key.privateKey, inviteText({ ...o, publicKey: key.publicKey, issuedAt })) };
}
export function verifyInvite(publicKey: string, o: { side: string; shopRef: string; terms: unknown }, proof: unknown): boolean {
  const p = proof as Proof | null;
  return !!p && typeof p.issuedAt === "string" && verifyText(publicKey, inviteText({ ...o, publicKey, issuedAt: p.issuedAt }), p.sig);
}
export function signRedeem(key: KeyPair, o: { codeHash: string; shopRef: string }, issuedAt = new Date().toISOString()): Proof {
  return { issuedAt, sig: signText(key.privateKey, redeemText({ ...o, issuedAt })) };
}
export function verifyRedeem(publicKey: string, o: { codeHash: string; shopRef: string }, proof: unknown): boolean {
  const p = proof as Proof | null;
  return !!p && typeof p.issuedAt === "string" && verifyText(publicKey, redeemText({ ...o, issuedAt: p.issuedAt }), p.sig);
}
