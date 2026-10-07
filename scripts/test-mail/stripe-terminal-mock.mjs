// A stand-in for the bits of Stripe Terminal the card reader uses (shop-features-round-2-design.md 4.8). node:http only;
// never real money. Point STRIPE_API_BASE at it.
//
//   import { startTerminalMock } from "./stripe-terminal-mock.mjs"; const mock = await startTerminalMock({ port: 0 });
//   node scripts/test-mail/stripe-terminal-mock.mjs        // STRIPE_TERMINAL_MOCK_PORT (3406; 3404 is the Anthropic stand-in)
//
// Bearer auth with any sk_test_ key. POST /v1/terminal/locations; POST /v1/terminal/readers (registration_code
// "simulated-wpe" pairs a simulated WisePOS E), GET and DELETE /v1/terminal/readers/{id}; POST /v1/payment_intents
// (card_present), GET /v1/payment_intents/{id}, POST /v1/payment_intents/{id}/cancel; POST
// /v1/terminal/readers/{id}/process_payment_intent and /cancel_action; POST
// /v1/test_helpers/terminal/readers/{id}/present_payment_method (card_present[number] 4000000000000002 declines);
// POST /v1/refunds. Test hooks: GET /__intents, GET /__refunds, DELETE /__state.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hex = (n) => crypto.randomBytes(n).toString("hex");

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function parseForm(text) {
  const out = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const keys = k.replace(/\]/g, "").split("[");
    let o = out;
    keys.forEach((key, i) => {
      if (i === keys.length - 1) o[key] = v;
      else {
        if (!(key in o)) o[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
        o = o[key];
      }
    });
  }
  return out;
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const fail = (res, status, message, code) => json(res, status, { error: { message, type: "invalid_request_error", ...(code ? { code } : {}) } });

/** @param {{ port?: number }} o */
export async function startTerminalMock(o = {}) {
  const locations = new Map();
  const readers = new Map();
  const intents = new Map();
  const refunds = [];
  let port = o.port ?? Number(process.env.STRIPE_TERMINAL_MOCK_PORT ?? 3406);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const p = url.pathname;
    try {
      if (p === "/__intents" && req.method === "GET") return json(res, 200, [...intents.values()]);
      if (p === "/__refunds" && req.method === "GET") return json(res, 200, refunds);
      if (p === "/__state" && req.method === "DELETE") {
        locations.clear();
        readers.clear();
        intents.clear();
        refunds.length = 0;
        return json(res, 200, { ok: true });
      }
      const auth = /^Bearer\s+(sk_test_[A-Za-z0-9]{8,})$/.exec(req.headers.authorization ?? "");
      if (!auth) return json(res, 401, { error: { message: "Invalid API Key provided", type: "authentication_error" } });
      const body = req.method === "POST" ? parseForm(await readBody(req)) : {};
      let m;
      if (p === "/v1/terminal/locations" && req.method === "POST") {
        const loc = { id: `tml_${hex(8)}`, object: "terminal.location", display_name: body.display_name ?? "Shop", address: body.address ?? {} };
        locations.set(loc.id, loc);
        return json(res, 200, loc);
      }
      if (p === "/v1/terminal/readers" && req.method === "POST") {
        if (body.registration_code !== "simulated-wpe") return fail(res, 400, "The registration code is invalid.", "terminal_reader_invalid_registration_code");
        if (!locations.has(body.location)) return fail(res, 400, "No such location.");
        const r = { id: `tmr_${hex(8)}`, object: "terminal.reader", label: body.label ?? "Reader", device_type: "simulated_wisepos_e", status: "online", location: body.location, action: null };
        readers.set(r.id, r);
        return json(res, 200, r);
      }
      if ((m = /^\/v1\/terminal\/readers\/(tmr_\w+)$/.exec(p))) {
        const r = readers.get(m[1]);
        if (!r) return fail(res, 404, "No such reader.", "resource_missing");
        if (req.method === "DELETE") {
          readers.delete(r.id);
          return json(res, 200, { id: r.id, deleted: true });
        }
        return json(res, 200, r);
      }
      if (p === "/v1/payment_intents" && req.method === "POST") {
        const amount = Number(body.amount);
        if (!Number.isInteger(amount) || amount < 50) return fail(res, 400, "Amount must be at least $0.50.", "amount_too_small");
        const idem = req.headers["idempotency-key"];
        const prior = idem ? [...intents.values()].find((x) => x.idem === idem) : null;
        if (prior) return json(res, 200, prior);
        const pi = { id: `pi_${hex(10)}`, object: "payment_intent", amount, amount_received: 0, currency: body.currency ?? "usd", status: "requires_payment_method", capture_method: body.capture_method ?? "automatic", payment_method_types: body.payment_method_types ?? [], metadata: body.metadata ?? {}, latest_charge: null, last_payment_error: null, idem };
        intents.set(pi.id, pi);
        return json(res, 200, pi);
      }
      if ((m = /^\/v1\/payment_intents\/(pi_\w+)(\/cancel)?$/.exec(p))) {
        const pi = intents.get(m[1]);
        if (!pi) return fail(res, 404, "No such payment_intent.", "resource_missing");
        if (m[2] && req.method === "POST") {
          if (pi.status === "succeeded") return fail(res, 400, "This PaymentIntent has already succeeded.", "payment_intent_unexpected_state");
          pi.status = "canceled";
        }
        return json(res, 200, pi);
      }
      if ((m = /^\/v1\/terminal\/readers\/(tmr_\w+)\/(process_payment_intent|cancel_action)$/.exec(p)) && req.method === "POST") {
        const r = readers.get(m[1]);
        if (!r) return fail(res, 404, "No such reader.", "resource_missing");
        if (m[2] === "cancel_action") {
          r.action = null;
          return json(res, 200, r);
        }
        const pi = intents.get(body.payment_intent);
        if (!pi) return fail(res, 400, "No such payment_intent.");
        if (r.action?.status === "in_progress") return fail(res, 409, "The reader is busy.", "terminal_reader_busy");
        r.action = { type: "process_payment_intent", status: "in_progress", process_payment_intent: { payment_intent: pi.id } };
        return json(res, 200, r);
      }
      if ((m = /^\/v1\/test_helpers\/terminal\/readers\/(tmr_\w+)\/present_payment_method$/.exec(p)) && req.method === "POST") {
        const r = readers.get(m[1]);
        if (!r || r.action?.type !== "process_payment_intent") return fail(res, 400, "The reader has no payment to take.");
        const pi = intents.get(r.action.process_payment_intent.payment_intent);
        const number = body.card_present?.number ?? "4242424242424242";
        if (number === "4000000000000002") {
          pi.last_payment_error = { code: "card_declined", message: "Your card was declined." };
          r.action.status = "failed";
          r.action.failure_message = "Your card was declined.";
        } else {
          pi.status = pi.capture_method === "manual" ? "requires_capture" : "succeeded";
          pi.amount_received = pi.status === "succeeded" ? pi.amount : 0;
          pi.latest_charge = { id: `ch_${hex(8)}`, payment_method_details: { card_present: { last4: number.slice(-4), brand: "visa" } } };
          r.action.status = "succeeded";
        }
        return json(res, 200, r);
      }
      if (p === "/v1/refunds" && req.method === "POST") {
        const pi = intents.get(body.payment_intent);
        if (!pi || pi.status !== "succeeded") return fail(res, 400, "No such charge to refund.");
        const already = refunds.filter((x) => x.payment_intent === pi.id).reduce((a, x) => a + x.amount, 0);
        const amount = body.amount ? Number(body.amount) : pi.amount - already;
        if (amount + already > pi.amount) return fail(res, 400, "Refund amount is greater than the unrefunded amount.", "charge_already_refunded");
        const idem = req.headers["idempotency-key"];
        const prior = idem ? refunds.find((x) => x.idem === idem) : null;
        if (prior) return json(res, 200, prior);
        const rf = { id: `re_${hex(8)}`, object: "refund", amount, payment_intent: pi.id, status: "succeeded", idem };
        refunds.push(rf);
        return json(res, 200, rf);
      }
      return fail(res, 404, `Unrecognized request URL (${req.method}: ${p}).`);
    } catch (e) {
      return fail(res, 500, e instanceof Error ? e.message : String(e));
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  port = server.address().port;
  return {
    port,
    intents,
    readers,
    refunds,
    clear() {
      locations.clear();
      readers.clear();
      intents.clear();
      refunds.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startTerminalMock().then((m) => console.log(`Stripe Terminal mock on http://127.0.0.1:${m.port} (STRIPE_API_BASE)`));
}
