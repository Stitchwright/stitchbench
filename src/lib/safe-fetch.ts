import "server-only";
import dns from "node:dns/promises";
import net from "node:net";

// Fetching an address that came from someone else (a manual link on the hub): only public web servers, never the shop's
// own network or this computer, checked again at every redirect; and the body is cut off at a size limit as it streams.

function privateAddress(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function checkHost(u: URL) {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only web (http/https) links can be downloaded.");
  if (u.username || u.password) throw new Error("That link has a login in it.");
  // The end-to-end tests serve their files from this computer: FETCH_ALLOW_HOSTS=localhost:3400 lets exactly those
  // host:port pairs through. Only whoever starts the server can set it; nothing is allowed by default.
  const allowed = (process.env.FETCH_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(u.host.toLowerCase())) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!ips.length || ips.some(privateAddress)) throw new Error("That link points inside a private network.");
}

export class TooLarge extends Error {}

/** GET a public URL (following up to 5 redirects) and read at most maxBytes of it. */
export async function fetchPublic(url: string, init: { headers?: Record<string, string>; timeoutMs: number; maxBytes: number }) {
  const signal = AbortSignal.timeout(init.timeoutMs);
  let current = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    await checkHost(current);
    const r = await fetch(current, { redirect: "manual", headers: init.headers, signal });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      current = new URL(r.headers.get("location")!, current);
      continue;
    }
    if (Number(r.headers.get("content-length") ?? 0) > init.maxBytes) throw new TooLarge();
    if (!r.ok || !r.body) return { response: r, body: null };
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > init.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TooLarge();
      }
      chunks.push(value);
    }
    return { response: r, body: Buffer.concat(chunks) };
  }
  throw new Error("Too many redirects.");
}
