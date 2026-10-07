import "server-only";
// Product feeds for Google and Meta (shop-features-round-2-design.md 4.1, 4.2): Settings, Online shop, "Show your stock on
// Google" and "Show your items on Facebook and Instagram". The program publishes three files that Google and Meta fetch
// every day, at /shop/{slug}/feeds/{token}/{file}: Google's product feed, Google's local inventory feed (what is on the
// shelf, by the store code from the shop's Business Profile) and Meta's catalog. An item goes in when it is listed in the
// online shop with a price and a barcode (its own, or a valid GTIN among its numbers); Meta also needs a photo. Every
// query by shopId; bodies take the user so the check script can drive them.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { actorOf, audit } from "@/lib/audit";
import { publicBaseUrl } from "@/lib/messaging/settings";
import { publicStore, shopUrl } from "@/lib/shop/online-shop";
import { feedRow, googleLocalTsv, googleProductXml, leftOutReason, metaCsv, metaReason, type FeedPart, type FeedRow } from "@/lib/shop/feeds-math";
import { activeStores, onlineStore } from "@/lib/stores";
import { withStoreQty } from "@/lib/stock";

export const FEED_FILES = { google: "google.xml", local: "local.tsv", meta: "meta.csv" } as const;
export type FeedFile = keyof typeof FEED_FILES;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/** The shop's items as the feeds read them (consigned partner stock and machine models included, to say why not). */
async function feedParts(shopId: string): Promise<FeedPart[]> {
  const rows = await db.part.findMany({
    where: { shopId },
    select: {
      id: true,
      partNumber: true,
      altNumbers: true,
      gtin: true,
      description: true,
      onlineTitle: true,
      onlineText: true,
      brand: true,
      kind: true,
      unit: true,
      condition: true,
      qtyOnHand: true,
      priceCents: true,
      online: true,
      consignLinkId: true,
      photos: { select: { id: true }, orderBy: { sortOrder: "asc" }, take: 1 },
    },
    orderBy: { partNumber: "asc" },
  });
  return rows.map(({ photos, ...p }) => ({ ...p, photoId: photos[0]?.id ?? null }));
}

const photoUrl = (id: string) => `${publicBaseUrl() ?? ""}/api/shop/photo/${id}`;

export type FeedView = {
  on: boolean;
  storeCode: string | null;
  links: Record<FeedFile, string> | null;
  /** Why the feeds can't be used yet (no public address, no shop page address, the online shop off), or null. */
  problem: string | null;
  google: number;
  meta: number;
  /** Items listed online that aren't in a feed, and why ("No barcode"). */
  left: { id: string; partNumber: string; title: string; reason: string }[];
  /** Items with a barcode not listed online: one tap away from the feeds. */
  notListed: number;
};

/** The settings page: on or off, the links, how many items go in, and what's left out and why. */
export async function feedView(shopId: string): Promise<FeedView> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { feedToken: true, feedStoreCode: true, bookingSlug: true, shopOn: true, sellsRetail: true } });
  const parts = await feedParts(shopId);
  const base = shopUrl(shop.bookingSlug);
  const problem = !publicBaseUrl()
    ? "Feeds need the program's web address (the hosted program has one)."
    : !shop.bookingSlug
      ? "Give your online shop an address first (Settings, Online shop)."
      : !shop.shopOn
        ? "Switch your online shop on first: Google and Facebook send shoppers to its pages."
        : null;
  const links =
    shop.feedToken && base
      ? (Object.fromEntries(Object.entries(FEED_FILES).map(([k, f]) => [k, `${base}/feeds/${shop.feedToken}/${f}`])) as Record<FeedFile, string>)
      : null;
  let google = 0;
  let meta = 0;
  let notListed = 0;
  const left: FeedView["left"] = [];
  for (const p of parts) {
    const g = leftOutReason(p);
    if (!g) google += 1;
    if (!metaReason(p)) meta += 1;
    const why = g ?? metaReason(p);
    if (p.online && why) left.push({ id: p.id, partNumber: p.partNumber, title: p.onlineTitle?.trim() || p.description, reason: why });
    if (!p.online && g === "Not listed in your online shop") notListed += 1;
  }
  return { on: !!shop.feedToken, storeCode: shop.feedStoreCode, links, problem, google, meta, left: left.slice(0, 200), notListed };
}

function ownerOnly(user: CurrentUser) {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change the Google and Facebook feeds.");
}

/** Turns the feeds on (a new secret in the links) or keeps them on with the store code typed. */
export async function turnFeedsOnFor(user: CurrentUser, storeCode: string | null): Promise<void> {
  ownerOnly(user);
  const code = (storeCode ?? "").trim().slice(0, 60) || null;
  if (code && !/^[\w .\-/#]+$/.test(code)) throw new UserError("A store code is letters, digits and dashes, as Google shows it in your Business Profile.");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { feedToken: true } });
  await db.shop.update({ where: { id: user.shopId }, data: { feedToken: shop.feedToken ?? crypto.randomBytes(24).toString("base64url"), feedStoreCode: code } });
  await audit(db, actorOf(user), { action: "feeds.settings", subjectType: "Shop", subjectId: user.shopId, subjectLabel: shop.feedToken ? "Feeds: store code saved" : "Feeds switched on" });
}

/** Switches the feeds off: the links stop working at once (Google and Meta then drop the items). */
export async function turnFeedsOffFor(user: CurrentUser): Promise<void> {
  ownerOnly(user);
  await db.shop.update({ where: { id: user.shopId }, data: { feedToken: null } });
  await audit(db, actorOf(user), { action: "feeds.settings", subjectType: "Shop", subjectId: user.shopId, subjectLabel: "Feeds switched off" });
}

/** "New links": the old ones stop working (a link was shared by mistake). */
export async function newFeedLinksFor(user: CurrentUser): Promise<void> {
  ownerOnly(user);
  const r = await db.shop.updateMany({ where: { id: user.shopId, feedToken: { not: null } }, data: { feedToken: crypto.randomBytes(24).toString("base64url") } });
  if (!r.count) throw new UserError("The feeds are off.");
  await audit(db, actorOf(user), { action: "feeds.settings", subjectType: "Shop", subjectId: user.shopId, subjectLabel: "Feed links replaced" });
}

/**
 * A feed file for Google or Meta (public, by the shop's address and the secret in the link): null when the address,
 * the secret or the file is wrong, or the online shop isn't open (paused while the program is read-only).
 */
export async function feedFile(slug: string, token: string, file: string): Promise<{ body: string; type: string } | null> {
  if (!TOKEN_RE.test(token)) return null;
  const kind = (Object.entries(FEED_FILES).find(([, f]) => f === file)?.[0] ?? null) as FeedFile | null;
  if (!kind) return null;
  const store = await publicStore(slug);
  if (!store || !store.open) return null;
  const shop = await db.shop.findUnique({ where: { id: store.id }, select: { feedToken: true, feedStoreCode: true } });
  if (!shop?.feedToken || shop.feedToken.length !== token.length || !crypto.timingSafeEqual(Buffer.from(shop.feedToken), Buffer.from(token))) return null;
  const url = shopUrl(store.slug)!;
  const all = await feedParts(store.id);
  // More than one store (7.2): the product feeds count the online shop's store's shelf; the local inventory feed lists
  // every open store's own shelf under its own Business Profile store code.
  const parts = await withStoreQty(store.id, all, await onlineStore(store.id));
  const pick = (why: (p: FeedPart) => string | null, from: FeedPart[] = parts): FeedRow[] => from.filter((p) => !why(p)).map((p) => feedRow(p, { shopUrl: url, photoUrl }));
  if (kind === "google") return { body: googleProductXml({ name: store.name, url }, pick(leftOutReason)), type: "application/xml; charset=utf-8" };
  if (kind === "local") {
    const stores = await activeStores(store.id);
    if (stores.length <= 1) return { body: googleLocalTsv(shop.feedStoreCode ?? store.slug, pick(leftOutReason)), type: "text/tab-separated-values; charset=utf-8" };
    const codes = new Map((await db.location.findMany({ where: { shopId: store.id }, select: { id: true, feedStoreCode: true } })).map((l) => [l.id, l.feedStoreCode]));
    const files = await Promise.all(stores.map(async (s, i) => googleLocalTsv(s.main ? (shop.feedStoreCode ?? store.slug) : (codes.get(s.id) ?? `${store.slug}-${i + 1}`), pick(leftOutReason, await withStoreQty(store.id, all, s)))));
    // One header, then every store's rows.
    const lines = (f: string) => f.split("\n");
    return { body: [lines(files[0])[0], ...files.flatMap((f) => lines(f).slice(1).filter(Boolean))].join("\n") + "\n", type: "text/tab-separated-values; charset=utf-8" };
  }
  return { body: metaCsv(pick(metaReason)), type: "text/csv; charset=utf-8" };
}
