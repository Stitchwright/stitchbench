import "server-only";
// The hosted app's own signer for the Companies switch (a *hosting* key kept in Railway's variables, never the owner's
// key), and the development key for next dev, check scripts and local test builds. modules-design.md section 6.2.
// Never export anything from here out of a "use server" file: an exported signGrant would sign keys for anyone.
import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { encodeLicense, newKeyId, type LicensePayload } from "@/lib/license";
import { LICENSE_PUBLIC_KEYS } from "@/lib/license-keys";
import type { ModuleId } from "@/lib/module-info";
import { devKeysAllowed, isDesktop } from "@/lib/modules";
import { todayIn } from "@/lib/time-zone";

export type Signer = { kid: string; key: KeyObject; scope: "hosted" | "dev" };

const memo = new Map<string, Signer | null>();
let warned = false;

function readHostedKey(raw: string): KeyObject | null {
  const text = raw.trim();
  const pem = text.startsWith("-----") ? text.replace(/\\n/g, "\n") : Buffer.from(text, "base64").toString("utf8");
  try {
    return crypto.createPrivateKey({ key: pem, format: "pem" });
  } catch {
    return null;
  }
}

/**
 * The signer this server may switch modules on with: the hosting key when LICENSE_HOSTED_KEY matches the compiled
 * public half of LICENSE_HOSTED_KID (default h1), else the development key where development keys count, else null.
 * The Windows program never has one. Memoised per process, keyed by the two variables' values.
 */
export function hostedSigner(): Signer | null {
  if (isDesktop()) return null;
  const raw = process.env.LICENSE_HOSTED_KEY ?? "";
  const kid = process.env.LICENSE_HOSTED_KID || "h1";
  const memoKey = `${kid}\n${raw}`;
  if (memo.has(memoKey)) return memo.get(memoKey)!;
  let out: Signer | null = null;
  if (raw) {
    const pub = Object.hasOwn(LICENSE_PUBLIC_KEYS, kid) ? LICENSE_PUBLIC_KEYS[kid] : undefined;
    const key = readHostedKey(raw);
    const x = key ? (crypto.createPublicKey(key).export({ format: "jwk" }) as { x?: string }).x : undefined;
    if (pub && pub.scope === "hosted" && !pub.retired && key && x === pub.x) out = { kid, key, scope: "hosted" };
    else if (!warned) {
      warned = true;
      console.error(`LICENSE_HOSTED_KEY doesn't match kid ${kid} in license-keys.ts: the Companies switch can't turn modules on.`);
    }
  } else if (devKeysAllowed()) {
    try {
      const dev = JSON.parse(fs.readFileSync(path.join(process.cwd(), "scripts", "license", "dev-key.json"), "utf8")) as { kid: string; privateKeyPem: string };
      out = { kid: dev.kid, key: crypto.createPrivateKey({ key: dev.privateKeyPem, format: "pem" }), scope: "dev" };
    } catch {
      out = null;
    }
  }
  memo.set(memoKey, out);
  return out;
}

/** A key for one company and module, signed by this server (plan "a": the administrator's switch). Throws without a signer. */
export function signGrant(a: { shopId: string; shopName: string; module: ModuleId; lastDay: string; graceDays: number; timeZone: string; signer?: Signer | null }): string {
  const signer = a.signer ?? hostedSigner();
  if (!signer) throw new Error("This server has no hosting key.");
  const payload: LicensePayload = {
    v: 1,
    k: signer.kid,
    id: newKeyId(),
    s: a.shopId,
    n: a.shopName,
    m: [a.module],
    p: "a",
    f: todayIn(a.timeZone),
    u: a.lastDay,
    g: a.graceDays,
    t: new Date().toISOString(),
  };
  return encodeLicense(payload, signer.key);
}
