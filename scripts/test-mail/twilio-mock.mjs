// A stand-in for Twilio's Messages API (scheduling-messaging-design.md section 16.2). node:http only.
//
//   import { startTwilioMock } from "./twilio-mock.mjs"; const mock = await startTwilioMock(); // ephemeral port
//   node scripts/test-mail/twilio-mock.mjs                                                     // TWILIO_MOCK_PORT (3401)
//
// Basic auth against TWILIO_MOCK_USER / TWILIO_MOCK_SECRET (default: any AC... or SK... user, secret "secret"); a wrong
// secret -> 401 code 20003. POST Messages.json: numbers ending 0000 -> 400 code 21610; an invalid To -> 400 code 21211;
// ending 0003 -> the message is recorded and the connection destroyed (the sender can't know). GET Messages.json lists
// inbound texts for To= and outbound for From=, honouring DateSent / DateSent> / DateSent< and paging (next_page_uri
// after PageSize, at most 1000). GET Messages/{SID}.json -> delivered, or undelivered with 30034 for numbers ending
// 0001. GET Accounts/{sid}.json -> 200. Test hooks: POST /__inbound {From, To, Body, at?}; GET / DELETE /__sent.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ sid: string; to: string; from: string; body: string; at: string }} MockMessage
 * @typedef {{ port: number; sent: MockMessage[]; inbound: MockMessage[]; clear(): void; close(): Promise<void> }} Mock
 */

const ACCOUNT = /^(AC|SK)[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{7,14}$/;
const newSid = () => `SM${crypto.randomBytes(16).toString("hex")}`;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const twilioError = (res, status, code, message) => json(res, status, { code, message, status, more_info: `https://www.twilio.com/docs/errors/${code}` });

function authOk(req) {
  const h = req.headers.authorization ?? "";
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  const [user, ...rest] = Buffer.from(m[1], "base64").toString("utf8").split(":");
  const secret = rest.join(":");
  const wantUser = process.env.TWILIO_MOCK_USER;
  const wantSecret = process.env.TWILIO_MOCK_SECRET ?? "secret";
  if (secret !== wantSecret) return false;
  return wantUser ? user === wantUser : ACCOUNT.test(user);
}

const dayOf = (iso) => iso.slice(0, 10);

/** A message as Twilio lists it. */
function asTwilio(m, direction) {
  const d = new Date(m.at).toUTCString();
  return {
    sid: m.sid,
    from: m.from,
    to: m.to,
    body: m.body,
    direction,
    status: direction === "inbound" ? "received" : statusOf(m).status,
    error_code: direction === "inbound" ? null : statusOf(m).error_code,
    date_created: d,
    date_sent: d,
    date_updated: d,
  };
}

const statusOf = (m) => (m.to.endsWith("0001") ? { status: "undelivered", error_code: 30034 } : { status: "delivered", error_code: null });

/**
 * Starts the mock. Port 0 (the default) picks a free port.
 * @param {{ port?: number }} [o]
 * @returns {Promise<Mock>}
 */
export async function startTwilioMock({ port = 0 } = {}) {
  /** @type {MockMessage[]} */
  const sent = [];
  /** @type {MockMessage[]} */
  const inbound = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://twilio");
    const p = url.pathname;

    // Test hooks (no auth).
    if (p === "/__inbound" && req.method === "POST") {
      let b;
      try {
        b = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      const at = b.at ? new Date(b.at) : new Date();
      const m = { sid: newSid(), from: String(b.From ?? ""), to: String(b.To ?? ""), body: String(b.Body ?? ""), at: (Number.isNaN(at.getTime()) ? new Date() : at).toISOString() };
      inbound.push(m);
      return json(res, 201, m);
    }
    if (p === "/__sent") {
      if (req.method === "DELETE") {
        sent.length = 0;
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "GET") return json(res, 200, sent);
      res.writeHead(405);
      return res.end();
    }

    const api = /^\/2010-04-01\/Accounts\/([^/]+?)(\.json|\/Messages\.json|\/Messages\/([^/]+)\.json)$/.exec(p);
    if (!api) {
      res.writeHead(404);
      return res.end();
    }
    if (!authOk(req)) return twilioError(res, 401, 20003, "Authentication Error - invalid username");
    const [, , tail, sid] = api;

    if (tail === ".json") {
      if (req.method !== "GET") {
        res.writeHead(405);
        return res.end();
      }
      return json(res, 200, { sid: api[1], friendly_name: "Mock account", status: "active", type: "Full" });
    }

    if (tail === "/Messages.json" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const to = form.get("To") ?? "";
      const from = form.get("From") ?? "";
      const body = form.get("Body") ?? "";
      if (!E164.test(to)) return twilioError(res, 400, 21211, `The 'To' number ${to} is not a valid phone number.`);
      if (to.endsWith("0000")) return twilioError(res, 400, 21610, "Attempt to send to unsubscribed recipient");
      const m = { sid: newSid(), to, from, body, at: new Date().toISOString() };
      sent.push(m);
      if (to.endsWith("0003")) return req.socket.destroy();
      return json(res, 201, { ...asTwilio(m, "outbound-api"), status: "queued" });
    }

    if (tail === "/Messages.json" && req.method === "GET") {
      const q = url.searchParams;
      const to = q.get("To");
      const from = q.get("From");
      let list = [];
      if (to) list.push(...inbound.filter((m) => m.to === to).map((m) => asTwilio(m, "inbound")));
      if (from) list.push(...sent.filter((m) => m.from === from).map((m) => asTwilio(m, "outbound-api")));
      if (!to && !from) list = [...inbound.map((m) => asTwilio(m, "inbound")), ...sent.map((m) => asTwilio(m, "outbound-api"))];
      const exact = q.get("DateSent");
      const after = q.get("DateSent>");
      const before = q.get("DateSent<");
      list = list.filter((m) => {
        const day = dayOf(new Date(m.date_sent).toISOString());
        if (exact && day !== exact) return false;
        if (after && day < after) return false;
        if (before && day > before) return false;
        return true;
      });
      list.sort((a, b) => new Date(b.date_sent) - new Date(a.date_sent));
      const pageSize = Math.min(1000, Math.max(1, Number(q.get("PageSize") ?? 50) || 50));
      const page = Math.max(0, Number(q.get("Page") ?? 0) || 0);
      const slice = list.slice(page * pageSize, (page + 1) * pageSize);
      const more = list.length > (page + 1) * pageSize;
      const next = new URLSearchParams(q);
      next.set("Page", String(page + 1));
      return json(res, 200, {
        messages: slice,
        page,
        page_size: pageSize,
        next_page_uri: more ? `${p}?${next}` : null,
        previous_page_uri: null,
        uri: `${p}?${q}`,
      });
    }

    if (sid && req.method === "GET") {
      const m = sent.find((x) => x.sid === sid) ?? inbound.find((x) => x.sid === sid);
      if (!m) return twilioError(res, 404, 20404, `The requested resource /Messages/${sid}.json was not found`);
      return json(res, 200, asTwilio(m, sent.includes(m) ? "outbound-api" : "inbound"));
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    sent,
    inbound,
    clear() {
      sent.length = 0;
      inbound.length = 0;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startTwilioMock({ port: Number(process.env.TWILIO_MOCK_PORT ?? 3401) })
    .then((m) => console.log(`twilio mock at http://127.0.0.1:${m.port} (TWILIO_API_BASE)`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
