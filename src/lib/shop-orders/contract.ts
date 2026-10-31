// The MakerFoundry order messages as StitchShop reads and writes them (docs/plans/makerfoundry-orders-plan.md; the hub's side is
// StitchHub src/sync-orders.mjs, docs/hub-sync-design.md). Pure: no database, no network, so the pages, the sync job and the tests
// share it. What comes in is another computer's message, so every body is checked against the version it claims and rebuilt from
// the fields this program knows; a field it doesn't know is left out, never passed on. The hub checks the same shapes before it
// queues a message; checking again here is what lets an old hub, a bug or a changed contract do no harm.
// Fixtures shared with the hub: tests/fixtures/shop-orders.

export const MAX_ART_BYTES = 10 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** The message types and versions this program understands, as it tells the hub in its hello. */
export const UNDERSTOOD: Record<string, number[]> = {
  "order.placed": [1],
  "proof.answer": [1],
  "order.cancel": [1],
  "message.expired": [1],
};
/** What it sends (the hub holds a message for a recipient that hasn't said it understands it; a sender needs no entry). */
export const SENDS = ["catalog", "order.status", "proof.sent", "order.cancel"] as const;

export class Bad extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const bad = (code: string, message: string): never => {
  throw new Bad(code, message);
};

const SHA = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,119}$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

// ----- small checkers: each returns the cleaned value or throws Bad -----
const text = (v: unknown, max: number, path: string, o: { min?: number; re?: RegExp } = {}): string => {
  if (typeof v !== "string") return bad("bad_field", `${path} has to be text.`);
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < (o.min ?? 1)) return bad("bad_field", `${path} can't be empty.`);
  if (t.length > max) return bad("bad_field", `${path} is longer than ${max} characters.`);
  if (o.re && !o.re.test(t)) return bad("bad_field", `${path} isn't in the form expected.`);
  return t;
};
const int = (v: unknown, lo: number, hi: number, path: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) return bad("bad_field", `${path} has to be a whole number from ${lo} to ${hi}.`);
  return v;
};
const bool = (v: unknown, path: string): boolean => (typeof v === "boolean" ? v : bad("bad_field", `${path} has to be true or false.`));
const oneOf = <T extends string>(v: unknown, list: readonly T[], path: string): T => (list.includes(v as T) ? (v as T) : bad("bad_field", `${path} has to be one of: ${list.join(", ")}.`));
const list = <T>(v: unknown, max: number, path: string, each: (x: unknown, p: string) => T, min = 0): T[] => {
  if (!Array.isArray(v)) return bad("bad_field", `${path} has to be a list.`);
  if (v.length < min) return bad("bad_field", `${path} needs at least ${min}.`);
  if (v.length > max) return bad("bad_field", `${path} has more than ${max}.`);
  return v.map((x, i) => each(x, `${path}[${i}]`));
};
type Shape = Record<string, [required: boolean, check: (v: unknown, p: string) => unknown]>;
/** An object read through `shape`; keys outside the shape are left out and noted in `dropped`. */
function shaped(v: unknown, path: string, shape: Shape, dropped: string[]): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad("bad_field", `${path} has to be an object.`);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, [required, check]] of Object.entries(shape)) {
    if (o[k] === undefined || o[k] === null) {
      if (required) bad("bad_field", `${path}.${k} is missing.`);
      continue;
    }
    out[k] = check(o[k], `${path}.${k}`);
  }
  for (const k of Object.keys(o)) if (!(k in shape)) dropped.push(`${path}.${k}`);
  return out;
}
const sha256 = (v: unknown, path: string): string => (SHA.test(String(v)) ? String(v) : bad("bad_field", `${path} has to be a SHA-256 (64 hex characters).`));

// ----- contact details never travel, either way -----
const CONTACT_KEY = /^(e-?mail|phone|tel|telephone|mobile|cell|sms|whatsapp|fax|contact|customer_?email|customer_?phone)$/i;
const EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+?\d[\s().-]?){10,}/;
function scanKeys(v: unknown, path: string, depth = 0): void {
  if (depth > 12) return bad("bad_field", `${path} is nested too deep.`);
  if (Array.isArray(v)) return v.forEach((x, i) => scanKeys(x, `${path}[${i}]`, depth + 1));
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (CONTACT_KEY.test(k)) bad("personal_contact", `${path}.${k}: the customer's email and phone are never sent.`);
      scanKeys(x, `${path}.${k}`, depth + 1);
    }
  }
}
/** Free text (a note, a name): an email address or phone number typed into it is refused. */
const free = (v: unknown, max: number, path: string): string => {
  const t = text(v, max, path);
  if (EMAIL.test(t) || PHONE.test(t)) return bad("personal_contact", `${path} has an email address or phone number in it.`);
  return t;
};

// ----- the bodies -----
export type FileRef = { sha256: string; size: number };
export type Art = FileRef & { file: string };
export type Preview = FileRef & { type: "image/png" | "image/jpeg" };
export type Money = number;
export const METHODS = ["embroidery", "screen_print"] as const;
export type Method = (typeof METHODS)[number];

export type OrderPlaced = {
  fulfilment: "ship" | "pickup";
  lines: { sku: string; colour: string; sizes: Record<string, number>; decorations: { method: Method; placement: string; art: Art }[] }[];
  preview?: Preview;
  customer: { name: string; ship_to?: ShipTo };
  totals: Record<(typeof TOTALS)[number], Money>;
  note?: string;
};
export type ShipTo = { name: string; line1: string; line2?: string; city: string; region?: string; postal: string; country: string };
export type ProofAnswer = { proof: number; answer: "approved" | "changes"; note?: string };
export type CancelBody = { by: "shop" | "customer"; why: string };
export type Expired = { id: string; type: string; conversation: string; to?: string; reason: "expired" | "recipient_too_old" };
export type StatusBody = { status: "received" | "proof_sent" | "approved" | "in_production" | "ready" | "shipped" | "collected"; tracking?: string; note?: string };
export type ProofSent = { proof: number; mockup: Preview; note?: string };
export type CatalogBody = {
  shop: { name: string; town?: string; ships: boolean; pickup: boolean };
  products: { sku: string; name: string; kind: string; colours: string[]; sizes: string[]; methods: { method: Method; placements: string[]; price_breaks: { min: number; cents: Money }[]; setup_cents: Money }[] }[];
  shipping: { flat_cents: Money };
  currency: "usd";
};

const TOTALS = ["goods_cents", "setup_cents", "shipping_cents", "tax_cents", "paid_cents", "fee_cents", "card_fee_cents", "shop_gets_cents"] as const;
const money = (x: unknown, p: string) => int(x, 0, 100_000_000, p);
const art = (v: unknown, p: string, d: string[]) => shaped(v, p, { file: [true, (x, q) => text(x, 120, q, { re: FILE_NAME })], size: [true, (x, q) => int(x, 1, MAX_ART_BYTES, q)], sha256: [true, sha256] }, d);
const preview = (v: unknown, p: string, d: string[]) => shaped(v, p, { size: [true, (x, q) => int(x, 1, MAX_PREVIEW_BYTES, q)], sha256: [true, sha256], type: [true, (x, q) => oneOf(x, ["image/png", "image/jpeg"] as const, q)] }, d);
const shipTo = (v: unknown, p: string, d: string[]) =>
  shaped(
    v,
    p,
    {
      name: [true, (x, q) => free(x, 120, q)],
      line1: [true, (x, q) => text(x, 120, q)],
      line2: [false, (x, q) => text(x, 120, q)],
      city: [true, (x, q) => text(x, 80, q)],
      region: [false, (x, q) => text(x, 40, q)],
      postal: [true, (x, q) => text(x, 20, q)],
      country: [true, (x, q) => text(x, 2, q, { re: /^[A-Z]{2}$/ })],
    },
    d,
  );

const BODIES: Record<string, (b: unknown, d: string[]) => unknown> = {
  catalog: (b, d) =>
    shaped(
      b,
      "body",
      {
        shop: [true, (x, p) => shaped(x, p, { name: [true, (y, q) => text(y, 120, q)], town: [false, (y, q) => text(y, 80, q)], ships: [true, bool], pickup: [true, bool] }, d)],
        products: [
          true,
          (x, p) =>
            list(x, 200, p, (y, q) =>
              shaped(
                y,
                q,
                {
                  sku: [true, (z, r) => text(z, 60, r, { re: SKU })],
                  name: [true, (z, r) => text(z, 120, r)],
                  kind: [true, (z, r) => text(z, 30, r)],
                  colours: [true, (z, r) => list(z, 50, r, (w, s) => text(w, 40, s))],
                  sizes: [true, (z, r) => list(z, 20, r, (w, s) => text(w, 10, s))],
                  methods: [
                    true,
                    (z, r) =>
                      list(
                        z,
                        6,
                        r,
                        (w, s) =>
                          shaped(
                            w,
                            s,
                            {
                              method: [true, (u, t) => oneOf(u, METHODS, t)],
                              placements: [true, (u, t) => list(u, 10, t, (a, c) => text(a, 40, c), 1)],
                              price_breaks: [true, (u, t) => list(u, 10, t, (a, c) => shaped(a, c, { min: [true, (e, f) => int(e, 1, 100_000, f)], cents: [true, money] }, d), 1)],
                              setup_cents: [true, money],
                            },
                            d,
                          ),
                        1,
                      ),
                  ],
                },
                d,
              ),
            ),
        ],
        shipping: [true, (x, p) => shaped(x, p, { flat_cents: [true, money] }, d)],
        currency: [true, (x, p) => oneOf(x, ["usd"] as const, p)],
      },
      d,
    ),
  "order.placed": (b, d) => {
    const out = shaped(
      b,
      "body",
      {
        fulfilment: [true, (x, p) => oneOf(x, ["ship", "pickup"] as const, p)],
        lines: [
          true,
          (x, p) =>
            list(
              x,
              50,
              p,
              (y, q) =>
                shaped(
                  y,
                  q,
                  {
                    sku: [true, (z, r) => text(z, 60, r, { re: SKU })],
                    colour: [true, (z, r) => text(z, 40, r)],
                    sizes: [
                      true,
                      (z, r) => {
                        if (typeof z !== "object" || z === null || Array.isArray(z) || Object.keys(z).length < 1 || Object.keys(z).length > 20) return bad("bad_field", `${r} is { size: count } with 1 to 20 sizes.`);
                        return Object.fromEntries(Object.entries(z).map(([k, n]) => [text(k, 10, `${r} size`), int(n, 1, 10_000, `${r}.${k}`)]));
                      },
                    ],
                    decorations: [true, (z, r) => list(z, 10, r, (w, s) => shaped(w, s, { method: [true, (u, t) => oneOf(u, METHODS, t)], placement: [true, (u, t) => text(u, 40, t)], art: [true, (u, t) => art(u, t, d)] }, d), 1)],
                  },
                  d,
                ),
              1,
            ),
        ],
        preview: [false, (x, p) => preview(x, p, d)],
        customer: [true, (x, p) => shaped(x, p, { name: [true, (y, q) => free(y, 120, q)], ship_to: [false, (y, q) => shipTo(y, q, d)] }, d)],
        totals: [true, (x, p) => shaped(x, p, Object.fromEntries(TOTALS.map((k) => [k, [true, money] as [boolean, (v: unknown, p: string) => unknown]])), d)],
        note: [false, (x, p) => free(x, 500, p)],
      },
      d,
    ) as unknown as OrderPlaced;
    if (out.fulfilment === "ship" && !out.customer.ship_to) bad("ship_to_missing", "An order to be shipped needs the shipping address (customer.ship_to).");
    if (out.fulfilment === "pickup" && out.customer.ship_to) bad("ship_to_not_allowed", "The shipping address goes only with an order that is to be shipped.");
    return out;
  },
  "order.status": (b, d) =>
    shaped(
      b,
      "body",
      {
        status: [true, (x, p) => oneOf(x, ["received", "proof_sent", "approved", "in_production", "ready", "shipped", "collected"] as const, p)],
        tracking: [false, (x, p) => text(x, 80, p)],
        note: [false, (x, p) => free(x, 500, p)],
      },
      d,
    ),
  "proof.sent": (b, d) => shaped(b, "body", { proof: [true, (x, p) => int(x, 1, 1000, p)], mockup: [true, (x, p) => preview(x, p, d)], note: [false, (x, p) => free(x, 500, p)] }, d),
  "proof.answer": (b, d) => shaped(b, "body", { proof: [true, (x, p) => int(x, 1, 1000, p)], answer: [true, (x, p) => oneOf(x, ["approved", "changes"] as const, p)], note: [false, (x, p) => free(x, 500, p)] }, d),
  "order.cancel": (b, d) => shaped(b, "body", { by: [true, (x, p) => oneOf(x, ["shop", "customer"] as const, p)], why: [true, (x, p) => free(x, 500, p)] }, d),
  "message.expired": (b, d) =>
    shaped(
      b,
      "body",
      {
        id: [true, (x, p) => text(x, 80, p)],
        type: [true, (x, p) => text(x, 40, p)],
        conversation: [true, (x, p) => text(x, 120, p)],
        to: [false, (x, p) => text(x, 120, p)],
        reason: [true, (x, p) => oneOf(x, ["expired", "recipient_too_old"] as const, p)],
      },
      d,
    ),
};

export type Parsed = { ok: true; body: unknown; dropped: string[] } | { ok: false; code: string; error: string };

/**
 * A message body, checked against the version it claims and rebuilt from the fields known. `from` is who sent it ("service", "shop" or
 * "hub"): a customer cancel comes from the service, a shop cancel from the shop.
 */
export function parseBody(type: string, version: number, body: unknown, from: "service" | "shop" | "hub"): Parsed {
  const check = BODIES[type];
  if (!check || version !== 1) return { ok: false, code: "unknown_type", error: `No body rules for ${type} v${version}.` };
  try {
    scanKeys(body, "body");
    const dropped: string[] = [];
    const clean = check(body, dropped);
    if (type === "order.cancel") {
      const by = (clean as CancelBody).by;
      if ((by === "customer" && from !== "service") || (by === "shop" && from !== "shop")) bad("bad_field", `body.by has to say who is cancelling: "customer" comes from the service, "shop" from the shop.`);
    }
    return { ok: true, body: clean, dropped };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, code: e.code, error: e.message };
    throw e;
  }
}

/** The files an inbound message points at, to be fetched and checked: art first, then the preview. */
export function fileRefs(p: OrderPlaced): { kind: "art" | "mockup"; sha256: string; size: number; type?: string }[] {
  const refs: { kind: "art" | "mockup"; sha256: string; size: number; type?: string }[] = [];
  const seen = new Set<string>();
  for (const l of p.lines) {
    for (const d of l.decorations) {
      if (seen.has(d.art.sha256)) continue;
      seen.add(d.art.sha256);
      refs.push({ kind: "art", sha256: d.art.sha256, size: d.art.size });
    }
  }
  if (p.preview) refs.push({ kind: "mockup", sha256: p.preview.sha256, size: p.preview.size, type: p.preview.type });
  return refs;
}
