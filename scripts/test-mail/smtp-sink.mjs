// A mail server that keeps what it gets (scheduling-messaging-design.md section 16.2). No dependencies: node:net for
// SMTP, node:http for reading the messages back. AUTH PLAIN / LOGIN accepted with anything. Scripted replies by the
// recipient's local part (an optional +tag allowed): reject@ -> 550 5.1.1, quota@ -> 550 5.4.5, later@ -> 451 4.3.0,
// vanish@ -> the DATA is read and the socket closed without a reply (the sender can't know whether it went).
//
//   import { startSmtpSink } from "./smtp-sink.mjs"; const sink = await startSmtpSink(); // ephemeral ports
//   node scripts/test-mail/smtp-sink.mjs                                                  // SMTP_SINK_PORT (2525), SMTP_SINK_HTTP (2580)
//
// HTTP: GET / -> [{ from, to: string[], user, raw, at }], DELETE / -> clears.
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ from: string; to: string[]; user: string | null; raw: string; at: string }} SinkMessage
 * @typedef {{ smtpPort: number; httpPort: number; messages: SinkMessage[]; clear(): void; close(): Promise<void> }} Sink
 */

const CRLF = "\r\n";

function scripted(address) {
  const local = address.toLowerCase().split("@")[0].split("+")[0];
  if (local === "reject") return "550 5.1.1 User unknown";
  if (local === "quota") return "550 5.4.5 Daily sending quota exceeded";
  if (local === "later") return "451 4.3.0 Try again later";
  return null;
}

const isVanish = (address) => address.toLowerCase().split("@")[0].split("+")[0] === "vanish";

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

/**
 * Starts the sink. Port 0 (the default) picks a free port.
 * @param {{ smtpPort?: number; httpPort?: number }} [o]
 * @returns {Promise<Sink>}
 */
export async function startSmtpSink({ smtpPort = 0, httpPort = 0 } = {}) {
  /** @type {SinkMessage[]} */
  const messages = [];
  const sockets = new Set();
  let n = 0;

  const smtp = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    let from = "";
    let to = [];
    let user = null;
    let inData = false;
    let data = "";
    let authState = null; // "plain" | "login-user" | "login-pass"
    const say = (line) => {
      if (!sock.destroyed) sock.write(line + CRLF);
    };
    const reset = () => {
      from = "";
      to = [];
    };
    const endData = () => {
      inData = false;
      const raw = data.replace(/\r\n\.\r\n$/, CRLF).replace(/^\.\./gm, ".");
      data = "";
      if (to.some(isVanish)) {
        sock.destroy();
        return;
      }
      n += 1;
      messages.push({ from, to, user, raw, at: new Date().toISOString() });
      reset();
      say(`250 2.0.0 OK queued as sink-${n}`);
    };
    const command = (line) => {
      if (authState) {
        if (authState === "plain") {
          const parts = Buffer.from(line, "base64").toString("utf8").split("\0");
          user = parts[1] || parts[0] || null;
          authState = null;
          return say("235 2.7.0 Authentication successful");
        }
        if (authState === "login-user") {
          user = Buffer.from(line, "base64").toString("utf8") || null;
          authState = "login-pass";
          return say("334 UGFzc3dvcmQ6");
        }
        authState = null;
        return say("235 2.7.0 Authentication successful");
      }
      const m = /^([A-Za-z]+)(?:\s+(.*))?$/.exec(line);
      if (!m) return say("500 5.5.2 Syntax error");
      const verb = m[1].toUpperCase();
      const arg = (m[2] ?? "").trim();
      switch (verb) {
        case "EHLO":
          return say(`250-sink${CRLF}250-AUTH PLAIN LOGIN${CRLF}250-8BITMIME${CRLF}250 PIPELINING`);
        case "HELO":
          return say("250 sink");
        case "AUTH": {
          const [method, initial] = arg.split(/\s+/);
          const kind = (method ?? "").toUpperCase();
          if (kind === "PLAIN") {
            if (initial) {
              const parts = Buffer.from(initial, "base64").toString("utf8").split("\0");
              user = parts[1] || parts[0] || null;
              return say("235 2.7.0 Authentication successful");
            }
            authState = "plain";
            return say("334 ");
          }
          if (kind === "LOGIN") {
            if (initial) {
              user = Buffer.from(initial, "base64").toString("utf8") || null;
              authState = "login-pass";
              return say("334 UGFzc3dvcmQ6");
            }
            authState = "login-user";
            return say("334 VXNlcm5hbWU6");
          }
          return say("504 5.5.4 Unrecognized authentication type");
        }
        case "MAIL": {
          const a = /<([^>]*)>/.exec(arg);
          from = a ? a[1] : arg.replace(/^from:/i, "").trim();
          to = [];
          return say("250 2.1.0 OK");
        }
        case "RCPT": {
          const a = /<([^>]*)>/.exec(arg);
          const address = a ? a[1] : arg.replace(/^to:/i, "").trim();
          const reply = scripted(address);
          if (reply) return say(reply);
          to.push(address);
          return say("250 2.1.5 OK");
        }
        case "DATA":
          if (!to.length) return say("503 5.5.1 No valid recipients");
          inData = true;
          data = "";
          return say("354 End data with <CR><LF>.<CR><LF>");
        case "RSET":
          reset();
          return say("250 2.0.0 OK");
        case "NOOP":
          return say("250 2.0.0 OK");
        case "QUIT":
          say("221 2.0.0 Bye");
          return sock.end();
        default:
          return say("500 5.5.1 Command unrecognized");
      }
    };
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf(`${CRLF}.${CRLF}`);
          if (end === -1) {
            // Keep the tail so a terminator split across chunks is still found.
            if (buf.length > 5) {
              data += buf.slice(0, buf.length - 5);
              buf = buf.slice(buf.length - 5);
            }
            return;
          }
          data += buf.slice(0, end + 5);
          buf = buf.slice(end + 5);
          endData();
          if (sock.destroyed) return;
          continue;
        }
        const nl = buf.indexOf(CRLF);
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        command(line);
        if (sock.destroyed) return;
      }
    });
    say("220 sink ESMTP ready");
  });

  const api = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://sink");
    if (url.pathname !== "/") {
      res.writeHead(404);
      return res.end();
    }
    if (req.method === "DELETE") {
      messages.length = 0;
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(messages));
    }
    res.writeHead(405);
    res.end();
  });

  const sp = await listen(smtp, smtpPort);
  const hp = await listen(api, httpPort);
  return {
    smtpPort: sp,
    httpPort: hp,
    messages,
    clear() {
      messages.length = 0;
    },
    close() {
      for (const s of sockets) s.destroy();
      api.closeAllConnections?.();
      return new Promise((resolve) => {
        let left = 2;
        const done = () => {
          left -= 1;
          if (!left) resolve();
        };
        smtp.close(done);
        api.close(done);
      });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const smtpPort = Number(process.env.SMTP_SINK_PORT ?? 2525);
  const httpPort = Number(process.env.SMTP_SINK_HTTP ?? 2580);
  startSmtpSink({ smtpPort, httpPort })
    .then((s) => console.log(`smtp sink on 127.0.0.1:${s.smtpPort}, messages at http://127.0.0.1:${s.httpPort}/`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
