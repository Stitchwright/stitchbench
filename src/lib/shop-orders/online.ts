import "server-only";
// Settings for taking orders from MakerFoundry (docs/plans/makerfoundry-orders-plan.md package 2): the opt-in, the garments and
// decorations the shop offers with their prices, and publishing them as the catalogue. Owner or admin only. A customer is charged only
// prices from a catalogue the shop published, so every change to the list publishes the new one (while the shop takes orders).
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { str, toCents } from "@/lib/format";
import { assertId } from "@/lib/input";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireModule } from "@/lib/modules";
import { hubJoined, hubStatus } from "@/lib/hub";
import { isDemo } from "@/lib/demo-mode";
import { buildCatalog, isMethod, parsePriceBreaks, type PickupAddress } from "@/lib/shop-orders/catalog";
import { enqueue } from "@/lib/shop-orders/outbox";
import { v2 } from "@/lib/shop-orders/hubv2";
import { ordersSyncRow, syncShop } from "@/lib/shop-orders/sync";
import { isPlatformAdmin } from "@/lib/shops";
import { Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/lib/session";

async function gate(user: CurrentUser) {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change what the shop sells through MakerFoundry.");
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
}

const text = (v: FormDataEntryValue | null, max: number) => (str(v) ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Everything the settings page shows. */
export async function onlineView(shopId: string) {
  const row = await ordersSyncRow(shopId);
  const [products, offers, catalogOut, failedOut] = await Promise.all([
    db.onlineProduct.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } }),
    db.onlineOffer.findMany({ where: { shopId }, orderBy: [{ method: "asc" }, { createdAt: "asc" }] }),
    db.syncOut.findFirst({ where: { shopId, type: "catalog", deadAt: null }, orderBy: { createdAt: "desc" }, select: { sentAt: true, createdAt: true, error: true, expiredAt: true } }),
    db.syncOut.count({ where: { shopId, deadAt: { not: null } } }),
  ]);
  return { row, products, offers, catalogOut, failedOut, hub: await hubJoined(), account: await payoutAccountOf(shopId) };
}

/**
 * Which hub service this company takes orders from. Production is makerfoundry; a platform admin points a test shop at another
 * (makerfoundry-test). Only while the company is not taking orders and nothing is waiting to be sent: the hub keeps an opt-in
 * per service name, and queued messages go to the one named when they are sent.
 */
export async function setServiceFor(user: CurrentUser, service: string): Promise<string> {
  await gate(user);
  if (!isPlatformAdmin(user.email)) throw new UserError("Only the platform admin changes the order service.");
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(service)) throw new UserError("Service name: lower-case letters, digits and -, for example makerfoundry-test.");
  const row = await ordersSyncRow(user.shopId);
  if (row.service === service) return "Unchanged.";
  if (row.optedIn) throw new UserError("Stop taking new orders first: the hub keeps the opt-in under the old service name.");
  // An open order's replies (proofs, status, cancels) go to the service the order came from: while one is open the name stays.
  if (await db.decorOrder.count({ where: { shopId: user.shopId, source: "MAKERFOUNDRY", closedAt: null } })) throw new UserError("This company still has open orders from MakerFoundry: their replies go to the old service. Finish or close them first.");
  if (await db.syncOut.count({ where: { shopId: user.shopId, sentAt: null, deadAt: null, expiredAt: null } })) throw new UserError("Messages are still waiting to be sent to the old service. Let them go first.");
  await db.shopOrdersSync.update({ where: { shopId: user.shopId }, data: { service, catalogPublishedAt: null } });
  return `Orders now come through ${service}. Take orders again to publish the catalogue to it.`;
}

/** The Foundry Account the shop is paid through: the one the company's owner login is linked to (the oldest active owner login that is linked), or null. */
export async function payoutAccountOf(shopId: string): Promise<number | null> {
  const owner = await db.user.findFirst({ where: { shopId, role: "OWNER", active: true, foundryId: { not: null } }, orderBy: { createdAt: "asc" }, select: { foundryId: true } });
  return owner?.foundryId ?? null;
}

/** Publishes the catalogue built from the shop's list: the earlier one that has not gone yet is replaced (only the latest matters). */
export async function publishCatalogFor(shopId: string): Promise<string> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true } });
  const row = await ordersSyncRow(shopId);
  const [products, offers] = await Promise.all([db.onlineProduct.findMany({ where: { shopId } }), db.onlineOffer.findMany({ where: { shopId } })]);
  const built = buildCatalog({
    shopName: shop.name,
    ships: row.shipsOrders,
    shippingCents: row.shippingCents,
    perExtraPieceCents: row.perExtraPieceCents,
    freeOverCents: row.freeOverCents,
    pickup: row.offersPickup,
    pickupAddress: (row.pickupAddress as PickupAddress | null) ?? null,
    account: await payoutAccountOf(shopId),
    products: products.map((p) => ({ sku: p.sku, name: p.name, kind: p.kind, colours: p.colours, sizes: p.sizes, blankCents: p.blankCents })),
    offers: offers.map((o) => ({ method: o.method, placement: o.placement, breaks: o.breaks as { min: number; cents: number }[], setupCents: o.setupCents })),
  });
  if (!built.ok) throw new UserError(built.why);
  await db.$transaction(async (tx) => {
    await tx.syncOut.updateMany({ where: { shopId, type: "catalog", sentAt: null, deadAt: null }, data: { deadAt: new Date(), error: "Replaced by a newer catalogue." } });
    await enqueue(tx, shopId, { conversation: "catalog", type: "catalog", body: built.body });
    await tx.shopOrdersSync.update({ where: { shopId }, data: { catalogPublishedAt: new Date() } });
  });
  // Send it now when the hub is there; if not, the outbox keeps it and sends it when the connection is back.
  if (!isDemo()) await syncShop(shopId).catch(() => {});
  return `Published: ${built.body.products.length} ${built.body.products.length === 1 ? "garment" : "garments"} for customers to order.`;
}

/** After an edit: the new list goes out at once while the shop takes orders; the answer says so (or why not). */
async function afterEdit(shopId: string, said: string): Promise<string> {
  const row = await ordersSyncRow(shopId);
  if (!row.optedIn) return `${said} It goes out when you turn on orders from MakerFoundry.`;
  try {
    return `${said} ${await publishCatalogFor(shopId)}`;
  } catch (e) {
    // The list no longer makes a catalogue (the last garment was removed): the one customers see stays until a new one is published.
    if (e instanceof UserError) return `${said} Not published: ${e.message} Customers still see the earlier catalogue.`;
    throw e;
  }
}

export async function setOnlineOrdersFor(user: CurrentUser, fd: FormData): Promise<string> {
  await gate(user);
  const shopId = user.shopId;
  const on = String(fd.get("on") ?? "") === "on";
  const maxOpen = Number(str(fd.get("maxOpen")) ?? "200");
  if (!Number.isInteger(maxOpen) || maxOpen < 1 || maxOpen > 10_000) throw new UserError("Most open orders at once: a whole number from 1 to 10,000.");
  if (on) {
    if (!isDemo() && !(await hubJoined())) throw new UserError("Join the community hub first (Settings → StitchHub): orders come through it.");
    // Prove there is something to sell before telling the hub: an opt-in with no catalogue would take orders nobody can place.
    const row = await ordersSyncRow(shopId);
    const [products, offers] = await Promise.all([db.onlineProduct.count({ where: { shopId } }), db.onlineOffer.count({ where: { shopId } })]);
    if (!products || !offers) throw new UserError("Add at least one garment and one decoration with prices first, so customers have something to order.");
    // MakerFoundry pays the shop through the owner's linked Foundry Account, and does not offer a shop without one (a demo has none).
    if (!isDemo() && (await payoutAccountOf(shopId)) === null) throw new UserError("Link the owner's login to a Foundry Account first (Settings → Account): MakerFoundry pays the shop through it, and doesn't offer a shop without one.");
    if (row.offersPickup && !row.pickupAddress) throw new UserError("Add the shop's pick-up address under Shipping and pick-up first (or switch pick-up off): sales tax on a pick-up order is worked out from it.");
  }
  try {
    if (!isDemo()) await v2(shopId, "/v2/optin", { method: "PUT", json: { service: (await ordersSyncRow(shopId)).service, enabled: on, maxOpen } });
  } catch (e) {
    if (hubStatus(e) === 404) throw new UserError("This hub doesn't take MakerFoundry orders yet. Ask whoever runs it.");
    if (hubStatus(e) === 426) throw new UserError("StitchHub needs a newer StitchShop before it can take orders. Please update the program.");
    throw e;
  }
  await db.shopOrdersSync.update({ where: { shopId }, data: { optedIn: on, maxOpen } });
  if (!on) return "No new orders from MakerFoundry. Orders you already have carry on.";
  return `You take orders from MakerFoundry. ${await publishCatalogFor(shopId)}`;
}

/** Dollars from a form field, 0 when empty. */
function dollars(fd: FormData, name: string, what: string): number {
  const cents = toCents(str(fd.get(name)) ?? "0");
  if (cents == null || cents < 0 || cents > 100_000) throw new UserError(`${what}: dollars, like 8.99 (0 for none).`);
  return cents;
}

/**
 * Shipping by the piece (the price for one piece, so much more for each piece after the first, free when goods and set-up reach an amount) and
 * pick-up. Switching pick-up on asks for the pick-up address: MakerFoundry works the sales tax on a pick-up order out from it, and without it
 * offers only shipping. Sales tax is MakerFoundry's, never the shop's.
 */
export async function saveShippingFor(user: CurrentUser, fd: FormData): Promise<string> {
  await gate(user);
  const ships = String(fd.get("ships") ?? "") === "on";
  const pickup = String(fd.get("pickup") ?? "") === "on";
  if (!ships && !pickup) throw new UserError("Turn on shipping or pick-up, so customers have a way to get their order.");
  const flat = ships ? dollars(fd, "shipping", "Shipping for one piece") : 0;
  const extra = ships ? dollars(fd, "perExtra", "Shipping for each extra piece") : 0;
  const freeOver = ships ? dollars(fd, "freeOver", "Free shipping from") : 0;
  let address: PickupAddress | null = null;
  if (pickup) {
    const line1 = text(fd.get("pa_line1"), 120);
    const city = text(fd.get("pa_city"), 80);
    const postcode = text(fd.get("pa_postcode"), 20);
    const country = text(fd.get("pa_country"), 2).toUpperCase() || "US";
    if (!line1 || !city || !postcode) throw new UserError("Pick-up needs the shop's address (street, town and zip): sales tax on a pick-up order is worked out from it.");
    if (!/^[A-Z]{2}$/.test(country)) throw new UserError("Country: two letters, like US.");
    address = { line1, ...(text(fd.get("pa_line2"), 120) ? { line2: text(fd.get("pa_line2"), 120) } : {}), city, ...(text(fd.get("pa_region"), 40) ? { region: text(fd.get("pa_region"), 40) } : {}), postcode, country };
  }
  await ordersSyncRow(user.shopId);
  await db.shopOrdersSync.update({
    where: { shopId: user.shopId },
    data: { shipsOrders: ships, shippingCents: flat, perExtraPieceCents: extra, freeOverCents: freeOver, offersPickup: pickup, pickupAddress: address ? (address as Prisma.InputJsonValue) : Prisma.DbNull },
  });
  return afterEdit(user.shopId, `${ships ? "Shipping" : "No shipping"}${pickup ? " and pick-up" : ""} saved.`);
}

export async function saveProductFor(user: CurrentUser, fd: FormData): Promise<string> {
  await gate(user);
  const sku = text(fd.get("sku"), 60);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(sku)) throw new UserError("Code: letters, numbers, dots and dashes, like TEE-01.");
  const name = text(fd.get("name"), 120);
  if (!name) throw new UserError("Say what the garment is, like Cotton tee.");
  const colours = text(fd.get("colours"), 600);
  const sizes = text(fd.get("sizes"), 200);
  if (!colours || !sizes) throw new UserError("List the colours and the sizes you can supply, separated by commas.");
  const blank = toCents(str(fd.get("blank")) ?? "");
  if (blank == null || blank < 0 || blank > 100_000) throw new UserError("What the garment costs a customer before decoration: dollars, like 9.00.");
  await ordersSyncRow(user.shopId);
  const data = { name, kind: text(fd.get("kind"), 30) || "shirt", colours, sizes, blankCents: blank };
  await db.onlineProduct.upsert({ where: { shopId_sku: { shopId: user.shopId, sku } }, create: { shopId: user.shopId, sku, ...data }, update: data });
  return afterEdit(user.shopId, `${name} saved.`);
}

export async function removeProductFor(user: CurrentUser, id: string): Promise<string> {
  await gate(user);
  const r = await db.onlineProduct.deleteMany({ where: { id: assertId(id), shopId: user.shopId } });
  if (r.count !== 1) throw new UserError("That garment was not found in your list.");
  return afterEdit(user.shopId, "Removed.");
}

export async function saveOfferFor(user: CurrentUser, fd: FormData): Promise<string> {
  await gate(user);
  const method = String(fd.get("method") ?? "");
  if (!isMethod(method)) throw new UserError("Pick embroidery or screen print.");
  const placement = text(fd.get("placement"), 40);
  if (!placement) throw new UserError("Say where it goes, like Left chest.");
  const b = parsePriceBreaks(String(fd.get("breaks") ?? ""));
  if ("error" in b) throw new UserError(b.error);
  const setup = toCents(str(fd.get("setup")) ?? "0");
  if (setup == null || setup < 0 || setup > 100_000) throw new UserError("Set-up for an order: dollars, like 25 (0 for none).");
  const maxRaw = str(fd.get("maxStitches"));
  const maxStitches = maxRaw ? Number(maxRaw) : null;
  if (maxStitches != null && (!Number.isInteger(maxStitches) || maxStitches < 100 || maxStitches > 1_000_000)) throw new UserError("Biggest design: a whole number of stitches, like 8000 (empty for no limit).");
  await ordersSyncRow(user.shopId);
  const data = { breaks: b.breaks, setupCents: setup, maxStitches };
  await db.onlineOffer.upsert({ where: { shopId_method_placement: { shopId: user.shopId, method, placement } }, create: { shopId: user.shopId, method, placement, ...data }, update: data });
  return afterEdit(user.shopId, `${placement} saved.`);
}

export async function removeOfferFor(user: CurrentUser, id: string): Promise<string> {
  await gate(user);
  const r = await db.onlineOffer.deleteMany({ where: { id: assertId(id), shopId: user.shopId } });
  if (r.count !== 1) throw new UserError("That decoration was not found in your list.");
  return afterEdit(user.shopId, "Removed.");
}
