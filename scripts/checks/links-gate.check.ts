// The links gate (desktop/links-gate.mjs) and the server's own public-address lock (src/lib/links-host.ts), the lists
// of scheduling-messaging-design.md 14.2 (foundation acceptance item 5). No database. A dummy HTTP server records every
// request that reaches it, the gate runs in front of it on another ephemeral port, and the same table of requests is
// put through linksHostDecision(), the function src/proxy.ts uses.
//   npm run check scripts/checks/links-gate.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { linksHostDecision, PUBLIC_GET, PUBLIC_POST } from "../../src/lib/links-host";
import { startLinksGate, PUBLIC_GET as GATE_GET, PUBLIC_POST as GATE_POST, MAX_POST_BYTES } from "../../desktop/links-gate.mjs";

const PUBLIC_HOST = "links.example.com";

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type Row = { method: string; path: string; headers?: Record<string, string>; body?: string; expect: "pass" | "404" };

// Every row acceptance item 5 names, plus the other public prefixes, HEAD, other methods and a path that escapes a prefix.
const TABLE: Row[] = [
  { method: "GET", path: "/e/x", expect: "pass" },
  { method: "GET", path: "/u/x", expect: "pass" },
  { method: "POST", path: "/api/u/x", body: '{"ok":true}', expect: "pass" },
  { method: "POST", path: "/api/e/x", body: "a=1", expect: "pass" },
  { method: "GET", path: "/api/e/x", expect: "pass" },
  { method: "HEAD", path: "/e/x", expect: "pass" },
  { method: "GET", path: "/_next/static/chunks/app.js", expect: "pass" },
  { method: "GET", path: "/favicon.ico", expect: "pass" },
  { method: "GET", path: "/e/x?token=abc", expect: "pass" },
  { method: "GET", path: "/login", expect: "404" },
  { method: "GET", path: "/customers", expect: "404" },
  { method: "GET", path: "/", expect: "404" },
  { method: "POST", path: "/e/x", body: "a=1", expect: "404" },
  { method: "POST", path: "/login", body: "a=1", expect: "404" },
  { method: "GET", path: "/api/library/file", expect: "404" },
  { method: "GET", path: "/api/auth/session", expect: "404" },
  { method: "POST", path: "/api/auth/callback/credentials", body: "a=1", expect: "404" },
  { method: "GET", path: "/e/x", headers: { "next-action": "abc123" }, expect: "404" },
  { method: "POST", path: "/api/u/x", headers: { "next-action": "abc123" }, body: "a=1", expect: "404" },
  { method: "POST", path: "/", headers: { "next-action": "abc123" }, body: "a=1", expect: "404" },
  { method: "PUT", path: "/api/u/x", body: "a=1", expect: "404" },
  { method: "DELETE", path: "/api/e/x", expect: "404" },
  { method: "OPTIONS", path: "/e/x", expect: "404" },
  { method: "GET", path: "/e/../login", expect: "404" },
  { method: "GET", path: "/estimate/x", expect: "404" },
  // A pay link's page and its Pay button (review fix: the button posted to /shop/o/<token>/pay, which the gate refused).
  { method: "GET", path: "/shop/o/tok123", expect: "pass" },
  { method: "POST", path: "/api/public/pay-link/tok123", body: "", expect: "pass" },
  { method: "POST", path: "/shop/o/tok123/pay", body: "", expect: "404" },
];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
  });
}

function send(port: number, row: Omit<Row, "expect">): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: row.method, path: row.path, headers: row.headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString() }));
    });
    req.on("error", reject);
    req.end(row.body);
  });
}

async function main() {
  assert.deepEqual(GATE_GET, PUBLIC_GET, "the gate's GET list is the server's");
  assert.deepEqual(GATE_POST, PUBLIC_POST, "the gate's POST list is the server's");

  const seen: Seen[] = [];
  const target = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(parts).toString() });
      res.writeHead(200, { "content-type": "text/plain", "x-answered-by": "target" });
      res.end(`ok ${req.method} ${req.url}`);
    });
  });
  target.listen(0, "127.0.0.1");
  const targetPort = await listen(target);
  const gate = startLinksGate({ listenPort: 0, targetPort, publicHost: PUBLIC_HOST });
  const gatePort = await listen(gate);
  let passed = 0;
  try {
    assert.equal((gate.address() as AddressInfo).address, "127.0.0.1", "the gate listens on 127.0.0.1 only");

    for (const row of TABLE) {
      const label = `${row.method} ${row.path}${row.headers ? " " + JSON.stringify(row.headers) : ""}`;
      const before = seen.length;
      const headers = { ...row.headers, "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-forwarded-proto": "https", "x-real-ip": "203.0.113.9", "cf-connecting-ip": "203.0.113.9", forwarded: "for=203.0.113.9", "user-agent": "check" };
      const r = await send(gatePort, { ...row, headers });
      if (row.expect === "pass") {
        assert.equal(r.status, 200, `${label}: passes through the gate`);
        assert.equal(seen.length, before + 1, `${label}: reached the target once`);
        const got = seen[seen.length - 1];
        assert.equal(got.method, row.method, `${label}: same method`);
        assert.equal(got.url, row.path, `${label}: same path and query`);
        assert.equal(got.headers.host, PUBLIC_HOST, `${label}: Host rewritten to the public host`);
        for (const h of ["x-forwarded-for", "x-forwarded-proto", "x-real-ip", "cf-connecting-ip", "forwarded"]) assert.equal(got.headers[h], undefined, `${label}: ${h} dropped`);
        assert.equal(got.headers["user-agent"], "check", `${label}: other headers kept`);
        if (row.method === "POST") assert.equal(got.body, row.body, `${label}: body forwarded`);
        if (row.method !== "HEAD") assert.equal(r.body, `ok ${row.method} ${row.path}`, `${label}: the target's answer comes back`);
      } else {
        assert.equal(r.status, 404, `${label}: 404 from the gate`);
        assert.equal(seen.length, before, `${label}: never reached the target`);
      }
      // The server's own lock decides the same way (src/proxy.ts applies it to requests on the public host).
      const path = new URL(row.path, "http://x").pathname;
      assert.equal(linksHostDecision(row.method, path, new Headers(row.headers ?? {})), row.expect, `${label}: linksHostDecision agrees`);
      passed++;
    }

    // A POST body over 16 KB is refused with 413 and never reaches the target, with and without a Content-Length.
    const big = "x".repeat(20 * 1024);
    let before = seen.length;
    let r = await send(gatePort, { method: "POST", path: "/api/u/x", body: big });
    assert.equal(r.status, 413, "a 20 KB POST with Content-Length -> 413");
    assert.equal(seen.length, before, "the 20 KB POST never reached the target");
    before = seen.length;
    r = await send(gatePort, { method: "POST", path: "/api/u/x", body: big, headers: { "transfer-encoding": "chunked" } });
    assert.equal(r.status, 413, "a 20 KB chunked POST -> 413");
    assert.equal(seen.length, before, "the chunked 20 KB POST never reached the target");
    const atLimit = "y".repeat(MAX_POST_BYTES);
    r = await send(gatePort, { method: "POST", path: "/api/u/x", body: atLimit });
    assert.equal(r.status, 200, "a POST of exactly 16 KB passes");
    assert.equal(seen[seen.length - 1].body, atLimit, "and arrives whole");
    assert.equal(seen[seen.length - 1].headers["content-length"], String(MAX_POST_BYTES), "with its Content-Length");
    passed += 3;

    // Case of the method header doesn't matter to the lock; a next-action header in any case is refused.
    assert.equal(linksHostDecision("get", "/e/x", new Headers()), "pass");
    assert.equal(linksHostDecision("GET", "/e/x", new Headers({ "Next-Action": "a" })), "404");
    passed += 2;

    // The gate stays up when the target is down: 502, nothing hangs.
    await new Promise<void>((resolve) => target.close(() => resolve()));
    target.closeAllConnections();
    r = await send(gatePort, { method: "GET", path: "/e/x" });
    assert.equal(r.status, 502, "target down -> 502 from the gate");
    r = await send(gatePort, { method: "GET", path: "/login" });
    assert.equal(r.status, 404, "and 404s still don't need the target");
    passed += 2;
  } finally {
    gate.close();
    gate.closeAllConnections();
    target.close();
    target.closeAllConnections();
  }
  console.log(`links-gate.check: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
