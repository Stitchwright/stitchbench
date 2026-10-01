import "server-only";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// Fetching an address that came from someone else (a manual link on the hub): only public web servers, never the shop's
// own network or this computer, checked again at every redirect; and the body is cut off at a size limit as it streams.
// The address is checked where the connection is made (the lookup below), so a name can't pass the check and then
// resolve somewhere private for the download itself.

const blocked = new net.BlockList();
for (const [a, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blocked.addSubnet(a, bits, "ipv4"); // also catches IPv4-mapped IPv6 (::ffff:10.0.0.1 and ::ffff:a00:1)
for (const [a, bits] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], // NAT64: an IPv4 address inside
  ["2002::", 16], // 6to4: an IPv4 address inside
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(a, bits, "ipv6");

/** A private, loopback, link-local, CGNAT, multicast or otherwise non-public address (also used by the mail-server check). */
export function privateAddress(ip: string) {
  const type = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
  return !type || blocked.check(ip, type);
}

const PRIVATE = "That link points inside a private network.";

/** The end-to-end tests serve their files from this computer: FETCH_ALLOW_HOSTS=localhost:3400 lets exactly those. */
function allowedHost(u: URL) {
  const allowed = (process.env.FETCH_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(u.host.toLowerCase());
}

function checkUrl(u: URL) {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only web (http/https) links can be downloaded.");
  if (u.username || u.password) throw new Error("That link has a login in it.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && privateAddress(host) && !allowedHost(u)) throw new Error(PRIVATE);
}

/** Resolves a name for the connection itself and refuses it if any address it has is private. */
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as unknown as dns.LookupAddress[];
    if (!list.length || list.some((a) => privateAddress(a.address))) return callback(Object.assign(new Error(PRIVATE), { code: "EPRIVATE" }), "", 0);
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

export class TooLarge extends Error {}

type Got = { response: { ok: boolean; status: number }; body: Buffer | null };

function getOnce(u: URL, headers: Record<string, string>, maxBytes: number, signal: AbortSignal) {
  return new Promise<{ status: number; location: string | null; body: Buffer | null }>((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, { headers, signal, ...(allowedHost(u) ? {} : { lookup: publicLookup }) }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, location: res.headers.location, body: null });
      }
      if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
        res.destroy();
        return reject(new TooLarge());
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return resolve({ status, location: null, body: null });
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          res.destroy();
          reject(new TooLarge());
        } else chunks.push(c);
      });
      res.on("end", () => resolve({ status, location: null, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "EPRIVATE" || e.message === PRIVATE ? new Error(PRIVATE) : e));
  });
}

/** GET a public URL (following up to 5 redirects) and read at most maxBytes of it. */
export async function fetchPublic(url: string, init: { headers?: Record<string, string>; timeoutMs: number; maxBytes: number }): Promise<Got> {
  const signal = AbortSignal.timeout(init.timeoutMs);
  let current = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    checkUrl(current);
    const r = await getOnce(current, init.headers ?? {}, init.maxBytes, signal);
    if (r.location) {
      current = new URL(r.location, current);
      continue;
    }
    return { response: { ok: r.status >= 200 && r.status < 300, status: r.status }, body: r.body };
  }
  throw new Error("Too many redirects.");
}
