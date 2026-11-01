import "server-only";
// A customer's order, simulated inside StitchShop's own demo (DEMO_MODE; docs/demo.md): the demo has no hub and no MakerFoundry, so the
// order a customer would place is made here, from the shop's own garments and prices, and goes through exactly the code a real one does
// (the contract's checks, takeOrder, the art and picture checked against size and SHA-256, `received` queued). The customer's answers to a
// proof are pretended the same way. Nothing leaves the server, and none of it works outside a demo.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { isDemo } from "@/lib/demo-mode";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireModule } from "@/lib/modules";
import { parseBody, type OrderPlaced } from "@/lib/shop-orders/contract";
import { takeOrder } from "@/lib/shop-orders/intake";
import { applyCustomerCancel, applyProofAnswer } from "@/lib/shop-orders/proofs";
import { ordersSyncRow } from "@/lib/shop-orders/sync";
import type { MessageContext } from "@/lib/shop-orders/handlers";
import type { CurrentUser } from "@/lib/session";

const NAMES = ["Sam Rivera", "Jordan Blake", "Alex Morgan", "Casey Nguyen", "Riley Foster", "Taylor Quinn"];

async function gate(user: CurrentUser) {
  if (!isDemo()) throw new UserError("Simulated customer orders are only in the demo.");
  if (user.role === "TECH") throw new UserError("Only an owner or admin can try this.");
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
}

/** A small embroidery file written from the DST format's public description: a header, then n one-unit stitch records and the end record. */
export function demoDst(stitches: number): Uint8Array<ArrayBuffer> {
  const h = `LA:DEMO            \rST:${String(stitches).padStart(7)}\rCO:  1\r+X:    0\r-X:    0\r+Y:    0\r-Y:    0\r`;
  const out = new Uint8Array(512 + stitches * 3 + 3).fill(0x20);
  for (let i = 0; i < h.length; i++) out[i] = h.charCodeAt(i);
  for (let i = 0; i < stitches; i++) out.set([0x01, 0x00, 0x03], 512 + i * 3);
  out.set([0, 0, 0xf3], 512 + stitches * 3);
  return out;
}

// A 2 x 2 PNG written out (signature, IHDR, one IDAT of stored deflate data, IEND) so the "customer's picture" is a real image.
function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export function demoPng(): Uint8Array<ArrayBuffer> {
  const W = 160;
  const H = 120;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, no interlace
  // Rows of a filter byte (0) and W RGB pixels: a navy garment with a pale "stitched" ring and cross, so the proof picture is visible.
  const rows = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const o = y * (1 + W * 3);
    rows[o] = 0;
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - W / 2, y - H / 2);
      const ring = Math.abs(d - 34) < 2.5 || (Math.abs(x - W / 2) < 2 && d < 34) || (Math.abs(y - H / 2) < 2 && d < 34);
      const px = o + 1 + x * 3;
      rows[px] = ring ? 235 : 28;
      rows[px + 1] = ring ? 225 : 46 + Math.round(y / 4);
      rows[px + 2] = ring ? 200 : 92 + Math.round(x / 6);
    }
  }
  // zlib: header, one stored block (under 65 535 bytes), adler-32
  let a = 1;
  let b = 0;
  for (const x of rows) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  const z = new Uint8Array(2 + 5 + rows.length + 4);
  z.set([0x78, 0x01, 0x01, rows.length & 0xff, rows.length >> 8, ~rows.length & 0xff, (~rows.length >> 8) & 0xff], 0);
  z.set(rows, 7);
  new DataView(z.buffer).setUint32(7 + rows.length, ((b << 16) | a) >>> 0);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

/** The shop's first garment and decoration (made, if it has none yet, so the button always shows something). */
async function sampleOffer(shopId: string) {
  await ordersSyncRow(shopId);
  let product = await db.onlineProduct.findFirst({ where: { shopId }, orderBy: { createdAt: "asc" } });
  if (!product) product = await db.onlineProduct.create({ data: { shopId, sku: "DEMO-TEE", name: "Demo cotton tee", kind: "shirt", colours: "Navy, Black", sizes: "S, M, L, XL", blankCents: 900 } });
  let offer = await db.onlineOffer.findFirst({ where: { shopId, method: "embroidery" }, orderBy: { createdAt: "asc" } });
  if (!offer) offer = await db.onlineOffer.create({ data: { shopId, method: "embroidery", placement: "Left chest", breaks: [{ min: 1, cents: 1200 }, { min: 12, cents: 1000 }], setupCents: 2500, maxStitches: 8000 } });
  return { product, offer };
}

/** Makes the order a customer would have placed, in the shop's own prices, and takes it in the way a real one is taken. */
export async function simulateOrderFor(user: CurrentUser, kind: "pickup" | "ship"): Promise<string> {
  await gate(user);
  const shopId = user.shopId;
  const { product, offer } = await sampleOffer(shopId);
  await db.shopOrdersSync.update({ where: { shopId }, data: { optedIn: true, catalogPublishedAt: new Date() } });
  const sizes = product.sizes.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 2);
  const counts: Record<string, number> = Object.fromEntries(sizes.map((s, i) => [s, i === 0 ? 4 : 2]));
  const qty = Object.values(counts).reduce((s, n) => s + n, 0);
  const breaks = (offer.breaks as { min: number; cents: number }[]).slice().sort((a, b) => a.min - b.min);
  const each = product.blankCents + ([...breaks].reverse().find((b) => b.min <= qty)?.cents ?? breaks[0].cents);
  const goods = each * qty;
  const setup = offer.setupCents;
  const shipping = kind === "ship" ? 899 : 0;
  // Sales tax is MakerFoundry's: part of what the customer pays, outside the shop's share. The 10% is of the price before tax, the card fee of everything paid.
  const tax = Math.round((goods + setup + shipping) * 0.06);
  const paid = goods + setup + shipping + tax;
  const fee = Math.round((goods + setup + shipping) * 0.1);
  const card = Math.round(paid * 0.029) + 30;
  const art = demoDst(Math.min(offer.maxStitches ?? 4000, 1500));
  const png = demoPng();
  const ref = `demo-${crypto.randomBytes(4).toString("hex")}`;
  const body = {
    fulfilment: kind,
    lines: [{ sku: product.sku, colour: product.colours.split(/[\n,;]+/)[0].trim() || "Navy", sizes: counts, decorations: [{ method: offer.method, placement: offer.placement, art: { file: "logo.dst", size: art.length, sha256: sha(art) } }] }],
    preview: { size: png.length, sha256: sha(png), type: "image/png" },
    customer: { name: NAMES[Math.floor(Math.random() * NAMES.length)], ...(kind === "ship" ? { ship_to: { name: "Demo Customer", line1: "1 Demo Lane", city: "Springfield", region: "XX", postcode: "00000", country: "US" } } : {}) },
    totals: { goods_cents: goods, setup_cents: setup, shipping_cents: shipping, tax_cents: tax, paid_cents: paid, fee_cents: fee, card_fee_cents: card, shop_gets_cents: paid - tax - fee - card },
    note: "A simulated order for the demo.",
  };
  const parsed = parseBody("order.placed", 1, body, "service");
  if (!parsed.ok) throw new UserError(`The simulated order didn't pass the contract: ${parsed.error}`);
  const ctx: MessageContext = { shopId, messageId: crypto.randomUUID(), sender: "service:makerfoundry", conversation: ref, seq: 1, sentAt: new Date(), body: parsed.body as OrderPlaced };
  const id = await takeOrder(ctx, new Map([[sha(art), art], [sha(png), png]]));
  const o = await db.decorOrder.findUniqueOrThrow({ where: { id }, select: { number: true } });
  return `A customer ordered ${qty} ${product.name}${qty === 1 ? "" : "s"} through MakerFoundry: order #${o.number}, already paid. (Simulated for the demo.)`;
}

/** Pretends the customer's answer to the proof (or a cancel) arrived from MakerFoundry. */
export async function simulateCustomerFor(user: CurrentUser, id: string, what: "approved" | "changes" | "cancel"): Promise<string> {
  await gate(user);
  const o = await db.decorOrder.findFirst({ where: { id: assertId(id), shopId: user.shopId, source: "MAKERFOUNDRY" }, select: { onlineRef: true, proofNo: true, number: true } });
  if (!o?.onlineRef) throw new UserError("Order not found.");
  const base = { shopId: user.shopId, messageId: crypto.randomUUID(), sender: "service:makerfoundry", conversation: o.onlineRef, seq: 2, sentAt: new Date() };
  if (what === "cancel") {
    await applyCustomerCancel({ ...base, body: { by: "customer", why: "Changed my mind (simulated)." } });
    return `The customer cancelled order #${o.number}. (Simulated.)`;
  }
  if (o.proofNo < 1) throw new UserError("Send a proof first; then the customer can answer it.");
  await applyProofAnswer({ ...base, body: what === "approved" ? { proof: o.proofNo, answer: "approved", note: "Looks great (simulated)." } : { proof: o.proofNo, answer: "changes", note: "Could the logo be a little smaller? (simulated)" } });
  return what === "approved" ? `The customer approved the proof for order #${o.number}. (Simulated.)` : `The customer asked for changes to order #${o.number}. (Simulated.)`;
}
