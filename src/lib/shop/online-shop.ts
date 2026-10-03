import "server-only";
// The online shop (online-and-parts-design.md section 3): a shop's listed items sold from its own inventory at
// /shop/{slug} on the public address. The catalog and item pages, a cart carried in the address (no cookies, so it
// works inside another site's iframe), checkout through Stripe's hosted page, payment confirmed by the webhook or the
// return page, the sale written in the register's books with tender ONLINE (stock comes off as at the counter), the
// customer's order page by token, the staff's orders screen (ready, picked up, shipped, cancel and refund), the
// order mail, and Settings -> Online shop. No session on the public side: the slug names the shop and every query
// filters by its id. Bodies take plain arguments so the check script can drive them.
import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { PartKind } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { money, str } from "@/lib/format";
import { queueToCustomer } from "@/lib/messaging/queue";
import { seal, unseal } from "@/lib/messaging/secrets";
import { messagingView, publicBaseUrl } from "@/lib/messaging/settings";
import { plainText, renderKind } from "@/lib/messaging/templates";
import { baseWritable } from "@/lib/base-gate";
import { moduleOn } from "@/lib/module-gate";
import { customerForOnline, SLUG_RE, slugOf, type OnlineCustomer } from "@/lib/online-booking";
import { KIND_LABEL, numberKey } from "@/lib/parts";
import { partTags } from "@/lib/part-labels";
import { inEighths, qtyText, saleTotals } from "@/lib/register-math";
import { completeSaleAs, voidSaleAs, type SaleLineInput } from "@/lib/register-sale";
import type { CurrentUser } from "@/lib/session";
import { createCheckoutSession, looksLikeSecretKey, looksLikeWebhookSecret, refundPayment, retrieveSession, TAX_CODE_SHIPPING, verifyWebhook, type StripeSession } from "@/lib/shop/stripe";

type Db = Prisma.TransactionClient | typeof db;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[a-z0-9]{20,40}$/;
/** The most of one item in a cart, and the most lines. */
export const MAX_QTY = 99;
export const MAX_LINES = 30;
export const MAX_PHOTOS = 4;
export const ORDER_STATUSES = ["PENDING", "PAID", "READY", "DONE", "CANCELLED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = { PENDING: "Not paid yet", PAID: "Paid, to pack", READY: "Ready for pickup", DONE: "Done", CANCELLED: "Cancelled" };

// ---------------------------------------------------------------- settings

/** Payment through the hosted service's own Stripe account is offered when the server has its keys. */
export function platformStripeOn(): boolean {
  return !!process.env.STRIPE_SECRET_KEY?.trim() && !!process.env.STRIPE_WEBHOOK_SECRET?.trim();
}

export type ShopSettings = {
  slug: string | null;
  on: boolean;
  pickup: boolean;
  shipping: boolean;
  shipCents: number;
  freeOverCents: number | null;
  payVia: "own" | "platform";
  taxVia: "rate" | "stripe";
  hasStripeKey: boolean;
  hasWebhookSecret: boolean;
  welcome: string | null;
  pickupNote: string | null;
  ordersInCap: boolean;
  listed: number;
  sellsRetail: boolean;
  taxRatePct: number;
};

export async function shopSettings(shopId: string): Promise<ShopSettings> {
  const [s, ms, listed] = await Promise.all([
    db.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: {
        bookingSlug: true,
        shopOn: true,
        shopPickup: true,
        shopShipping: true,
        shopShipCents: true,
        shopFreeOverCents: true,
        shopPayVia: true,
        shopTaxVia: true,
        stripeKeySealed: true,
        stripeWebhookSealed: true,
        shopWelcome: true,
        shopPickupNote: true,
        sellsRetail: true,
        taxRatePct: true,
      },
    }),
    db.messagingSettings.findUnique({ where: { shopId }, select: { ordersInCap: true } }),
    db.part.count({ where: { shopId, online: true, priceCents: { not: null } } }),
  ]);
  return {
    slug: s.bookingSlug,
    on: s.shopOn,
    pickup: s.shopPickup,
    shipping: s.shopShipping,
    shipCents: s.shopShipCents,
    freeOverCents: s.shopFreeOverCents,
    payVia: s.shopPayVia === "platform" ? "platform" : "own",
    taxVia: s.shopTaxVia === "stripe" ? "stripe" : "rate",
    hasStripeKey: !!s.stripeKeySealed,
    hasWebhookSecret: !!s.stripeWebhookSealed,
    welcome: s.shopWelcome,
    pickupNote: s.shopPickupNote,
    ordersInCap: ms?.ordersInCap ?? false,
    listed,
    sellsRetail: s.sellsRetail,
    taxRatePct: s.taxRatePct,
  };
}

const cents = (v: string | null, what: string, max = 100_000_00): number | null => {
  if (v == null || v === "") return null;
  const n = Math.round(Number(v.replace(/[$,\s]/g, "")) * 100);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new UserError(`${what}: a dollar amount from 0 to ${money(max)}.`);
  return n;
};
const flag = (fd: FormData, name: string) => {
  const v = fd.getAll(name).map(String);
  return v.includes("on");
};

/**
 * Settings -> Online shop: the address (shared with online booking), on / off, pickup and shipping with the flat rate
 * and free-over, who takes the money (the shop's Stripe keys are sealed; blank keeps the saved ones), the welcome, the
 * pickup instructions, and whether order mail counts toward the marketing daily cap.
 */
export async function saveShopSettingsFor(user: CurrentUser, fd: FormData): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change this.");
  const shopId = user.shopId;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { sellsRetail: true, bookingOn: true, stripeKeySealed: true, stripeWebhookSealed: true } });
  if (!shop.sellsRetail) throw new UserError('The online shop sells over the counter\'s inventory: turn on "Sells over the counter" in Settings first.');
  const slugRaw = str(fd.get("slug"));
  const slug = slugRaw ? slugOf(slugRaw) : null;
  if (slug && !SLUG_RE.test(slug)) throw new UserError("The address is 3 to 40 lower-case letters, digits and dashes.");
  const on = flag(fd, "on");
  if (on && !slug) throw new UserError("Give the shop page an address first, like your-shop-name.");
  if (!slug && shop.bookingOn) throw new UserError("Online booking uses this address too. Keep it, or switch booking off first.");
  if (slug) {
    const taken = await db.shop.findFirst({ where: { bookingSlug: slug, id: { not: shopId } }, select: { id: true } });
    if (taken) throw new UserError(`The address "${slug}" is taken. Pick another.`);
  }
  const pickup = flag(fd, "pickup");
  const shipping = flag(fd, "shipping");
  if (on && !pickup && !shipping) throw new UserError("Offer pickup, shipping or both.");
  const shipCents = cents(str(fd.get("shipRate")), "Shipping rate") ?? 0;
  const freeOverCents = cents(str(fd.get("freeOver")), "Free shipping over");
  const payVia = str(fd.get("payVia")) === "platform" ? "platform" : "own";
  if (payVia === "platform" && !platformStripeOn()) throw new UserError("This server has no account of its own to take payments through. Use your own Stripe account.");
  // Stripe Tax collects under the account's own registrations: only the shop's account, never the hosted service's.
  const taxVia = str(fd.get("taxVia")) === "stripe" ? "stripe" : "rate";
  if (taxVia === "stripe" && payVia === "platform") throw new UserError("Stripe Tax works with your own Stripe account only: the tax is collected under that account's registrations.");
  const keyRaw = str(fd.get("stripeKey"));
  const whRaw = str(fd.get("stripeWebhook"));
  if (keyRaw && !looksLikeSecretKey(keyRaw)) throw new UserError("The Stripe secret key starts with sk_live_ or sk_test_ (Developers -> API keys in Stripe).");
  if (whRaw && !looksLikeWebhookSecret(whRaw)) throw new UserError("The webhook signing secret starts with whsec_ (Developers -> Webhooks in Stripe).");
  const clearKeys = flag(fd, "clearKeys");
  const stripeKeySealed = clearKeys ? null : keyRaw ? seal(keyRaw, shopId, "stripeKey") : shop.stripeKeySealed;
  const stripeWebhookSealed = clearKeys ? null : whRaw ? seal(whRaw, shopId, "stripeWebhook") : shop.stripeWebhookSealed;
  if (on && payVia === "own" && (!stripeKeySealed || !stripeWebhookSealed))
    throw new UserError("To switch the shop on with your own Stripe account, save its secret key and the webhook signing secret.");
  const welcome = str(fd.get("welcome"))?.slice(0, 500) ?? null;
  const pickupNote = str(fd.get("pickupNote"))?.slice(0, 300) ?? null;
  const ordersInCap = flag(fd, "ordersInCap");
  await db.$transaction(async (tx) => {
    await tx.shop.update({
      where: { id: shopId },
      data: {
        bookingSlug: slug,
        shopOn: on,
        shopPickup: pickup,
        shopShipping: shipping,
        shopShipCents: shipCents,
        shopFreeOverCents: freeOverCents,
        shopPayVia: payVia,
        shopTaxVia: taxVia,
        stripeKeySealed,
        stripeWebhookSealed,
        shopWelcome: welcome,
        shopPickupNote: pickupNote,
      },
    });
    await tx.messagingSettings.upsert({ where: { shopId }, create: { shopId, ordersInCap }, update: { ordersInCap } });
  });
}

/** The shop page's address, or null without a slug or a public address. */
export function shopUrl(slug: string | null): string | null {
  const base = publicBaseUrl();
  return slug && base ? `${base}/shop/${slug}` : null;
}

/** Where Stripe sends this shop's events (its own account): shown in Settings for the shop to paste into Stripe. */
export function webhookUrl(shopId: string): string | null {
  const base = publicBaseUrl();
  return base ? `${base}/api/shop/stripe/${shopId}` : null;
}

// ---------------------------------------------------------------- the item listing (the part page's card)

/** The part page's "Online shop" card: listed or not, the customer's title and text. Techs may edit the words, not the listing. */
export async function saveListingFor(user: CurrentUser, partId: string, fd: FormData): Promise<void> {
  if (!ID_RE.test(partId)) throw new UserError("Part not found.");
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId }, select: { online: true, onlineTitle: true, onlineText: true, priceCents: true, consignLinkId: true } });
  if (!p) throw new UserError("Part not found.");
  // A field the form didn't send stays as it was (a tech's form has no listing box).
  const online = user.role === "TECH" || !fd.has("online") ? p.online : flag(fd, "online");
  if (online && p.priceCents == null) throw new UserError("Give the item a price before listing it.");
  if (online && p.consignLinkId) throw new UserError("A partner's consigned stock can't be sold online: it stays theirs until it sells at the counter.");
  const onlineTitle = fd.has("onlineTitle") ? (str(fd.get("onlineTitle"))?.slice(0, 120) ?? null) : p.onlineTitle;
  const onlineText = fd.has("onlineText") ? (str(fd.get("onlineText"))?.slice(0, 2000) ?? null) : p.onlineText;
  await db.part.updateMany({ where: { id: partId, shopId: user.shopId }, data: { online, onlineTitle, onlineText } });
}

const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTO_BYTES = 2_500_000;

export async function addPhotoFor(user: CurrentUser, partId: string, file: File): Promise<string> {
  if (!ID_RE.test(partId)) throw new UserError("Part not found.");
  const p = await db.part.findFirst({ where: { id: partId, shopId: user.shopId }, select: { id: true, _count: { select: { photos: true } } } });
  if (!p) throw new UserError("Part not found.");
  if (!IMAGE.has(file.type)) throw new UserError("Photos are JPEG, PNG or WebP.");
  if (file.size > MAX_PHOTO_BYTES) throw new UserError("That photo is too large (2.5 MB at most). Use a smaller one.");
  if (p._count.photos >= MAX_PHOTOS) throw new UserError(`An item shows up to ${MAX_PHOTOS} photos. Remove one first.`);
  const data = new Uint8Array(await file.arrayBuffer());
  if (!data.length) throw new UserError("That photo is empty.");
  const row = await db.partPhoto.create({ data: { shopId: user.shopId, partId, mime: file.type, data, sortOrder: p._count.photos }, select: { id: true } });
  return row.id;
}

export async function removePhotoFor(user: CurrentUser, photoId: string): Promise<void> {
  const r = await db.partPhoto.deleteMany({ where: { id: photoId, shopId: user.shopId } });
  if (!r.count) throw new UserError("That photo is gone already.");
}

// ---------------------------------------------------------------- the public store

export type PublicStore = {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  timeZone: string;
  slug: string;
  open: boolean;
  welcome: string | null;
  pickup: boolean;
  shipping: boolean;
  shipCents: number;
  freeOverCents: number | null;
  pickupNote: string | null;
  taxRatePct: number;
  payVia: "own" | "platform";
  /** "stripe": Stripe Tax works out the tax on shipped orders at checkout; pickup orders (and "rate") use the shop's rate. */
  taxVia: "rate" | "stripe";
};

/** The shop a slug names and whether it sells online right now: switched on, a counter, and a way to take payment. */
export async function publicStore(slug: string): Promise<PublicStore | null> {
  if (!SLUG_RE.test(slug)) return null;
  const s = await db.shop.findUnique({
    where: { bookingSlug: slug },
    select: {
      id: true,
      name: true,
      phone: true,
      address: true,
      timeZone: true,
      bookingSlug: true,
      shopOn: true,
      sellsRetail: true,
      shopWelcome: true,
      shopPickup: true,
      shopShipping: true,
      shopShipCents: true,
      shopFreeOverCents: true,
      shopPickupNote: true,
      taxRatePct: true,
      shopPayVia: true,
      shopTaxVia: true,
      stripeKeySealed: true,
      stripeWebhookSealed: true,
    },
  });
  if (!s) return null;
  const payVia = s.shopPayVia === "platform" ? "platform" : "own";
  const canPay = payVia === "platform" ? platformStripeOn() : !!s.stripeKeySealed && !!s.stripeWebhookSealed;
  return {
    id: s.id,
    name: s.name,
    phone: s.phone,
    address: s.address,
    timeZone: s.timeZone,
    slug: s.bookingSlug!,
    // Paused while the program itself is read-only (hub-accounts-billing-design.md 3.5): no new orders.
    open: s.shopOn && s.sellsRetail && canPay && (s.shopPickup || s.shopShipping) && (await baseWritable(s.id)),
    welcome: s.shopWelcome,
    pickup: s.shopPickup,
    shipping: s.shopShipping,
    shipCents: s.shopShipCents,
    freeOverCents: s.shopFreeOverCents,
    pickupNote: s.shopPickupNote,
    taxRatePct: s.taxRatePct,
    payVia,
    taxVia: payVia === "own" && s.shopTaxVia === "stripe" ? "stripe" : "rate",
  };
}

export type CatalogItem = {
  id: string;
  title: string;
  partNumber: string;
  brand: string | null;
  kind: string;
  priceCents: number;
  unit: string | null;
  inStock: boolean;
  photoId: string | null;
  tags: string[];
};

const LISTED = (shopId: string): Prisma.PartWhereInput => ({ shopId, online: true, priceCents: { not: null }, consignLinkId: null });
const titleOf = (p: { onlineTitle: string | null; description: string }) => p.onlineTitle?.trim() || p.description;

/** The listed items, by words, number or kind; in stock first. */
export async function catalog(shopId: string, o: { q?: string | null; kind?: string | null; take?: number } = {}): Promise<CatalogItem[]> {
  const q = (o.q ?? "").trim().slice(0, 80);
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const kind = o.kind && KIND_LABEL[o.kind] ? o.kind : null;
  const rows = await db.part.findMany({
    where: {
      ...LISTED(shopId),
      ...(kind ? { kind: kind as PartKind } : {}),
      ...(q
        ? {
            OR: [
              { partNumber: { contains: q, mode: "insensitive" } },
              ...(numberKey(q) ? [{ numberKeys: { has: numberKey(q) } }] : []),
              {
                AND: words.map((w) => ({
                  OR: [
                    { description: { contains: w, mode: "insensitive" as const } },
                    { onlineTitle: { contains: w, mode: "insensitive" as const } },
                    { brand: { contains: w, mode: "insensitive" as const } },
                    { fits: { contains: w, mode: "insensitive" as const } },
                  ],
                })),
              },
            ],
          }
        : {}),
    },
    orderBy: [{ description: "asc" }],
    take: Math.min(o.take ?? 60, 200),
    select: {
      id: true,
      description: true,
      onlineTitle: true,
      partNumber: true,
      brand: true,
      kind: true,
      priceCents: true,
      unit: true,
      qtyOnHand: true,
      condition: true,
      origin: true,
      photos: { select: { id: true }, orderBy: { sortOrder: "asc" }, take: 1 },
    },
  });
  return rows
    .map((p) => ({
      id: p.id,
      title: titleOf(p),
      partNumber: p.partNumber,
      brand: p.brand,
      kind: p.kind,
      priceCents: p.priceCents!,
      unit: p.unit,
      inStock: p.qtyOnHand > 0,
      photoId: p.photos[0]?.id ?? null,
      tags: partTags(p),
    }))
    .sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.title.localeCompare(b.title));
}

/** The kinds the shop has listed, for the category links. */
export async function catalogKinds(shopId: string): Promise<{ kind: string; label: string; n: number }[]> {
  const g = await db.part.groupBy({ by: ["kind"], where: LISTED(shopId), _count: { _all: true } });
  return g.map((r) => ({ kind: r.kind, label: KIND_LABEL[r.kind] ?? r.kind, n: r._count._all })).sort((a, b) => a.label.localeCompare(b.label));
}

export type ItemView = CatalogItem & { text: string | null; fits: string | null; photoIds: string[]; description: string };

export async function catalogItem(shopId: string, partId: string): Promise<ItemView | null> {
  if (!ID_RE.test(partId)) return null;
  const p = await db.part.findFirst({ where: { ...LISTED(shopId), id: partId }, include: { photos: { select: { id: true }, orderBy: { sortOrder: "asc" } } } });
  if (!p) return null;
  return {
    id: p.id,
    title: titleOf(p),
    description: p.description,
    partNumber: p.partNumber,
    brand: p.brand,
    kind: p.kind,
    priceCents: p.priceCents!,
    unit: p.unit,
    inStock: p.qtyOnHand > 0,
    photoId: p.photos[0]?.id ?? null,
    photoIds: p.photos.map((x) => x.id),
    tags: partTags(p),
    text: p.onlineText,
    fits: p.fits,
  };
}

/** A listed item's photo, for the public route: only while the item is listed. */
export async function publicPhoto(photoId: string): Promise<{ data: Uint8Array; mime: string } | null> {
  if (!ID_RE.test(photoId)) return null;
  const ph = await db.partPhoto.findUnique({ where: { id: photoId }, select: { data: true, mime: true, part: { select: { online: true, priceCents: true, shop: { select: { shopOn: true } } } } } });
  if (!ph || !ph.part.online || ph.part.priceCents == null || !ph.part.shop.shopOn) return null;
  return { data: ph.data, mime: ph.mime };
}

// ---------------------------------------------------------------- the cart (in the address: "id:qty,id:qty")

export type Cart = Map<string, number>;

export function parseCart(c: string | null | undefined): Cart {
  const cart: Cart = new Map();
  if (!c) return cart;
  for (const piece of String(c).slice(0, 2000).split(",")) {
    const [id, q] = piece.split(":");
    if (!id || !ID_RE.test(id)) continue;
    const qty = Number(q);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    cart.set(id, Math.min(MAX_QTY, Math.round(qty * 8) / 8));
    if (cart.size >= MAX_LINES) break;
  }
  return cart;
}

export const encodeCart = (cart: Cart) => [...cart.entries()].map(([id, q]) => `${id}:${q}`).join(",");

/** The cart with one line set (qty 0 removes it). */
export function cartWith(cart: Cart, partId: string, qty: number): Cart {
  const next = new Map(cart);
  if (!ID_RE.test(partId)) return next;
  if (!Number.isFinite(qty) || qty <= 0) next.delete(partId);
  else {
    if (!next.has(partId) && next.size >= MAX_LINES) throw new UserError(`A cart holds up to ${MAX_LINES} different items.`);
    next.set(partId, Math.min(MAX_QTY, Math.round(qty * 8) / 8));
  }
  return next;
}

export type CartLine = { partId: string; partNumber: string; title: string; qty: number; unit: string | null; unitPriceCents: number; lineCents: number; available: number; problem: string | null };
export type PricedCart = {
  lines: CartLine[];
  subtotalCents: number;
  shipCents: number;
  taxCents: number;
  totalCents: number;
  problems: string[];
  shipLine: SaleLineInput | null;
  taxAtCheckout: boolean;
};

const shipLineFor = (store: PublicStore, fulfil: "pickup" | "ship", subtotal: number): SaleLineInput | null => {
  if (fulfil !== "ship") return null;
  const free = store.freeOverCents != null && subtotal >= store.freeOverCents;
  const c = free ? 0 : store.shipCents;
  return { description: free ? "Shipping (free)" : "Shipping", qty: 1, unitPriceCents: c, taxable: false };
};

/**
 * The cart priced as the counter would: listed items only, today's prices, stock noted, the shop's one tax rate,
 * shipping untaxed. With Stripe Tax, a shipped order's tax is worked out at checkout from the address: the total here
 * is before tax (`taxAtCheckout`).
 */
export async function priceCart(store: PublicStore, cart: Cart, fulfil: "pickup" | "ship"): Promise<PricedCart> {
  const ids = [...cart.keys()];
  const parts = ids.length
    ? await db.part.findMany({
        where: { ...LISTED(store.id), id: { in: ids } },
        select: { id: true, description: true, onlineTitle: true, partNumber: true, priceCents: true, unit: true, qtyOnHand: true },
      })
    : [];
  const byId = new Map(parts.map((p) => [p.id, p]));
  const lines: CartLine[] = [];
  const problems: string[] = [];
  for (const [id, qtyRaw] of cart) {
    const p = byId.get(id);
    if (!p) {
      problems.push("An item in your cart isn't for sale any more; it was taken out.");
      continue;
    }
    let qty = qtyRaw;
    let problem: string | null = null;
    if (p.unit === "yd") {
      if (!inEighths(qty)) qty = Math.round(qty * 8) / 8;
    } else if (!Number.isInteger(qty)) qty = Math.max(1, Math.round(qty));
    const available = Math.max(0, p.qtyOnHand);
    if (available <= 0) problem = "Out of stock";
    else if (qty > available) problem = `Only ${qtyText(available, p.unit)} left`;
    const unitPriceCents = p.priceCents!;
    const lineCents = Math.round(qty * unitPriceCents);
    lines.push({ partId: p.id, partNumber: p.partNumber, title: titleOf(p), qty, unit: p.unit, unitPriceCents, lineCents, available, problem });
    if (problem) problems.push(`${titleOf(p)}: ${problem.toLowerCase()}.`);
  }
  const saleLines = lines.map((l) => ({ qty: l.qty, unitPriceCents: l.unitPriceCents, taxable: true }));
  const subtotal = saleLines.reduce((a, l) => a + Math.round(l.qty * l.unitPriceCents), 0);
  const shipLine = shipLineFor(store, fulfil, subtotal);
  const taxAtCheckout = store.taxVia === "stripe" && fulfil === "ship";
  const t = saleTotals([...saleLines, ...(shipLine ? [{ qty: 1, unitPriceCents: shipLine.unitPriceCents, taxable: false }] : [])], 0, taxAtCheckout ? 0 : store.taxRatePct);
  return { lines, subtotalCents: subtotal, shipCents: shipLine?.unitPriceCents ?? 0, taxCents: t.tax, totalCents: t.total, problems, shipLine, taxAtCheckout };
}

// ---------------------------------------------------------------- checkout

export type OrderItem = { partId: string | null; partNumber: string | null; description: string; qty: number; unit: string | null; unitPriceCents: number; short?: number };
export type CheckoutInput = { slug: string; cart: Cart; customer: OnlineCustomer; fulfil: "pickup" | "ship"; address: string | null; note: string | null };

function stripeKeyFor(shop: { id: string; shopPayVia: string; stripeKeySealed: string | null }): string {
  if (shop.shopPayVia === "platform") {
    const k = process.env.STRIPE_SECRET_KEY?.trim();
    if (!k) throw new UserError("Payments aren't set up on this server. Please call the shop.");
    return k;
  }
  const k = unseal(shop.stripeKeySealed, shop.id, "stripeKey");
  if (!k) throw new UserError("The shop's card processing isn't set up. Please call the shop.");
  return k.plain;
}

const orderUrl = (token: string) => `${publicBaseUrl() ?? ""}/shop/o/${token}`;
const fmtNo = (n: number) => `#${n}`;

/**
 * The customer goes to pay: the cart priced and checked against stock, the customer matched or made, a PENDING order
 * with a fresh token, and a Stripe Checkout Session whose lines add up to exactly the order's total (each item as one
 * line at its line total, then tax and shipping). Returns where to send the customer.
 */
export async function startCheckout(a: CheckoutInput, now = new Date()): Promise<{ url: string; token: string; orderId: string }> {
  const store = await publicStore(a.slug);
  if (!store || !store.open) throw new UserError("The shop isn't taking online orders right now. Please call us.");
  const base = publicBaseUrl();
  if (!base) throw new UserError("This shop has no public address for payments. Please call us.");
  const fulfil = a.fulfil === "ship" ? "ship" : "pickup";
  if (fulfil === "ship" && !store.shipping) throw new UserError("This shop doesn't ship; choose pickup.");
  if (fulfil === "pickup" && !store.pickup) throw new UserError("This shop ships only; choose shipping.");
  const address = a.address?.trim().slice(0, 400) || null;
  if (fulfil === "ship" && (!address || address.length < 10)) throw new UserError("Please give the full shipping address.");
  if (!a.cart.size) throw new UserError("Your cart is empty.");
  const priced = await priceCart(store, a.cart, fulfil);
  if (priced.problems.length) throw new UserError(priced.problems.join(" "));
  if (!priced.lines.length) throw new UserError("Your cart is empty.");
  if (priced.totalCents <= 0) throw new UserError("There's nothing to pay for.");
  if (priced.totalCents < 50) throw new UserError("The smallest card payment is $0.50.");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: store.id }, select: { id: true, shopPayVia: true, stripeKeySealed: true } });
  const key = stripeKeyFor(shop); // before anything is written: a shop without a working key refuses here
  const token = crypto.randomBytes(32).toString("base64url");
  const orderId = crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 25)
    .replace(/^[0-9]/, "c"); // a cuid-shaped id, known before the row (the link is sealed with it)
  const items: OrderItem[] = priced.lines.map((l) => ({ partId: l.partId, partNumber: l.partNumber, description: l.title, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents }));
  const order = await db.$transaction(async (tx) => {
    const customer = await customerForOnline(tx, store.id, a.customer, "online shop");
    const sh = await tx.shop.update({ where: { id: store.id }, data: { nextWebOrderNumber: { increment: 1 } }, select: { nextWebOrderNumber: true } });
    return tx.webOrder.create({
      data: {
        id: orderId,
        shopId: store.id,
        number: sh.nextWebOrderNumber - 1,
        status: "PENDING",
        customerId: customer.id,
        linkSealed: seal(orderUrl(token), store.id, `orderLink:${orderId}`),
        name: a.customer.name.trim().slice(0, 120),
        phone: a.customer.phone,
        email: a.customer.email,
        notify: a.customer.notify,
        fulfil,
        address,
        items: items as unknown as Prisma.InputJsonValue,
        subtotalCents: priced.subtotalCents,
        shipCents: priced.shipCents,
        taxCents: priced.taxCents,
        totalCents: priced.totalCents,
        payVia: store.payVia,
        taxVia: priced.taxAtCheckout ? "stripe" : "rate",
        tokenHash: sha256(token),
        note: a.note?.trim().slice(0, 500) || null,
        createdAt: now,
      },
      select: { id: true, number: true },
    });
  });
  const lines = [
    ...priced.lines.map((l) => ({ name: `${l.title}${l.qty !== 1 ? ` x ${qtyText(l.qty, l.unit)}` : ""}`, description: l.partNumber, unitCents: l.lineCents, qty: 1 })),
    ...(priced.taxCents > 0 && !priced.taxAtCheckout ? [{ name: "Sales tax", unitCents: priced.taxCents, qty: 1 }] : []),
    ...(priced.shipCents > 0 ? [{ name: "Shipping", unitCents: priced.shipCents, qty: 1, taxCode: TAX_CODE_SHIPPING }] : []),
  ];
  let session;
  try {
    session = await createCheckoutSession(key, {
      lines,
      successUrl: `${orderUrl(token)}?paid=1`,
      cancelUrl: `${base}/shop/${store.slug}/cart?c=${encodeURIComponent(encodeCart(a.cart))}&back=1`,
      email: a.customer.email,
      metadata: { shopId: store.id, orderId: order.id, orderNumber: String(order.number), endpoint: store.payVia === "platform" ? "platform" : store.id },
      reference: order.id,
      idempotencyKey: `web-order:${order.id}`,
      automaticTax: priced.taxAtCheckout,
    });
  } catch (e) {
    await db.webOrder.updateMany({
      where: { id: order.id, status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: now, staffNote: `Payment page couldn't be opened: ${e instanceof Error ? e.message.slice(0, 300) : "error"}` },
    });
    throw e;
  }
  if (!session.url) throw new UserError("The card processor gave no payment page. Please try again.");
  await db.webOrder.updateMany({ where: { id: order.id }, data: { stripeSessionId: session.id } });
  return { url: session.url, token, orderId: order.id };
}

// ---------------------------------------------------------------- payment

/** The user the books record online sales under: the shop's first owner (else admin). */
async function booksUserFor(shopId: string): Promise<CurrentUser> {
  const u =
    (await db.user.findFirst({ where: { shopId, role: "OWNER", active: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, email: true } })) ??
    (await db.user.findFirst({ where: { shopId, role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, email: true } })) ??
    (await db.user.findFirst({ where: { shopId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, email: true } }));
  if (!u) throw new UserError("This shop has no users to record the sale under.");
  return { id: u.id, shopId, role: "OWNER", name: "Online shop", email: u.email };
}

type OrderRow = Prisma.WebOrderGetPayload<{
  include: { shop: { select: { name: true; phone: true; timeZone: true; taxRatePct: true; shopPayVia: true; stripeKeySealed: true; shopPickupNote: true; bookingSlug: true } } };
}>;
const ORDER_INCLUDE = { shop: { select: { name: true, phone: true, timeZone: true, taxRatePct: true, shopPayVia: true, stripeKeySealed: true, shopPickupNote: true, bookingSlug: true } } } as const;

/**
 * Stripe says the session is paid: once. The order is claimed PENDING -> PAID; the sale goes in the books with what is
 * actually on the shelf (a line short of stock is sold short and the difference refunded; nothing on the shelf at all
 * means a full refund and a cancelled order); the customer hears.
 */
/** Payments are applied one at a time per shop in this process, so two orders for the last unit don't both sell it. */
const applying = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = applying.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  applying.set(
    key,
    run.catch(() => undefined),
  );
  try {
    return await run;
  } finally {
    if (applying.get(key) === run.catch(() => undefined)) applying.delete(key);
  }
}

export async function applyPayment(orderId: string, a: { sessionId: string | null; intent: string | null }, now = new Date()): Promise<{ applied: boolean; status: string }> {
  const first = await db.webOrder.findUnique({ where: { id: orderId }, select: { shopId: true } });
  if (!first) return { applied: false, status: "missing" };
  return oneAtATime(`pay:${first.shopId}`, () => applyPaymentNow(orderId, a, now));
}

async function applyPaymentNow(orderId: string, a: { sessionId: string | null; intent: string | null }, now: Date): Promise<{ applied: boolean; status: string }> {
  const claimed = await db.webOrder.updateMany({
    where: { id: orderId, status: "PENDING", ...(a.sessionId ? { stripeSessionId: a.sessionId } : {}) },
    data: { status: "PAID", paidAt: now, stripeIntent: a.intent },
  });
  const order = await db.webOrder.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  if (!order) return { applied: false, status: "missing" };
  if (!claimed.count) {
    // Paid after the order was cancelled (a stale order, or Stripe's expiry came first): the money goes straight back.
    if (order.status === "CANCELLED" && a.intent && order.refundedCents === 0 && !order.saleId) {
      try {
        const key = stripeKeyFor({ id: order.shopId, shopPayVia: order.shop.shopPayVia, stripeKeySealed: order.shop.stripeKeySealed });
        const r = await refundPayment(key, a.intent, null, `web-order-late:${order.id}`, "paid after cancellation");
        await db.webOrder.update({ where: { id: order.id }, data: { stripeIntent: a.intent, refundedCents: r.amount, staffNote: `Paid after it was cancelled: ${money(r.amount)} refunded.` } });
      } catch (e) {
        await db.webOrder.update({
          where: { id: order.id },
          data: { stripeIntent: a.intent, staffNote: `Paid after it was cancelled: refund it in Stripe (${e instanceof Error ? e.message.slice(0, 200) : "error"}).` },
        });
      }
    }
    return { applied: false, status: order.status };
  }
  try {
    const items = order.items as unknown as OrderItem[];
    const ids = items.map((i) => i.partId).filter(Boolean) as string[];
    const parts = new Map((await db.part.findMany({ where: { shopId: order.shopId, id: { in: ids } }, select: { id: true, qtyOnHand: true, unit: true } })).map((p) => [p.id, p]));
    const sold: SaleLineInput[] = [];
    const kept: OrderItem[] = [];
    for (const it of items) {
      const p = it.partId ? parts.get(it.partId) : null;
      const onHand = p ? Math.max(0, p.qtyOnHand) : 0;
      let have = Math.min(it.qty, onHand);
      if (p?.unit === "yd") have = Math.floor(have * 8) / 8;
      else have = Math.floor(have);
      const short = Math.round((it.qty - have) * 1000) / 1000;
      kept.push({ ...it, short: short > 0 ? short : undefined });
      if (have > 0) sold.push({ partId: it.partId, description: it.description, qty: have, unitPriceCents: it.unitPriceCents, taxable: true });
    }
    const shipLine: SaleLineInput | null = sold.length && order.fulfil === "ship" && order.shipCents > 0 ? { description: "Shipping", qty: 1, unitPriceCents: order.shipCents, taxable: false } : null;
    const lines = [...sold, ...(shipLine ? [shipLine] : [])];
    // Stripe Tax: the tax and the total are what Stripe charged (asked for with the lines, so a short line's share is known).
    let paidTotal = order.totalCents;
    let paidTax = order.taxCents;
    let givenTax: number | null = null;
    if (order.taxVia === "stripe" && order.stripeSessionId) {
      const key = stripeKeyFor({ id: order.shopId, shopPayVia: order.shop.shopPayVia, stripeKeySealed: order.shop.stripeKeySealed });
      const session = await retrieveSession(key, order.stripeSessionId, { lines: true });
      paidTotal = session.amount_total ?? order.totalCents;
      paidTax = session.total_details?.amount_tax ?? 0;
      givenTax = lines.length ? keptTax(session, items, kept, !!shipLine, paidTax) : 0;
    }
    if (givenTax == null && lines.length) {
      // The rate as it stood at checkout. If today's rate no longer gives the tax the customer paid on the whole order
      // (the shop changed its rate meanwhile), the order's own tax is used, in proportion to what is sold.
      const wholeByRate = saleTotals(
        [
          ...items.map((i) => ({ qty: i.qty, unitPriceCents: i.unitPriceCents, taxable: true })),
          ...(order.fulfil === "ship" && order.shipCents > 0 ? [{ qty: 1, unitPriceCents: order.shipCents, taxable: false }] : []),
        ],
        0,
        order.shop.taxRatePct,
      ).tax;
      if (wholeByRate !== order.taxCents) {
        const soldNet = sold.reduce((s2, l) => s2 + Math.round(l.qty * l.unitPriceCents), 0);
        givenTax = order.subtotalCents > 0 ? Math.round((order.taxCents * soldNet) / order.subtotalCents) : 0;
      }
    }
    const totals =
      givenTax != null
        ? withGivenTax(lines, givenTax)
        : saleTotals(
            lines.map((l) => ({ qty: l.qty, unitPriceCents: l.unitPriceCents, taxable: l.taxable })),
            0,
            order.shop.taxRatePct,
          );
    const refund = Math.max(0, paidTotal - totals.total);
    let saleId: string | null = null;
    if (lines.length) {
      const user = await booksUserFor(order.shopId);
      const r = await completeSaleAs(user, {
        customerId: order.customerId,
        lines,
        tenders: [{ method: "ONLINE", amountCents: totals.total, note: `Online order ${fmtNo(order.number)}` }],
        note: `Online order ${fmtNo(order.number)}${order.fulfil === "ship" ? " (ship)" : " (pickup)"}${givenTax != null ? ", tax by Stripe Tax" : ""}`,
        clientKey: `web-${order.id}`,
        taxCents: givenTax,
      });
      saleId = r.saleId;
    }
    let refunded = 0;
    if (refund > 0 && order.stripeIntent) {
      const key = stripeKeyFor({ id: order.shopId, shopPayVia: order.shop.shopPayVia, stripeKeySealed: order.shop.stripeKeySealed });
      await refundPayment(key, order.stripeIntent, refund, `web-order-short:${order.id}`, "out of stock");
      refunded = refund;
    }
    const cancelled = !lines.length;
    const negative = saleId ? await db.part.findMany({ where: { shopId: order.shopId, id: { in: ids }, qtyOnHand: { lt: 0 } }, select: { partNumber: true } }) : [];
    const stockNote = negative.length ? ` Check stock: ${negative.map((p) => p.partNumber).join(", ")} went below zero (sold at the counter at the same time?).` : "";
    await db.webOrder.update({
      where: { id: order.id },
      data: {
        items: kept as unknown as Prisma.InputJsonValue,
        saleId,
        taxCents: paidTax,
        totalCents: paidTotal,
        refundedCents: refunded,
        status: cancelled ? "CANCELLED" : "PAID",
        cancelledAt: cancelled ? now : null,
        staffNote:
          (refund > 0 && !order.stripeIntent
            ? `${money(refund)} short of stock: refund it in Stripe (no payment id was given).`
            : kept.some((k) => k.short)
              ? `${money(refund)} refunded for items short of stock.`
              : "") + stockNote || null,
      },
    });
    const fresh = (await db.webOrder.findUnique({ where: { id: order.id }, include: ORDER_INCLUDE }))!;
    await notifyOrder(fresh, cancelled ? "cancelled" : "paid", now);
    return { applied: true, status: fresh.status };
  } catch (e) {
    // Paid, but the books or the refund failed: the order stays PAID with the problem on it for staff to sort out.
    await db.webOrder.update({ where: { id: order.id }, data: { staffNote: `Check this order: ${e instanceof Error ? e.message.slice(0, 400) : "error"}` } });
    console.error("online shop payment:", e instanceof Error ? e.message : e);
    return { applied: true, status: "PAID" };
  }
}

/** Totals with the tax Stripe worked out (the lines' own sums; nothing discounted). */
function withGivenTax(lines: SaleLineInput[], taxCents: number) {
  const subtotal = lines.reduce((a, l) => a + Math.round(l.qty * l.unitPriceCents), 0);
  return { subtotal, tax: taxCents, total: subtotal + taxCents };
}

/**
 * The tax on what is actually sold, from Stripe's lines (one per item in the order's order, then shipping): a line
 * short of stock keeps its share by quantity. Without the lines, the order's tax in proportion to what is kept.
 */
function keptTax(session: StripeSession, items: OrderItem[], kept: OrderItem[], shipping: boolean, totalTax: number): number {
  const lines = session.line_items?.data ?? [];
  if (lines.length === items.length + (shipping ? 1 : 0)) {
    let tax = 0;
    kept.forEach((k, i) => {
      const have = k.qty - (k.short ?? 0);
      if (have > 0) tax += Math.round(((lines[i]?.amount_tax ?? 0) * have) / k.qty);
    });
    if (shipping) tax += lines[items.length]?.amount_tax ?? 0;
    return Math.min(totalTax, tax);
  }
  const all = items.reduce((a, i) => a + Math.round(i.qty * i.unitPriceCents), 0);
  const have = kept.reduce((a, k) => a + Math.round((k.qty - (k.short ?? 0)) * k.unitPriceCents), 0);
  return all > 0 ? Math.round((totalTax * have) / all) : 0;
}

/** The return page: a PENDING order whose session Stripe reports paid is applied (the webhook may be slow or missing). */
export async function confirmFromReturn(token: string, now = new Date()): Promise<void> {
  if (!TOKEN_RE.test(token)) return;
  const o = await db.webOrder.findUnique({
    where: { tokenHash: sha256(token) },
    select: { id: true, status: true, stripeSessionId: true, shopId: true, shop: { select: { shopPayVia: true, stripeKeySealed: true } } },
  });
  if (!o || o.status !== "PENDING" || !o.stripeSessionId) return;
  try {
    const key = stripeKeyFor({ id: o.shopId, ...o.shop });
    const s = await retrieveSession(key, o.stripeSessionId);
    if (s.payment_status === "paid" || s.payment_status === "no_payment_required") await applyPayment(o.id, { sessionId: s.id, intent: s.payment_intent }, now);
  } catch (e) {
    console.error("online shop return:", e instanceof Error ? e.message : e);
  }
}

/**
 * A Stripe webhook for "platform" (the server's own account) or a shop id (its own account). The signature decides;
 * a paid session applies the payment to its order; an expired one cancels a PENDING order.
 */
export async function handleWebhook(who: string, rawBody: string, signature: string | null, now = new Date()): Promise<{ status: number; body: string }> {
  let secret: string | null = null;
  let shopId: string | null = null;
  if (who === "platform") secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
  else if (ID_RE.test(who)) {
    const s = await db.shop.findUnique({ where: { id: who }, select: { stripeWebhookSealed: true } });
    secret = s ? (unseal(s.stripeWebhookSealed, who, "stripeWebhook")?.plain ?? null) : null;
    shopId = who;
  }
  if (!secret) return { status: 404, body: "No such endpoint." };
  const ev = verifyWebhook(rawBody, signature, secret, now);
  if (!ev) return { status: 400, body: "Bad signature." };
  const obj = ev.data.object;
  if (obj.object !== "checkout.session" || typeof obj.id !== "string") return { status: 200, body: "ignored" };
  const sessionId = obj.id;
  const order = await db.webOrder.findUnique({ where: { stripeSessionId: sessionId }, select: { id: true, shopId: true, status: true, payVia: true } });
  if (!order) return { status: 200, body: "no order" };
  // The endpoint must be the order's own: a shop's secret can't confirm another shop's order, nor the platform's a shop's.
  if (shopId ? order.shopId !== shopId || order.payVia !== "own" : order.payVia !== "platform") return { status: 200, body: "not this endpoint" };
  if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
    if (obj.payment_status === "paid" || obj.payment_status === "no_payment_required") {
      const intent = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
      await applyPayment(order.id, { sessionId, intent }, now);
    }
  } else if (ev.type === "checkout.session.expired" || ev.type === "checkout.session.async_payment_failed") {
    await db.webOrder.updateMany({ where: { id: order.id, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: now, staffNote: "Never paid." } });
  }
  return { status: 200, body: "ok" };
}

// ---------------------------------------------------------------- the order mail

const itemsText = (items: OrderItem[]) =>
  items
    .map(
      (i) =>
        `${i.description}${i.partNumber ? ` (${i.partNumber})` : ""} x ${qtyText(i.qty, i.unit)}  ${money(Math.round(i.qty * i.unitPriceCents))}${i.short ? `  (${qtyText(i.short, i.unit)} out of stock, refunded)` : ""}`,
    )
    .join("\n");

/** One message per stage per order (paid, ready, shipped, cancelled), the preferred way, when Marketing is on. */
async function notifyOrder(o: OrderRow, stage: "paid" | "ready" | "shipped" | "cancelled", now = new Date(), tx: Db = db): Promise<void> {
  if (!o.customerId || !(await moduleOn(o.shopId, "marketing"))) return;
  const ms = await messagingView(o.shopId, tx);
  const link = unseal(o.linkSealed, o.shopId, `orderLink:${o.id}`)?.plain ?? "";
  const items = o.items as unknown as OrderItem[];
  const vars: Record<string, string> = {
    shop_name: o.shop.name,
    shop_phone: o.shop.phone ?? "",
    order: fmtNo(o.number),
    items: itemsText(items),
    total: money(o.totalCents - o.refundedCents),
    short_line:
      o.status !== "CANCELLED" && o.refundedCents > 0
        ? ` ${items.filter((i) => i.short).length === 1 ? "One item was" : "Some items were"} out of stock; ${money(o.refundedCents)} goes back to your card in a few days.`
        : "",
    fulfil_line: o.fulfil === "ship" ? " We'll let you know when it ships." : " We'll let you know when it's ready to pick up.",
    pickup_line: o.shop.shopPickupNote?.trim() || "Come to the counter with your order number.",
    tracking_line: o.tracking ? ` Tracking: ${o.tracking}.` : "",
    refund_line: o.refundedCents > 0 ? ` ${money(o.refundedCents)} goes back to your card in a few days.` : "",
    order_link: link,
  };
  const key = stage === "paid" ? "order_paid" : stage === "ready" ? "order_ready" : stage === "shipped" ? "order_shipped" : "order_cancelled";
  await queueToCustomer(tx, {
    shopId: o.shopId,
    customerId: o.customerId,
    kind: "order_notice",
    channels: "preferred",
    dedupeKey: `web:${o.id}:${stage}`,
    refType: "web_order",
    refId: o.id,
    sendAfter: now,
    ms,
    content: (ch) => {
      const c = renderKind(ms, key, ch, vars);
      return { subject: c.subject, body: ch === "email" ? c.body : plainText(c.body).text };
    },
  });
}

/** The worker's question: still send this order message? Not for an order that is gone, or a "ready" for one since cancelled. */
export async function orderNoticeStillWanted(row: { refType: string | null; refId: string | null; dedupeKey: string | null }): Promise<string | null> {
  if (row.refType !== "web_order" || !row.refId) return null;
  const o = await db.webOrder.findUnique({ where: { id: row.refId }, select: { status: true } });
  if (!o) return "the order is gone";
  if (o.status === "CANCELLED" && !/:cancelled(:|$)/.test(row.dedupeKey ?? "")) return "the order was cancelled";
  return null;
}

// ---------------------------------------------------------------- the customer's order page

export type OrderView = {
  id: string;
  number: number;
  status: OrderStatus;
  fulfil: "pickup" | "ship";
  address: string | null;
  items: OrderItem[];
  subtotalCents: number;
  shipCents: number;
  taxCents: number;
  totalCents: number;
  refundedCents: number;
  taxVia: "rate" | "stripe";
  tracking: string | null;
  note: string | null;
  createdAt: Date;
  paidAt: Date | null;
  shop: { name: string; phone: string | null; address: string | null; timeZone: string; slug: string | null; pickupNote: string | null };
};

export async function orderByToken(token: string): Promise<OrderView | null> {
  if (!TOKEN_RE.test(token)) return null;
  const o = await db.webOrder.findUnique({
    where: { tokenHash: sha256(token) },
    include: { shop: { select: { name: true, phone: true, address: true, timeZone: true, bookingSlug: true, shopPickupNote: true } } },
  });
  if (!o) return null;
  return {
    id: o.id,
    number: o.number,
    status: o.status as OrderStatus,
    fulfil: o.fulfil === "ship" ? "ship" : "pickup",
    address: o.address,
    items: o.items as unknown as OrderItem[],
    subtotalCents: o.subtotalCents,
    shipCents: o.shipCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    refundedCents: o.refundedCents,
    taxVia: o.taxVia === "stripe" ? "stripe" : "rate",
    tracking: o.tracking,
    note: o.note,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    shop: { name: o.shop.name, phone: o.shop.phone, address: o.shop.address, timeZone: o.shop.timeZone, slug: o.shop.bookingSlug, pickupNote: o.shop.shopPickupNote },
  };
}

// ---------------------------------------------------------------- staff: the orders screen

export type StaffOrder = Prisma.WebOrderGetPayload<Record<string, never>> & { customer: { id: string; name: string } | null };

/** Orders to work (paid, ready) or the recent rest, newest first, with the customer's record where one is linked. */
export async function ordersFor(shopId: string, o: { all?: boolean } = {}): Promise<StaffOrder[]> {
  const rows = await db.webOrder.findMany({
    where: { shopId, ...(o.all ? {} : { status: { in: ["PAID", "READY"] } }) },
    orderBy: [{ createdAt: "desc" }, { number: "desc" }],
    take: o.all ? 200 : 100,
  });
  const ids = [...new Set(rows.map((r) => r.customerId).filter(Boolean) as string[])];
  const customers = new Map((ids.length ? await db.customer.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c]));
  return rows.map((r) => ({ ...r, customer: r.customerId ? (customers.get(r.customerId) ?? null) : null }));
}

async function ownOrder(user: CurrentUser, id: string): Promise<OrderRow> {
  if (!ID_RE.test(id)) throw new UserError("Order not found.");
  const o = await db.webOrder.findFirst({ where: { id, shopId: user.shopId }, include: ORDER_INCLUDE });
  if (!o) throw new UserError("Order not found.");
  return o;
}

/** Packed and waiting at the counter: READY, and the customer hears. */
export async function markReadyFor(user: CurrentUser, id: string, now = new Date()): Promise<void> {
  const o = await ownOrder(user, id);
  if (o.status !== "PAID") throw new UserError(`This order is ${ORDER_STATUS_LABEL[o.status as OrderStatus].toLowerCase()}.`);
  if (o.fulfil === "ship") throw new UserError("A shipped order is marked shipped, with its tracking number.");
  await db.webOrder.update({ where: { id }, data: { status: "READY", readyAt: now } });
  await notifyOrder({ ...o, status: "READY" }, "ready", now);
}

/** Picked up (pickup) or shipped with a tracking number (ship): DONE; a shipment tells the customer. */
export async function markDoneFor(user: CurrentUser, id: string, a: { tracking?: string | null } = {}, now = new Date()): Promise<void> {
  const o = await ownOrder(user, id);
  if (o.status !== "PAID" && o.status !== "READY") throw new UserError(`This order is ${ORDER_STATUS_LABEL[o.status as OrderStatus].toLowerCase()}.`);
  const tracking = a.tracking?.trim().slice(0, 120) || null;
  await db.webOrder.update({ where: { id }, data: { status: "DONE", doneAt: now, tracking } });
  if (o.fulfil === "ship") await notifyOrder({ ...o, status: "DONE", tracking }, "shipped", now);
}

/**
 * Cancel a paid order before it goes out: the rest of the payment refunded through Stripe, the sale voided (stock
 * back), CANCELLED, the customer told. Owners and admins.
 */
export async function cancelOrderFor(user: CurrentUser, id: string, reason: string, now = new Date()): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can cancel and refund an order.");
  const o = await ownOrder(user, id);
  if (o.status === "CANCELLED") throw new UserError("This order is cancelled already.");
  if (o.status === "DONE") throw new UserError("This order went out. Take a return at the register instead.");
  if (o.status === "PENDING") {
    await db.webOrder.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: now, staffNote: `Cancelled by ${user.name}: ${reason || "no reason given"}` } });
    return;
  }
  const rest = o.totalCents - o.refundedCents;
  if (rest > 0) {
    if (!o.stripeIntent) throw new UserError("Stripe gave no payment id for this order: refund it in the Stripe dashboard, then cancel it here.");
    const key = stripeKeyFor({ id: o.shopId, shopPayVia: o.shop.shopPayVia, stripeKeySealed: o.shop.stripeKeySealed });
    // The same key on every try, with the same body: a retry after a failure further down gets the same refund back.
    const r = await refundPayment(key, o.stripeIntent, rest, `web-order-cancel:${o.id}`);
    await db.webOrder.update({ where: { id }, data: { refundedCents: o.refundedCents + r.amount, staffNote: `Refund of ${money(r.amount)} made; cancelling.` } });
  }
  if (o.saleId) {
    const sale = await db.sale.findFirst({ where: { id: o.saleId, shopId: o.shopId }, select: { status: true } });
    if (sale && sale.status !== "VOIDED") await voidSaleAs(user, o.saleId, `Online order ${fmtNo(o.number)} cancelled: ${reason || "no reason given"}`);
  }
  await db.webOrder.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: now, refundedCents: o.totalCents, staffNote: `Cancelled by ${user.name}: ${reason || "no reason given"}` } });
  await notifyOrder({ ...o, status: "CANCELLED", refundedCents: o.totalCents }, "cancelled", now);
}

/** A note staff keep on an order. */
export async function noteOrderFor(user: CurrentUser, id: string, note: string): Promise<void> {
  await ownOrder(user, id);
  await db.webOrder.update({ where: { id }, data: { staffNote: note.trim().slice(0, 500) || null } });
}

/** A PENDING order left for two hours (the payment page abandoned without Stripe's expiry event) is cancelled. */
export async function expireStaleOrders(now = new Date()): Promise<number> {
  const r = await db.webOrder.updateMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - 2 * 3_600_000) } },
    data: { status: "CANCELLED", cancelledAt: now, staffNote: "Never paid." },
  });
  return r.count;
}

export const decodeCartParam = (sp: Record<string, string | string[] | undefined>, key = "c") => parseCart(typeof sp[key] === "string" ? (sp[key] as string) : null);
export const fulfilOf = (v: unknown): "pickup" | "ship" => (v === "ship" ? "ship" : "pickup");
