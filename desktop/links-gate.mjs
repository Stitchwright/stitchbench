// The links gate: what a tunnel to the shop PC may reach (scheduling-messaging-design.md 2.3 and 14.2).
// A shop that wants customers to open estimate links sets publicUrl in config.json and points a tunnel it set up at
// http://127.0.0.1:{linksPort}, never at the program's main port. This server listens on 127.0.0.1 only (the tunnel
// agent runs on the PC; nothing on the LAN or the internet reaches it directly) and forwards to the program's server
// only the public pages: GET / HEAD of /e/, /u/, /api/e/, /api/u/, /_next/static/, /favicon.ico and POST of /api/e/,
// /api/u/ (a body of at most 16 KB), never a request carrying a `next-action` header (Next forwards server actions to
// the worker that owns them whatever the path, the login form's included). Everything else gets 404 without touching
// the server. The same lists as src/lib/links-host.ts, which the server's own lock (src/proxy.ts) applies to requests
// whose Host is the public address: the gate sets Host to that address, so the lock holds whatever Host the tunnel
// sends. Addresses a tunnel reports (x-forwarded-*, forwarded, cf-connecting-ip, x-real-ip) are dropped: the program
// never sets TRUST_PROXY, so customers' addresses are not recorded.
import http from "node:http";

export const PUBLIC_GET = ["/e/", "/u/", "/book/", "/shop/", "/api/e/", "/api/u/", "/api/book/", "/api/shop/", "/_next/static/", "/favicon.ico"];
export const PUBLIC_POST = ["/api/e/", "/api/u/", "/api/book/", "/api/shop/"];
export const MAX_POST_BYTES = 16 * 1024;

// Never passed on: a tunnel's address headers, Host (set to the public address), and the hop-by-hop ones.
const DROP = new Set(["host", "forwarded", "cf-connecting-ip", "x-real-ip", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "proxy-authorization", "te", "trailer", "content-length"]);
const dropped = (name) => DROP.has(name) || name.startsWith("x-forwarded-");

/** "pass" for GET / HEAD of a public prefix and POST of a public API prefix; "404" for everything else. */
export function gateDecision(method, pathname, headers) {
  if (headers["next-action"] !== undefined) return "404";
  const m = (method ?? "").toUpperCase();
  if (m === "GET" || m === "HEAD") return PUBLIC_GET.some((p) => pathname.startsWith(p)) ? "pass" : "404";
  if (m === "POST") return PUBLIC_POST.some((p) => pathname.startsWith(p)) ? "pass" : "404";
  return "404";
}

function answer(res, status, text) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text), connection: "close" });
  res.end(text);
}

/** The whole body, or null when it is over the limit (the request is then refused with 413). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.on("data", () => {});
        resolve(null);
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/** Start the gate on 127.0.0.1:listenPort, forwarding the public pages to 127.0.0.1:targetPort. Resolves listening. */
export function startLinksGate({ listenPort, targetPort, publicHost }) {
  // listenPort 0 = any free port (tests); the program passes cfg.linksPort.
  if (!Number.isInteger(listenPort) || listenPort < 0 || !Number.isInteger(targetPort) || targetPort <= 0) throw new Error("links gate: ports must be whole numbers");
  if (typeof publicHost !== "string" || !publicHost) throw new Error("links gate: publicHost is required");
  const server = http.createServer(async (req, res) => {
    try {
      let url;
      try {
        // Parsed, so "/e/../login" is "/login" (404), and the server gets the normalized path.
        url = new URL(req.url ?? "/", "http://gate.invalid");
      } catch {
        return answer(res, 404, "Not found");
      }
      if (gateDecision(req.method, url.pathname, req.headers) !== "pass") {
        req.resume();
        return answer(res, 404, "Not found");
      }
      let body = null;
      if (req.method === "POST") {
        const declared = Number(req.headers["content-length"]);
        if (declared > MAX_POST_BYTES) {
          req.resume();
          return answer(res, 413, "Too large");
        }
        body = await readBody(req, MAX_POST_BYTES);
        if (body === null) return answer(res, 413, "Too large");
      } else {
        req.resume(); // a GET or HEAD body, if any, is not forwarded
      }
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) if (!dropped(name) && value !== undefined) headers[name] = value;
      headers.host = publicHost;
      headers.connection = "close";
      if (body) headers["content-length"] = String(body.length);
      const out = http.request(
        { host: "127.0.0.1", port: targetPort, method: req.method, path: url.pathname + url.search, headers, timeout: 30_000 },
        (upstream) => {
          const h = {};
          for (const [name, value] of Object.entries(upstream.headers)) if (name !== "connection" && name !== "keep-alive" && name !== "transfer-encoding" && value !== undefined) h[name] = value;
          res.writeHead(upstream.statusCode ?? 502, h);
          upstream.pipe(res);
          upstream.on("error", () => res.destroy());
        },
      );
      out.on("timeout", () => out.destroy(new Error("timeout")));
      out.on("error", (e) => answer(res, e.message === "timeout" ? 504 : 502, "The program isn't answering"));
      res.on("close", () => out.destroy());
      out.end(body ?? undefined);
    } catch {
      answer(res, 500, "Error");
    }
  });
  server.on("clientError", (_e, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
    else socket.destroy();
  });
  server.keepAliveTimeout = 5000;
  server.listen(listenPort, "127.0.0.1");
  return server;
}
