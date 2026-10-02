// A stand-in for the bits of Stripe the online shop uses (online-and-parts-design.md section 3). node:http only.
//
//   import { startStripeMock } from "./stripe-mock.mjs"; const mock = await startStripeMock({ port: 0 });
//   node scripts/test-mail/stripe-mock.mjs        // STRIPE_MOCK_PORT (3403)
//
// Bearer auth with any sk_/rk_ key (STRIPE_MOCK_KEY to insist on one). POST /v1/checkout/sessions (form-encoded, as
// Stripe takes it) makes a session whose url is this mock's own payment page, /pay/{id}: "Pay" marks it paid, posts
// a signed checkout.session.completed to the webhook (STRIPE_MOCK_WEBHOOK_BASE + the session's metadata.endpoint,
// signed with STRIPE_MOCK_WEBHOOK_SECRET, default whsec_mock1234567890) and sends the browser to success_url;
// "Cancel" goes to cancel_url. GET /v1/checkout/sessions/{id} reports it. POST /v1/refunds records a refund.
// Test hooks: POST /__pay/{id} pays without a browser; GET /__sessions, GET /__refunds; DELETE /__state.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/;
/** What the mock's "Stripe Tax" charges on every line when a session asks for automatic tax. */
export const MOCK_TAX_RATE = 0.08;
const hex = (n) => crypto.randomBytes(n).toString("hex");

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/** Stripe's bracket form keys back into an object: a[b][0][c]=x. */
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

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const stripeError = (res, status, message, type = "invalid_request_error") => json(res, status, { error: { message, type } });

function authOk(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const want = process.env.STRIPE_MOCK_KEY;
  return want ? m[1] === want : KEY.test(m[1]);
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * @param {{ port?: number; webhookBase?: string | null; webhookSecret?: string }} o
 * @returns {Promise<{ port: number; sessions: Map<string, any>; refunds: any[]; webhooks: { url: string; status: number }[]; pay(id: string): Promise<any>; clear(): void; close(): Promise<void> }>}
 */
export async function startStripeMock(o = {}) {
  const sessions = new Map();
  const refunds = [];
  const webhooks = [];
  const secret = o.webhookSecret ?? process.env.STRIPE_MOCK_WEBHOOK_SECRET ?? "whsec_mock1234567890";
  const webhookBase = o.webhookBase === undefined ? (process.env.STRIPE_MOCK_WEBHOOK_BASE ?? null) : o.webhookBase;
  let port = o.port ?? Number(process.env.STRIPE_MOCK_PORT ?? 3403);

  async function sendWebhook(s, type) {
    if (!webhookBase) return;
    const endpoint = s.metadata?.endpoint ?? "platform";
    const url = `${webhookBase.replace(/\/$/, "")}/${endpoint}`;
    const body = JSON.stringify({ id: `evt_${hex(12)}`, object: "event", type, created: Math.floor(Date.now() / 1000), data: { object: s } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body });
      webhooks.push({ url, status: res.status });
    } catch (e) {
      webhooks.push({ url, status: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function pay(id) {
    const s = sessions.get(id);
    if (!s) return null;
    if (s.payment_status !== "paid") {
      s.payment_status = "paid";
      s.status = "complete";
      s.payment_intent = `pi_${hex(12)}`;
      await sendWebhook(s, "checkout.session.completed");
    }
    return s;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const p = url.pathname;
    try {
      // ---- the payment page a browser lands on
      let m = /^\/pay\/(cs_[A-Za-z0-9_]+)$/.exec(p);
      if (m) {
        const s = sessions.get(m[1]);
        if (!s) {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("No such session.");
        }
        if (req.method === "POST") {
          await pay(s.id);
          res.writeHead(303, { location: s.success_url });
          return res.end();
        }
        const items = (s.line_items?.data ?? [])
          .map((l) => `<li>${escapeHtml(l.price_data?.product_data?.name ?? "item")} × ${escapeHtml(l.quantity)} — $${(Number(l.price_data?.unit_amount ?? 0) / 100).toFixed(2)}</li>`)
          .join("");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(
          `<!doctype html><html><head><title>Stripe mock checkout</title></head><body style="font-family:sans-serif;max-width:480px;margin:40px auto">` +
            `<h1>Stripe mock checkout</h1><p>${escapeHtml(s.customer_email ?? "")}</p><ul>${items}</ul><p><strong>Total $${(s.amount_total / 100).toFixed(2)}</strong></p>` +
            `<form method="post"><button type="submit">Pay $${(s.amount_total / 100).toFixed(2)}</button></form><p><a href="${escapeHtml(s.cancel_url)}">Cancel</a></p></body></html>`,
        );
      }
      // ---- test hooks
      m = /^\/__pay\/(cs_[A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "POST") {
        const s = await pay(m[1]);
        return s ? json(res, 200, s) : json(res, 404, { error: "no such session" });
      }
      if (p === "/__sessions" && req.method === "GET") return json(res, 200, [...sessions.values()]);
      if (p === "/__refunds" && req.method === "GET") return json(res, 200, refunds);
      if (p === "/__webhooks" && req.method === "GET") return json(res, 200, webhooks);
      if (p === "/__state" && req.method === "DELETE") {
        sessions.clear();
        refunds.length = 0;
        webhooks.length = 0;
        return json(res, 200, { ok: true });
      }
      // ---- the API
      if (!authOk(req)) return stripeError(res, 401, "Invalid API Key provided", "authentication_error");
      if (p === "/v1/checkout/sessions" && req.method === "POST") {
        const f = parseForm(await readBody(req));
        const lines = Array.isArray(f.line_items) ? f.line_items : [];
        if (!lines.length) return stripeError(res, 400, "Missing required param: line_items.");
        if (!f.success_url || !f.cancel_url) return stripeError(res, 400, "Missing required param: success_url / cancel_url.");
        // Automatic tax: a flat 8 % on every line (shipping too), each line rounded, like a state that taxes delivery.
        const autoTax = f.automatic_tax?.enabled === "true";
        const lineRows = lines.map((l) => {
          const sub = Number(l.price_data?.unit_amount ?? 0) * Number(l.quantity ?? 1);
          const tax = autoTax ? Math.round(sub * MOCK_TAX_RATE) : 0;
          return { quantity: Number(l.quantity ?? 1), price_data: l.price_data, amount_subtotal: sub, amount_tax: tax, amount_total: sub + tax };
        });
        const subtotal = lineRows.reduce((a, l) => a + l.amount_subtotal, 0);
        const taxTotal = lineRows.reduce((a, l) => a + l.amount_tax, 0);
        const amount = subtotal + taxTotal;
        if (amount < 50) return stripeError(res, 400, "The Checkout Session's total amount must be at least $0.50.");
        const idem = req.headers["idempotency-key"];
        const prior = idem ? [...sessions.values()].find((s) => s.idempotency_key === idem) : null;
        if (prior) return json(res, 200, prior);
        const id = `cs_test_${hex(12)}`;
        const s = {
          id,
          object: "checkout.session",
          url: `http://127.0.0.1:${port}/pay/${id}`,
          mode: f.mode ?? "payment",
          status: "open",
          payment_status: "unpaid",
          payment_intent: null,
          amount_subtotal: subtotal,
          amount_total: amount,
          total_details: { amount_tax: taxTotal, amount_shipping: 0, amount_discount: 0 },
          automatic_tax: { enabled: autoTax, status: autoTax ? "complete" : null },
          currency: "usd",
          customer_email: f.customer_email ?? null,
          client_reference_id: f.client_reference_id ?? null,
          metadata: f.metadata ?? {},
          success_url: f.success_url,
          cancel_url: f.cancel_url,
          expires_at: Number(f.expires_at ?? 0) || Math.floor(Date.now() / 1000) + 3600,
          line_items: { object: "list", data: lineRows },
          idempotency_key: idem ?? null,
        };
        sessions.set(id, s);
        return json(res, 200, s);
      }
      m = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(p);
      if (m && req.method === "GET") {
        const s = sessions.get(m[1]);
        return s ? json(res, 200, s) : stripeError(res, 404, `No such checkout.session: '${m[1]}'`);
      }
      if (p === "/v1/refunds" && req.method === "POST") {
        const f = parseForm(await readBody(req));
        const s = [...sessions.values()].find((x) => x.payment_intent && x.payment_intent === f.payment_intent);
        if (!s) return stripeError(res, 404, `No such payment_intent: '${f.payment_intent ?? ""}'`);
        const already = refunds.filter((r) => r.payment_intent === s.payment_intent).reduce((a, r) => a + r.amount, 0);
        const amount = f.amount != null ? Number(f.amount) : s.amount_total - already;
        if (amount <= 0 || amount + already > s.amount_total) return stripeError(res, 400, "Refund amount is greater than the unrefunded amount of the charge.");
        const idem = req.headers["idempotency-key"];
        const prior = idem ? refunds.find((r) => r.idempotency_key === idem) : null;
        if (prior) return json(res, 200, prior);
        const r = { id: `re_${hex(12)}`, object: "refund", amount, status: "succeeded", payment_intent: s.payment_intent, metadata: f.metadata ?? {}, idempotency_key: idem ?? null };
        refunds.push(r);
        return json(res, 200, r);
      }
      return stripeError(res, 404, `Unrecognized request URL (${req.method}: ${p}).`);
    } catch (e) {
      return stripeError(res, 500, e instanceof Error ? e.message : String(e), "api_error");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  port = server.address().port;
  return {
    port,
    sessions,
    refunds,
    webhooks,
    pay,
    clear() {
      sessions.clear();
      refunds.length = 0;
      webhooks.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startStripeMock()
    .then((mock) => console.log(`stripe mock on http://127.0.0.1:${mock.port}${process.env.STRIPE_MOCK_WEBHOOK_BASE ? ` (webhooks to ${process.env.STRIPE_MOCK_WEBHOOK_BASE})` : " (no webhooks)"}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
