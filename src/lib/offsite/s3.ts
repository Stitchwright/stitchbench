import "server-only";
// A little S3 client for the shop's own bucket (later-round-1-design.md 1.1 and package offsite-bucket): SigV4 query-string
// presigning by hand (the same as the hub's src/s3.mjs, which hands the hub's own bucket's addresses out), and the four
// calls the program makes with them: put, get, delete and list (ListObjectsV2). Works with R2, B2, Wasabi, S3 and MinIO,
// path-style (<endpoint>/<bucket>/<key>), which every one of them accepts.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { UserError } from "@/lib/user-error";
import { publicLookup } from "@/lib/safe-fetch";

/** `publicOnly` (the hosted server): each request's own connection is resolved public-only, see send() below. */
export type S3Config = { endpoint: string; bucket: string; region: string; accessKeyId: string; secret: string; prefix: string; publicOnly?: boolean };

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac("sha256", key).update(data).digest();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (key: string) => key.split("/").map(enc).join("/");

/** A URL good for `expires` seconds for `method` on `key` (a key of "" is the bucket itself: a listing). */
export function presign(cfg: S3Config, method: string, key: string, o: { expires?: number; now?: Date; query?: Record<string, string> } = {}): string {
  const url = new URL(cfg.endpoint);
  const stamp = (o.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = stamp.slice(0, 8);
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const params: Record<string, string> = {
    ...(o.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(Math.min(Math.max(1, Math.floor(o.expires ?? 900)), 3600)),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join("&");
  const path = `${url.pathname.replace(/\/+$/, "")}/${enc(cfg.bucket)}${key ? `/${encPath(key)}` : ""}`;
  const canonical = [method, path, canonicalQuery, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secret}`, date), cfg.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(toSign).digest("hex");
  return `${url.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Where a shop may point its backups: https, a real hostname (no IP address, no "localhost" or ".local"), and, when this runs
 * on a server (hosted), only an address that resolves to the public internet. On the shop's own PC the network is the shop's
 * own, and an address on it (a NAS with MinIO) is allowed. OFFSITE_ALLOW_LOOPBACK=1 lets a check use a stand-in on this computer.
 */
export async function checkEndpoint(raw: string, opts: { allowPrivate?: boolean } = {}): Promise<string> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UserError("The bucket's address should look like https://s3.example.com.");
  }
  const loop = process.env.OFFSITE_ALLOW_LOOPBACK === "1" && ["127.0.0.1", "localhost"].includes(u.hostname);
  if (loop) return u.origin + u.pathname.replace(/\/+$/, "");
  if (u.protocol !== "https:") throw new UserError("The bucket's address must start with https://.");
  if (u.username || u.password) throw new UserError("Leave the user name and password out of the address: they go in their own boxes.");
  const host = u.hostname;
  if (net.isIP(host) && !opts.allowPrivate) throw new UserError("Use the bucket's name address (like s3.example.com), not a number.");
  if (/^localhost$|\.local$|\.internal$|\.localdomain$/i.test(host) && !opts.allowPrivate) throw new UserError("That address is on this computer or its network, which isn't allowed here.");
  if (!opts.allowPrivate) {
    const addrs = await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new UserError("That address isn't known on the internet.");
    for (const a of addrs) if (isPrivate(a.address)) throw new UserError("That address is on a private network, which isn't allowed here.");
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/** Loopback, private, link-local, carrier and unique-local addresses. */
export function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
  return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
}

const asBody = (data: Buffer) => new Uint8Array(data);

/**
 * One request to the bucket, no redirect followed. On the hosted server the connection resolves the name itself through the
 * public-only lookup (src/lib/safe-fetch.ts) rather than fetch's own: checkEndpoint's look at the name can't be undone by the
 * name answering with a private address a moment later (DNS rebinding).
 */
function send(cfg: S3Config, url: string, init: { method?: string; body?: Buffer; timeoutMs: number }): Promise<Response> {
  const u = new URL(url);
  const loop = process.env.OFFSITE_ALLOW_LOOPBACK === "1" && ["127.0.0.1", "localhost"].includes(u.hostname);
  const signal = AbortSignal.timeout(init.timeoutMs);
  if (!cfg.publicOnly || loop) return fetch(url, { method: init.method, body: init.body && asBody(init.body), redirect: "manual", signal });
  return new Promise((resolve, reject) => {
    const headers = init.body ? { "Content-Length": String(init.body.length) } : undefined;
    const req = (u.protocol === "https:" ? https : http).request(u, { method: init.method ?? "GET", headers, signal, lookup: publicLookup }, (res) => {
      const status = res.statusCode ?? 0;
      const empty = status === 204 || status === 304;
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status }));
    });
    req.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "EPRIVATE" ? new UserError("Your backup bucket's address now points inside a private network, which isn't allowed here.") : e));
    req.end(init.body);
  });
}

async function ok(r: Response, what: string): Promise<Response> {
  if (r.ok) return r;
  const text = (await r.text().catch(() => "")).slice(0, 300);
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  throw new UserError(`Your backup bucket refused ${what} (${r.status}${code ? ` ${code}` : ""}). Check the bucket name, the keys and that they may read and write.`);
}

export async function s3Put(cfg: S3Config, key: string, data: Buffer): Promise<void> {
  const r = await send(cfg, presign(cfg, "PUT", `${cfg.prefix}${key}`, { expires: 3600 }), { method: "PUT", body: data, timeoutMs: 30 * 60_000 });
  await ok(r, "the file");
}

export async function s3Get(cfg: S3Config, key: string): Promise<Readable> {
  const r = await send(cfg, presign(cfg, "GET", `${cfg.prefix}${key}`), { timeoutMs: 10 * 60_000 });
  if (r.status === 404) throw new UserError("That backup file isn't in the bucket.");
  await ok(r, "the file");
  return Readable.fromWeb(r.body as import("node:stream/web").ReadableStream<Uint8Array>);
}

export async function s3Delete(cfg: S3Config, key: string): Promise<void> {
  const r = await send(cfg, presign(cfg, "DELETE", `${cfg.prefix}${key}`, { expires: 120 }), { method: "DELETE", timeoutMs: 30_000 });
  if (r.status !== 404) await ok(r, "the delete");
}

const xmlText = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Every object under the company's prefix (ListObjectsV2, following the continuation token), names without the prefix. */
export async function s3List(cfg: S3Config): Promise<{ name: string; size: number }[]> {
  const out: { name: string; size: number }[] = [];
  let token: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix: cfg.prefix, "max-keys": "1000" };
    if (token) query["continuation-token"] = token;
    const r = await ok(await send(cfg, presign(cfg, "GET", "", { query, expires: 120 }), { timeoutMs: 60_000 }), "the listing");
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
      const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1]);
      if (key !== undefined && Number.isFinite(size)) out.push({ name: xmlText(key).slice(cfg.prefix.length), size });
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null;
    if (!token) break;
    token = xmlText(token);
  }
  return out;
}
