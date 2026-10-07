import "server-only";
// The hub target (later-round-1-design.md 1.1 and 1.6, package offsite-hub): StitchHub arranges the bucket and hands out
// short-lived addresses; the bytes go straight between this program and the bucket, already encrypted, and never through
// the hub. Every call names the company (X-Shop-Ref) with this install's key. The restore side (a restore code from the
// StitchHub account, used on a new install that has no key yet) is hubCodeStore below.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hubFetch, hubRequest } from "@/lib/hub";
import { UserError } from "@/lib/user-error";
import { checkName, type OffsiteStore, type StoredObject } from "@/lib/offsite/store";

/** The largest object held in memory to send (the company file is a few MB to a few dozen; a picture is under 1 MB). */
const MAX_OBJECT = 512 * 1024 * 1024;

/** An address from the hub to the bucket: https, or http on this computer (a test bucket); never anything else. */
export function checkBucketUrl(url: unknown): string {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw new UserError("The hub gave a backup address this program can't use.");
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new UserError("The hub gave a backup address that isn't secure, so it wasn't used.");
  return u.toString();
}

/** The body of a stream written to a temporary file as it goes, with its SHA-256; read back into memory, and the file removed. */
export async function spool(body: Readable): Promise<{ data: Buffer; sha: string }> {
  const tmp = path.join(os.tmpdir(), `offsite-${crypto.randomBytes(8).toString("hex")}.part`);
  const hash = crypto.createHash("sha256");
  let n = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > MAX_OBJECT) return cb(new UserError("A backup file is too large to send."));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, count, fs.createWriteStream(tmp));
    return { data: fs.readFileSync(tmp), sha: hash.digest("hex") };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

type ListAnswer = { objects: { name: string; size: number }[] };

async function download(url: unknown): Promise<Readable> {
  const r = await fetch(checkBucketUrl(url), { redirect: "manual", signal: AbortSignal.timeout(10 * 60_000) });
  if (!r.ok || !r.body) throw new UserError(`The backup store didn't give the file back (${r.status}).`);
  return Readable.fromWeb(r.body as import("node:stream/web").ReadableStream<Uint8Array>);
}

/** The company's off-site store on the hub this install is on. */
export async function hubStoreFor(shopId: string): Promise<OffsiteStore> {
  const json = async <T>(p: string, init: { method?: string; json?: unknown } = {}) => (await (await hubFetch(p, { ...init, shopRef: shopId })).json()) as T;
  return {
    async put(name, body) {
      checkName(name);
      const { data, sha } = await spool(body);
      const a = await json<{ url: string }>("/v1/backup/put", { method: "POST", json: { shopRef: shopId, name, size: data.length, sha256: sha } });
      const r = await fetch(checkBucketUrl(a.url), { method: "PUT", body: new Uint8Array(data), redirect: "manual", signal: AbortSignal.timeout(30 * 60_000) });
      if (!r.ok) throw new UserError(`The backup store didn't take the file (${r.status}).`);
      await json("/v1/backup/done", { method: "POST", json: { shopRef: shopId, name } });
    },
    async get(name) {
      checkName(name);
      const a = await json<{ url: string }>("/v1/backup/get", { method: "POST", json: { shopRef: shopId, name } });
      return download(a.url);
    },
    async list(): Promise<StoredObject[]> {
      return (await json<ListAnswer>(`/v1/backup/list?shopRef=${encodeURIComponent(shopId)}`)).objects.map((o) => ({ name: o.name, size: o.size }));
    },
    async delete(name) {
      checkName(name);
      await json("/v1/backup/delete", { method: "POST", json: { shopRef: shopId, name } });
    },
  };
}

type CodeShop = { shopRef: string; name: string; kind: string; program: string | null };

/**
 * A new install reading a company's store with a restore code (made on the StitchHub account, 24 hours): listing and
 * fetching only, with no key of this install's. `base` is the hub's address.
 */
export async function hubCodeStore(base: string, code: string): Promise<{ shop: CodeShop; store: OffsiteStore }> {
  const answer = await hubRequest<{ shop: CodeShop; objects: { name: string; size: number }[] }>(base, "/v1/backup/restore/list", { json: { code }, shopRef: null });
  const readOnly = async (): Promise<never> => {
    throw new UserError("A restore can only read the backups.");
  };
  return {
    shop: answer.shop,
    store: {
      put: readOnly,
      delete: readOnly,
      async list() {
        return answer.objects.map((o) => ({ name: o.name, size: o.size }));
      },
      async get(name) {
        checkName(name);
        const a = await hubRequest<{ url: string }>(base, "/v1/backup/restore/get", { json: { code, name }, shopRef: null });
        return download(a.url);
      },
    },
  };
}
