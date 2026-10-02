import "server-only";
// A small Stripe client for the online shop (online-and-parts-design.md section 3): Checkout Sessions, refunds and the
// webhook signature. Plain fetch against STRIPE_API_BASE (api.stripe.com; the test mock in scripts/test-mail), form
// bodies as Stripe takes them, so there is no SDK to keep up with. Amounts are integer cents.
import crypto from "node:crypto";
import { UserError } from "@/lib/action";

const BASE = () => (process.env.STRIPE_API_BASE?.trim() || "https://api.stripe.com").replace(/\/$/, "");
const TIMEOUT_MS = 20_000;

/** Flattens { a: { b: [x] } } to Stripe's form keys: a[b][0]=x. */
export function formBody(obj: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (v: unknown, key: string) => {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, key ? `${key}[${k}]` : k);
    else out.append(key, String(v));
  };
  walk(obj, "");
  return out.toString();
}

export type StripeSession = { id: string; url: string | null; payment_status: string; payment_intent: string | null; status: string | null; amount_total: number | null };

async function call<T>(key: string, method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, "stripe-version": "2024-06-20" };
  if (body) headers["content-type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${BASE()}${path}`, { method, headers, body: body ? formBody(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch (e) {
    throw new UserError(`Couldn't reach the card processor (${e instanceof Error ? e.message : "network"}). Please try again in a minute.`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = (json as { error?: { message?: string; type?: string; code?: string } } | null)?.error;
    const msg = err?.message ?? `Stripe answered ${res.status}`;
    // The shop's own key problems are for the shop; everything else is "try again" to a customer.
    if (res.status === 401) throw new UserError("The shop's card processing isn't set up right (the key was refused). Please call the shop.");
    throw new UserError(`The card processor refused the request: ${msg.slice(0, 200)}`);
  }
  return json as T;
}

export type CheckoutLine = { name: string; description?: string | null; unitCents: number; qty: number };

/** A Checkout Session (Stripe's hosted payment page). Returns the session id and the page to send the customer to. */
export async function createCheckoutSession(
  key: string,
  a: { lines: CheckoutLine[]; successUrl: string; cancelUrl: string; email: string | null; metadata: Record<string, string>; reference: string; expiresInMinutes?: number; idempotencyKey: string },
): Promise<StripeSession> {
  const now = Math.floor(Date.now() / 1000);
  return call<StripeSession>(
    key,
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "payment",
      success_url: a.successUrl,
      cancel_url: a.cancelUrl,
      client_reference_id: a.reference,
      customer_email: a.email || undefined,
      metadata: a.metadata,
      payment_intent_data: { metadata: a.metadata },
      // Stripe's minimum is 30 minutes; the order's PENDING row goes stale with it.
      expires_at: now + 60 * Math.max(30, Math.min(a.expiresInMinutes ?? 60, 24 * 60)),
      line_items: a.lines.map((l) => ({
        quantity: l.qty,
        price_data: { currency: "usd", unit_amount: l.unitCents, product_data: { name: l.name.slice(0, 250), ...(l.description ? { description: l.description.slice(0, 250) } : {}) } },
      })),
    },
    a.idempotencyKey,
  );
}

export async function retrieveSession(key: string, id: string): Promise<StripeSession> {
  return call<StripeSession>(key, "GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`);
}

export type StripeRefund = { id: string; amount: number; status: string };

/** Refunds part or all of a payment. `amountCents` omitted: the rest of it. */
export async function refundPayment(key: string, paymentIntent: string, amountCents: number | null, idempotencyKey: string, reason?: string): Promise<StripeRefund> {
  return call<StripeRefund>(
    key,
    "POST",
    "/v1/refunds",
    { payment_intent: paymentIntent, ...(amountCents != null ? { amount: amountCents } : {}), ...(reason ? { metadata: { reason } } : {}) },
    idempotencyKey,
  );
}

export type WebhookEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

/**
 * Checks a webhook's Stripe-Signature (t=...,v1=...: HMAC-SHA256 of "t.body" with the endpoint secret, within five
 * minutes) and parses the event. Null when it doesn't check out.
 */
export function verifyWebhook(rawBody: string, signature: string | null, secret: string, now = new Date()): WebhookEvent | null {
  if (!signature || !secret) return null;
  const parts = Object.fromEntries(signature.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const v1s = signature
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  if (!Number.isFinite(t) || !v1s.length) return null;
  if (Math.abs(now.getTime() / 1000 - t) > 300) return null;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const ok = v1s.some((v) => v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v, "hex"), Buffer.from(expected, "hex")));
  if (!ok) return null;
  try {
    const ev = JSON.parse(rawBody) as WebhookEvent;
    return ev && typeof ev.type === "string" && ev.data?.object ? ev : null;
  } catch {
    return null;
  }
}

/** The header a sender puts on a webhook (the test mock and the check script sign with this). */
export function signWebhook(rawBody: string, secret: string, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

export const looksLikeSecretKey = (s: string) => /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(s);
export const looksLikeWebhookSecret = (s: string) => /^whsec_[A-Za-z0-9]{8,}$/.test(s);
