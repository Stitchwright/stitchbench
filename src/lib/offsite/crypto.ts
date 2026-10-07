// Off-site backup encryption (later-round-1-design.md 1.3). Pure Node `crypto`, no database, so the program, the restore
// script and the check share it.
//
// A key pair per company: the program keeps only the public half and the owner keeps the private half on the recovery
// sheet (52 characters in groups of four). Each file gets a fresh data key, wrapped to the public key (an ephemeral X25519
// agreement, HKDF-SHA256, AES-256-GCM) in a clear header that carries the key's fingerprint. The body is 64 KB AES-256-GCM
// chunks whose nonce is a random prefix + the chunk number + a last-chunk flag, so a chunk can't be dropped, reordered or
// the file cut short without the decryption failing.
//
//   file   = "SBOB1\n" | u32 header length | header JSON | chunk*
//   chunk  = u32 length | ciphertext + 16-byte tag
//   header = { v, keyId, eph (base64), wrapNonce, wrapped, prefix (base64, 7 bytes), chunk }
import crypto from "node:crypto";
import { Transform } from "node:stream";

export const CHUNK = 64 * 1024;
const MAGIC = Buffer.from("SBOB1\n");
const TAG = 16;
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const INFO = Buffer.from("stitchbench-offsite-v1");
/** The most a header may claim to be: a damaged file must not make the reader allocate gigabytes. */
const MAX_HEADER = 4096;

export class OffsiteCryptoError extends Error {}

export type KeyPair = { publicKey: Buffer; privateKey: Buffer };

/** A new X25519 key pair as raw 32-byte keys. */
export function makeKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return { publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(SPKI.length), privateKey: privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8.length) };
}

const pubObject = (raw: Buffer) => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
const privObject = (raw: Buffer) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });

/** The public key derived from a private one (to check a typed recovery key against what the program holds). */
export function publicFromPrivate(privateKey: Buffer): Buffer {
  return crypto.createPublicKey(privObject(privateKey)).export({ format: "der", type: "spki" }).subarray(SPKI.length);
}

/** A short fingerprint of the public key, in the header and on the sheet: eight bytes of its SHA-256 as 16 hex characters. */
export const keyIdOf = (publicKey: Buffer) => crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);

// ---------- the recovery key as text ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The private key as 52 characters in 13 groups of four ("ABCD-EFGH-..."). */
export function keyToText(privateKey: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of privateKey) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

/** The recovery key typed back: spaces, dashes and case don't matter; anything else, or the wrong length, is refused. */
export function keyFromText(text: string): Buffer {
  const s = text.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z2-7]{52}$/.test(s)) throw new OffsiteCryptoError("A recovery key is 52 letters and digits in 13 groups of four. Check each group against the sheet.");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out.slice(0, 32));
}

// ---------- the file ----------
const nonce = (prefix: Buffer, n: number, last: boolean) => {
  const b = Buffer.alloc(12);
  prefix.copy(b, 0);
  b.writeUInt32BE(n, 7);
  b[11] = last ? 1 : 0;
  return b;
};

function wrapKey(shared: Buffer, eph: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([eph, recipient]), INFO, 32));
}

/** Encrypts what is written to it for the holder of `publicKey`. */
export function encryptStream(publicKey: Buffer): Transform {
  const dataKey = crypto.randomBytes(32);
  const prefix = crypto.randomBytes(7);
  const eph = crypto.generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI.length);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubObject(publicKey) });
  const wrapNonce = crypto.randomBytes(12);
  const keyId = keyIdOf(publicKey);
  const w = crypto.createCipheriv("aes-256-gcm", wrapKey(shared, ephPub, publicKey), wrapNonce);
  w.setAAD(Buffer.from(keyId));
  const wrapped = Buffer.concat([w.update(dataKey), w.final(), w.getAuthTag()]);
  const header = Buffer.from(JSON.stringify({ v: 1, keyId, eph: ephPub.toString("base64"), wrapNonce: wrapNonce.toString("base64"), wrapped: wrapped.toString("base64"), prefix: prefix.toString("base64"), chunk: CHUNK }));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(header.length);
  let pending: Buffer = Buffer.alloc(0);
  let n = 0;
  let started = false;
  const seal = (plain: Buffer, last: boolean) => {
    const c = crypto.createCipheriv("aes-256-gcm", dataKey, nonce(prefix, n++, last));
    const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, body]);
  };
  const start = () => {
    if (started) return Buffer.alloc(0);
    started = true;
    return Buffer.concat([MAGIC, head, header]);
  };
  return new Transform({
    transform(data: Buffer, _enc, cb) {
      try {
        const out: Buffer[] = [start()];
        pending = pending.length ? Buffer.concat([pending, data]) : data;
        // Hold back the last full chunk: only the end of the stream knows which chunk is the last.
        while (pending.length > CHUNK) {
          out.push(seal(pending.subarray(0, CHUNK), false));
          pending = pending.subarray(CHUNK);
        }
        cb(null, Buffer.concat(out));
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      try {
        cb(null, Buffer.concat([start(), seal(pending, true)]));
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

/** Decrypts what is written to it with `privateKey`; errors (an OffsiteCryptoError) say what is wrong in plain words. */
export function decryptStream(privateKey: Buffer): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let stage: "magic" | "header" | "chunks" = "magic";
  let headerLen = 0;
  let dataKey: Buffer | null = null;
  let prefix: Buffer = Buffer.alloc(0);
  let n = 0;
  let held: Buffer | null = null; // the newest frame, kept until the next one shows it was not the last
  const open = (frame: Buffer, last: boolean): Buffer => {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", dataKey!, nonce(prefix, n++, last));
      d.setAuthTag(frame.subarray(frame.length - TAG));
      return Buffer.concat([d.update(frame.subarray(0, frame.length - TAG)), d.final()]);
    } catch {
      throw new OffsiteCryptoError("The backup is damaged: a part of it was changed, left out or cut off.");
    }
  };
  const readHeader = (h: Buffer) => {
    let j: { v?: number; keyId?: string; eph?: string; wrapNonce?: string; wrapped?: string; prefix?: string };
    try {
      j = JSON.parse(h.toString("utf8"));
    } catch {
      throw new OffsiteCryptoError("This is not a StitchBench backup file.");
    }
    if (j.v !== 1 || !j.eph || !j.wrapNonce || !j.wrapped || !j.prefix || !j.keyId) throw new OffsiteCryptoError("This is not a StitchBench backup file, or it is from a newer version.");
    const mine = keyIdOf(publicFromPrivate(privateKey));
    if (j.keyId !== mine) throw new OffsiteCryptoError("This recovery key does not open this backup. It was made with a different key: use the sheet printed when the backup was set up.");
    const eph = Buffer.from(j.eph, "base64");
    try {
      const shared = crypto.diffieHellman({ privateKey: privObject(privateKey), publicKey: pubObject(eph) });
      const wrapped = Buffer.from(j.wrapped, "base64");
      const d = crypto.createDecipheriv("aes-256-gcm", wrapKey(shared, eph, publicFromPrivate(privateKey)), Buffer.from(j.wrapNonce, "base64"));
      d.setAAD(Buffer.from(j.keyId));
      d.setAuthTag(wrapped.subarray(wrapped.length - TAG));
      dataKey = Buffer.concat([d.update(wrapped.subarray(0, wrapped.length - TAG)), d.final()]);
    } catch {
      throw new OffsiteCryptoError("This recovery key does not open this backup.");
    }
    prefix = Buffer.from(j.prefix, "base64");
  };
  const drain = (out: Buffer[]) => {
    for (;;) {
      if (stage === "magic") {
        if (buf.length < MAGIC.length + 4) return;
        if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new OffsiteCryptoError("This is not a StitchBench backup file.");
        headerLen = buf.readUInt32BE(MAGIC.length);
        if (headerLen < 2 || headerLen > MAX_HEADER) throw new OffsiteCryptoError("This is not a StitchBench backup file.");
        buf = buf.subarray(MAGIC.length + 4);
        stage = "header";
      } else if (stage === "header") {
        if (buf.length < headerLen) return;
        readHeader(buf.subarray(0, headerLen));
        buf = buf.subarray(headerLen);
        stage = "chunks";
      } else {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len < TAG || len > CHUNK + TAG) throw new OffsiteCryptoError("The backup is damaged: a part of it was changed, left out or cut off.");
        if (buf.length < 4 + len) return;
        const frame = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        if (held) out.push(open(held, false));
        held = Buffer.from(frame);
      }
    }
  };
  return new Transform({
    transform(data: Buffer, _enc, cb) {
      try {
        buf = buf.length ? Buffer.concat([buf, data]) : data;
        const out: Buffer[] = [];
        drain(out);
        cb(null, Buffer.concat(out));
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      try {
        if (stage !== "chunks" || buf.length || !held) throw new OffsiteCryptoError("The backup is damaged: it ends before it should.");
        cb(null, open(held, true));
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

async function through(t: Transform, data: Buffer): Promise<Buffer> {
  const parts: Buffer[] = [];
  t.on("data", (c: Buffer) => parts.push(c));
  const done = new Promise<void>((resolve, reject) => {
    t.on("end", resolve);
    t.on("error", reject);
  });
  t.end(data);
  await done;
  return Buffer.concat(parts);
}

/** A small object (a photo) sealed in one go. */
export const encryptBuffer = (data: Buffer, publicKey: Buffer) => through(encryptStream(publicKey), data);
export const decryptBuffer = (data: Buffer, privateKey: Buffer) => through(decryptStream(privateKey), data);

export const sha256Hex = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");
