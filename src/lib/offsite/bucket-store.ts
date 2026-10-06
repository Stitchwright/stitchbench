import "server-only";
// The shop's own S3-compatible bucket (later-round-1-design.md 1.1, package offsite-bucket): for a shop that would rather keep
// its backups in a bucket of its own (R2, B2, Wasabi, S3, a NAS with MinIO) than with StitchHub. Several companies may share one
// bucket: each writes under its own prefix ("stitchbench/<company id>/"). The secret is sealed in the settings under the
// install's key and left out of a move; the files are encrypted before they leave, as for every target.
import { UserError } from "@/lib/user-error";
import { isDesktop } from "@/lib/modules";
import { unseal } from "@/lib/messaging/secrets";
import { checkName, type OffsiteStore } from "@/lib/offsite/store";
import { spool } from "@/lib/offsite/hub-store";
import { checkEndpoint, s3Delete, s3Get, s3List, s3Put, type S3Config } from "@/lib/offsite/s3";

/** What is kept in OffsiteSettings.bucket (the secret sealed). */
export type BucketSettings = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretSealed: string };

export const bucketPrefix = (shopId: string) => `stitchbench/${shopId}/`;

function parse(raw: unknown): BucketSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  for (const k of ["endpoint", "bucket", "region", "accessKeyId", "secretSealed"] as const) if (typeof b[k] !== "string" || !b[k]) return null;
  return b as unknown as BucketSettings;
}

/** The connection a company's settings describe, the secret opened; the address is checked every time (a stored one is no safer than a typed one). */
export async function bucketConfig(shopId: string, raw: unknown): Promise<S3Config> {
  const b = parse(raw);
  if (!b) throw new UserError("Your backup bucket isn't set up: fill in its address, name and keys.");
  const secret = unseal(b.secretSealed, shopId, "offsiteBucket");
  if (!secret) throw new UserError("The bucket's secret key can't be read here (it was saved under another key): enter it again.");
  const endpoint = await checkEndpoint(b.endpoint, { allowPrivate: isDesktop() });
  return { endpoint, bucket: b.bucket, region: b.region, accessKeyId: b.accessKeyId, secret: secret.plain, prefix: bucketPrefix(shopId) };
}

export async function bucketStoreFor(shopId: string, raw: unknown): Promise<OffsiteStore> {
  const cfg = await bucketConfig(shopId, raw);
  return {
    async put(name, body) {
      checkName(name);
      await s3Put(cfg, name, (await spool(body)).data);
    },
    async get(name) {
      return s3Get(cfg, checkName(name));
    },
    async list() {
      return s3List(cfg);
    },
    async delete(name) {
      await s3Delete(cfg, checkName(name));
    },
  };
}
