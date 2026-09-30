// The guards on "Download to library" (src/lib/safe-fetch.ts), tested without a browser or the app:
//   npm run test:unit
// (tsx with the react-server condition, so the `server-only` marker doesn't throw outside Next.) Web servers here listen
// on this computer only; a private address is refused before anything is sent, so nothing leaves the machine.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchPublic, TooLarge } from "../../src/lib/safe-fetch";

const PRIVATE = /inside a private network/;
const opts = { timeoutMs: 5000, maxBytes: 1024 };

/** A web server on this computer, answering with `handler`. */
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, host: `127.0.0.1:${port}`, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}

/** Runs `fn` with FETCH_ALLOW_HOSTS set (the end-to-end tests' way of letting exactly one local server through). */
async function allowing<T>(hosts: string, fn: () => Promise<T>) {
  const before = process.env.FETCH_ALLOW_HOSTS;
  process.env.FETCH_ALLOW_HOSTS = hosts;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.FETCH_ALLOW_HOSTS;
    else process.env.FETCH_ALLOW_HOSTS = before;
  }
}

test("addresses inside a private network are refused", async () => {
  for (const url of [
    "http://127.0.0.1:9/x",
    "http://10.0.0.5/x",
    "http://172.16.0.1/x",
    "http://192.168.1.10/x",
    "http://169.254.169.254/latest/meta-data/", // the cloud metadata address
    "http://100.64.0.1/", // Tailscale and carrier-grade NAT
    "http://0.0.0.0/",
    "http://[::1]/x",
    "http://[::ffff:10.0.0.1]/x", // an IPv4 address written as IPv6
    "http://[::ffff:a00:1]/x",
    "http://[fe80::1]/x",
    "http://[fd00::1]/x",
    "http://[64:ff9b::a00:1]/x",
  ]) {
    await assert.rejects(fetchPublic(url, opts), PRIVATE, url);
  }
});

test("only web links without a login in them are fetched", async () => {
  await assert.rejects(fetchPublic("file:///etc/passwd", opts), /Only web/);
  await assert.rejects(fetchPublic("ftp://example.com/manual.pdf", opts), /Only web/);
  await assert.rejects(fetchPublic("https://user:secret@example.com/manual.pdf", opts), /login in it/);
});

test("a name that resolves to this computer is refused where the connection is made", async () => {
  const s = await serve((_req, res) => res.end("reached"));
  try {
    await assert.rejects(fetchPublic(`http://localhost:${s.port}/`, opts), PRIVATE);
  } finally {
    await s.close();
  }
});

test("FETCH_ALLOW_HOSTS lets exactly the listed host and port through", async () => {
  const a = await serve((_req, res) => res.end("%PDF-1.4 a"));
  const b = await serve((_req, res) => res.end("%PDF-1.4 b"));
  try {
    await allowing(a.host, async () => {
      const got = await fetchPublic(a.url + "/a.pdf", opts);
      assert.equal(got.body?.toString(), "%PDF-1.4 a");
      await assert.rejects(fetchPublic(b.url + "/b.pdf", opts), PRIVATE, "another port on the same computer");
    });
  } finally {
    await a.close();
    await b.close();
  }
});

test("redirects are followed, and every hop is checked again", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/start") res.writeHead(302, { Location: "/pdf" }).end();
    else if (req.url === "/pdf") res.end("%PDF-1.4 done");
    else if (req.url === "/to-metadata") res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }).end();
    else if (req.url === "/to-lan") res.writeHead(302, { Location: "http://192.168.0.1/admin" }).end();
    else if (req.url === "/loop") res.writeHead(302, { Location: "/loop" }).end();
    else res.writeHead(404).end();
  });
  try {
    await allowing(s.host, async () => {
      assert.equal((await fetchPublic(s.url + "/start", opts)).body?.toString(), "%PDF-1.4 done");
      await assert.rejects(fetchPublic(s.url + "/to-metadata", opts), PRIVATE);
      await assert.rejects(fetchPublic(s.url + "/to-lan", opts), PRIVATE);
      await assert.rejects(fetchPublic(s.url + "/loop", opts), /Too many redirects/);
    });
  } finally {
    await s.close();
  }
});

test("the size limit stops a download, announced or not", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/announced") res.writeHead(200, { "Content-Length": "5000" }).end("x".repeat(5000));
    else if (req.url === "/streamed") {
      res.writeHead(200); // no Content-Length: chunked
      res.write("x".repeat(600));
      setTimeout(() => res.end("x".repeat(600)), 20);
    } else if (req.url === "/fits") res.end("x".repeat(1000));
    else res.writeHead(404).end();
  });
  try {
    await allowing(s.host, async () => {
      await assert.rejects(fetchPublic(s.url + "/announced", opts), TooLarge);
      await assert.rejects(fetchPublic(s.url + "/streamed", opts), TooLarge);
      assert.equal((await fetchPublic(s.url + "/fits", opts)).body?.length, 1000);
    });
  } finally {
    await s.close();
  }
});

test("an error status comes back as a status, and a server that never answers times out", async () => {
  const s = await serve((req) => {
    if (req.url === "/hang") return; // never answers
    req.socket.destroySoon();
  });
  const gone = await serve((_req, res) => res.writeHead(404).end("no"));
  try {
    await allowing(`${s.host},${gone.host}`, async () => {
      const r = await fetchPublic(gone.url + "/nothing", opts);
      assert.deepEqual(r.response, { ok: false, status: 404 });
      assert.equal(r.body, null);
      await assert.rejects(fetchPublic(s.url + "/hang", { ...opts, timeoutMs: 300 }));
    });
  } finally {
    await s.close();
    await gone.close();
  }
});
