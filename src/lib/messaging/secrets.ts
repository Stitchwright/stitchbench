import "server-only";
// The mail password and the Twilio secret at rest: AES-256-GCM under a key derived from SETTINGS_KEY (hosted) or
// AUTH_SECRET (the Windows program), bound to the shop and field (scheduling-messaging-design.md section 4.1).
import crypto from "node:crypto";
import { UserError } from "@/lib/action";
import { isDesktop } from "@/lib/modules";

export type SecretField = "smtpPass" | "twilioToken" | `estimateToken:${string}`;

type DerivedKey = { kid: string; key: Buffer };

function derive(material: string): DerivedKey {
  const key = Buffer.from(crypto.hkdfSync("sha256", material, "stitchbench", "settings-secrets:v1", 32));
  const kid = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
  return { kid, key };
}

const cache = new Map<string, DerivedKey>();
function derived(material: string): DerivedKey {
  let k = cache.get(material);
  if (!k) cache.set(material, (k = derive(material)));
  return k;
}

/** Hosted production (not a test build, not the Windows program) must set SETTINGS_KEY before any secret is saved. */
function settingsKeyRequired() {
  return process.env.NODE_ENV === "production" && !process.env.STITCH_TEST_BUILD && !isDesktop();
}

/** The current key (SETTINGS_KEY, else AUTH_SECRET) and the older ones that still open values (SETTINGS_KEY_PREVIOUS, AUTH_SECRET). */
function keys(): { current: DerivedKey | null; older: DerivedKey[] } {
  const settings = process.env.SETTINGS_KEY?.trim() || null;
  const auth = process.env.AUTH_SECRET?.trim() || null;
  const previous = process.env.SETTINGS_KEY_PREVIOUS?.trim() || null;
  const current = settings ? derived(settings) : settingsKeyRequired() ? null : auth ? derived(auth) : null;
  const older: DerivedKey[] = [];
  if (previous) older.push(derived(previous));
  if (settings && auth) older.push(derived(auth));
  return { current, older: older.filter((k) => k.kid !== current?.kid) };
}

const b64 = (b: Buffer) => b.toString("base64url");

/** `v1.<kid>.<iv>.<ciphertext>.<tag>`, bound to the shop and field (a value copied to another row doesn't open). */
export function seal(plain: string, shopId: string, field: SecretField): string {
  const { current } = keys();
  if (!current) throw new UserError("This server needs SETTINGS_KEY set before passwords can be saved. Ask whoever runs it.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", current.key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${shopId}:${field}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${current.kid}.${b64(iv)}.${b64(ct)}.${b64(cipher.getAuthTag())}`;
}

/**
 * The plain value, or null on any failure (unknown kid, another shop or field, a bad tag). `stale` says it opened with
 * an older key while a newer one exists: the caller re-seals and saves.
 */
export function unseal(sealed: string | null, shopId: string, field: SecretField): { plain: string; stale: boolean } | null {
  if (!sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return null;
  const [, kid, ivText, ctText, tagText] = parts;
  const { current, older } = keys();
  const k = [current, ...older].find((x): x is DerivedKey => !!x && x.kid === kid);
  if (!k) return null;
  try {
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", k.key, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`${shopId}:${field}`, "utf8"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(ctText, "base64url")), decipher.final()]).toString("utf8");
    return { plain, stale: !!current && k.kid !== current.kid };
  } catch {
    return null;
  }
}
