// A stand-in for the Foundry Account service (cloud.stitchfoundry.app, github.com/Stitchwright/StitchFoundry
// apps/stitchfoundry-cloud, docs/cloud.md), the way anthropic-mock.mjs stands in for Anthropic. node:http only; no
// test spends money or touches real accounts. It follows the real service's rules (checked 2026-10-19):
//   POST /v1/signup, /v1/signin  { email, password } -> { token: "sfs_...", account: { id, email, credits, ... } }
//   POST /v1/signout, GET|POST /v1/account, POST /v1/password/forgot { email } -> { sent, message }
//   POST /v1/messages (Bearer token): an Anthropic Messages request, paid in credits; the answer is Anthropic's with
//   x-stitchfoundry-credits (left) and x-stitchfoundry-spent. Errors are { type: "error", error: { type, message } }.
// Rules: the email is trimmed and lower-cased and needs an @ and a dot after it; the password needs 8 characters; a
// second sign-up for an email is 409; five wrong passwords in a row lock that email (429); a new account starts with
// `signupCredits` (100); only the models in `models` are offered (the real service offers claude-opus-5-5 only so far);
// no streaming; max_tokens 1 to 16000; at most `inFlight` (3) requests at once per account; too few credits is 402;
// `ai: false` answers 503 as the real service does without its Anthropic key. The mock does not verify email addresses
// (neither does the real service yet).
//
//   import { startFoundryMock } from "./foundry-mock.mjs";
//   const mock = await startFoundryMock({ port: 0, respond: (req) => "text" });   // firstId: the first account's id (default 1)
//   program env: FOUNDRY_CLOUD_URL=mock.url
//   node scripts/test-mail/foundry-mock.mjs       // FOUNDRY_MOCK_PORT (3405)
//
// `respond(req)` gets { model, system, messages, maxTokens, userText, accountId } and returns a string, or
// { text, stopReason, status, body, delayMs }. Test hooks (no auth): GET /__requests (everything received, newest last,
// tokens and passwords left out), POST /__next { status, body?, delayMs?, text? } (the next messages call answers that,
// once, queued in order), POST /__credits { email, credits } (set a balance), POST /__expire { email } (end that
// account's sessions, as a password reset does), GET /__sent (reset emails the service would have sent), DELETE /__state.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tokens = (s) => Math.ceil(String(s ?? "").length / 4);
const MAX_WRONG = 5;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const cleanEmail = (v) => {
  const e = String(v ?? "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return null;
  const domain = e.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".") && e.length <= 254 && !/[\s\u0000-\u001f]/.test(e) ? e : null;
};

const MAX_DELAY_MS = 5000;

/**
 * @param {{ port?: number, firstId?: number, ai?: boolean, signupCredits?: number, models?: string[], inFlight?: number, respond?: ((req: { model: string, system: string, messages: unknown[], maxTokens: number, userText: string, accountId: number }) => string | { text?: string, stopReason?: string, status?: number, body?: unknown, delayMs?: number } | Promise<string | { text?: string, stopReason?: string, status?: number, body?: unknown, delayMs?: number }>) | null }} [opts]
 */
export async function startFoundryMock({ port = 0, firstId = 1, ai = true, signupCredits = 100, models = ["claude-opus-5-5"], inFlight = 3, respond = null } = {}) {
  const accounts = new Map(); // email -> { id, email, password, credits, wrong }
  const sessions = new Map(); // token -> account
  const requests = [];
  const queue = [];
  const sent = [];
  const running = new Map();
  let nextId = firstId;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...headers });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, type, message) => send(res, status, { type: "error", error: { type, message } });
  const view = (a) => ({ id: a.id, email: a.email, credits: a.credits, freeChecks: 3, checkCredits: 10, sharedChecks: 0, reports: 0 });
  const startSession = (res, a) => {
    const token = `sfs_${crypto.randomBytes(32).toString("hex")}`;
    sessions.set(token, a);
    send(res, 200, { token, account: view(a) });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const route = `${req.method} ${url.pathname}`;
    const raw = await readBody(req);
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = null;
    }

    // ----- test hooks -----
    if (route === "GET /__requests") return send(res, 200, requests);
    if (route === "GET /__sent") return send(res, 200, sent);
    if (route === "DELETE /__state") {
      accounts.clear();
      sessions.clear();
      requests.length = 0;
      queue.length = 0;
      sent.length = 0;
      running.clear();
      nextId = firstId;
      return send(res, 200, { ok: true });
    }
    if (route === "POST /__next") {
      queue.push(body ?? {});
      return send(res, 200, { ok: true, queued: queue.length });
    }
    if (route === "POST /__credits") {
      const a = accounts.get(cleanEmail(body?.email) ?? "");
      if (!a) return send(res, 404, { ok: false });
      a.credits = Number(body.credits);
      return send(res, 200, { ok: true });
    }
    if (route === "POST /__expire") {
      const a = accounts.get(cleanEmail(body?.email) ?? "");
      for (const [t, s] of sessions) if (s === a) sessions.delete(t);
      return send(res, 200, { ok: true });
    }

    requests.push({ route, authorization: req.headers.authorization ? "Bearer sfs_…" : null, body: route.endsWith("/messages") ? body : { email: body?.email } }); // never the password
    if (body === null || typeof body !== "object" || Array.isArray(body)) return error(res, 400, "invalid_request_error", "the body is a JSON object");

    if (route === "GET /v1/health") return send(res, 200, { ok: true, ai, payments: false, email: true });

    if (route === "POST /v1/signup" || route === "POST /v1/signin") {
      const email = cleanEmail(body.email);
      if (!email) return error(res, 400, "invalid_request_error", "give a real email address");
      const password = String(body.password ?? "");
      const a = accounts.get(email);
      if (route === "POST /v1/signup") {
        if (password.length < 8) return error(res, 400, "invalid_request_error", "a password needs at least 8 characters");
        if (a) return error(res, 409, "invalid_request_error", "there is already an account with that email: sign in");
        const made = { id: nextId++, email, password, credits: signupCredits, wrong: 0 };
        accounts.set(email, made);
        return startSession(res, made);
      }
      if (a && a.wrong >= MAX_WRONG) return error(res, 429, "rate_limit_error", "too many wrong passwords: wait 15 minutes and try again");
      if (!a || a.password !== password) {
        if (a) a.wrong += 1;
        return error(res, 401, "authentication_error", "that email and password don't match");
      }
      a.wrong = 0;
      return startSession(res, a);
    }

    if (route === "POST /v1/password/forgot") {
      const email = cleanEmail(body.email);
      if (!email) return error(res, 400, "invalid_request_error", "give a real email address");
      if (accounts.has(email)) sent.push({ to: email });
      return send(res, 200, { sent: true, message: "If there's a Foundry account with that email, a link to reset its password is on its way. It works for an hour." });
    }

    // ----- everything else needs a signed-in account -----
    const given = /^Bearer (sfs_[0-9a-f]{64})$/.exec(req.headers.authorization ?? "")?.[1];
    const account = given ? sessions.get(given) : undefined;
    if (!account) return error(res, 401, "authentication_error", "your sign-in has ended: sign in again");

    if (route === "POST /v1/signout") {
      sessions.delete(given);
      return send(res, 200, {});
    }
    if (route === "GET /v1/account" || route === "POST /v1/account") {
      return send(res, 200, { ...view(account), packs: [], payments: false, history: [] });
    }

    if (route === "POST /v1/messages") {
      if (!ai) return error(res, 503, "api_error", "StitchFoundry's AI isn't open yet: use your own Anthropic API key for now");
      if (body.stream === true) return error(res, 400, "invalid_request_error", "streaming isn't offered");
      if (!models.includes(body.model)) return error(res, 400, "invalid_request_error", `the model ${JSON.stringify(body.model)} isn't offered`);
      if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 16000) return error(res, 400, "invalid_request_error", "max_tokens is 1 to 16000");
      if (!Array.isArray(body.messages) || !body.messages.length) return error(res, 400, "invalid_request_error", "messages: Field required");
      if ((running.get(account.id) ?? 0) >= inFlight) return error(res, 429, "rate_limit_error", "a few requests are on their way already: wait for them");
      if (account.credits < 25) return error(res, 402, "billing_error", "not enough Foundry credits: buy more in Account");

      const sysBlocks = typeof body.system === "string" ? [{ type: "text", text: body.system }] : (body.system ?? []);
      const system = sysBlocks.map((b) => b.text).join("\n");
      const last = body.messages[body.messages.length - 1];
      const parts = typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content ?? []);
      const userText = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      const rec = { model: body.model, system, messages: body.messages, maxTokens: body.max_tokens, userText, accountId: account.id };

      running.set(account.id, (running.get(account.id) ?? 0) + 1);
      try {
        const scripted = queue.shift();
        let answer = scripted;
        if (!answer) {
          const r = respond ? await respond(rec) : `MOCK ANSWER for ${userText.slice(0, 40)}`;
          answer = typeof r === "string" ? { text: r } : r;
        }
        // The delay comes from a request body (POST /__next), so it is capped: a test hook never needs more than a few seconds.
        if (answer.delayMs) await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(answer.delayMs) || 0, 0), MAX_DELAY_MS)));
        if (answer.status && answer.status !== 200) return send(res, answer.status, answer.body ?? { type: "error", error: { type: "api_error", message: "mock failure" } });
        const text = answer.text ?? "";
        const input = tokens(JSON.stringify(body.messages)) + tokens(system);
        const output = Math.max(1, tokens(text));
        // The real service takes what Anthropic charges times its markup (3), rounded up to whole credits; Opus 5.5 is
        // $4 / $20 a million tokens. A request that would take more than the balance takes the balance.
        const spent = Math.min(account.credits, Math.max(1, Math.ceil(((input * 4 + output * 20) / 1e6) * 100 * 3)));
        account.credits -= spent;
        return send(
          res,
          200,
          {
            id: `msg_${crypto.randomBytes(8).toString("hex")}`,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text }],
            stop_reason: answer.stopReason ?? "end_turn",
            stop_sequence: null,
            usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
          { "x-stitchfoundry-credits": String(account.credits), "x-stitchfoundry-spent": String(spent), "access-control-expose-headers": "x-stitchfoundry-credits, x-stitchfoundry-spent" },
        );
      } finally {
        running.set(account.id, Math.max(0, (running.get(account.id) ?? 1) - 1));
      }
    }
    return error(res, 404, "not_found_error", "no such route");
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const bound = server.address().port;
  return { port: bound, url: `http://127.0.0.1:${bound}`, requests, queue, sent, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startFoundryMock({ port: Number(process.env.FOUNDRY_MOCK_PORT) || 3405 })
    .then((m) => console.log(`foundry account mock on ${m.url}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
