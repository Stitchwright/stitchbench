"use server";

// The community marketplace on the hub: shops list parts and accessories; another shop orders; the buyer pays the
// seller directly (the seller's payment instructions are on the invoice); the seller adds carrier and tracking.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { hubFetch, hubId, hubReachable, saveListing, saveOrder, syncHub, syncSoon, type HubListing, type HubOrder } from "@/lib/hub";
import { listingFromForm, listingPhotos, offerPartAs, postListing, strictCents, withdrawOfferAs } from "@/lib/offer";
import { numberKey, orderStockNote, partKeys, partNumberClash, stockFor, takeShopNumber } from "@/lib/parts";
import { CONDITIONS as PART_CONDITIONS, ORIGINS as PART_ORIGINS } from "@/lib/part-labels";
import { assertId } from "@/lib/input";
import type { PartCondition, PartOrigin } from "@/generated/prisma/enums";

const CONDITIONS: string[] = PART_CONDITIONS;
const ORIGINS: string[] = PART_ORIGINS;

function refresh() {
  revalidatePath("/market", "layout");
}

/** A whole number from `min` up (1.5 is not 2: it is refused, the seller is asked). */
function int(v: FormDataEntryValue | null, min: number) {
  const n = Number(str(v) ?? "NaN");
  return Number.isInteger(n) && n >= min && n <= 1_000_000 ? n : null;
}

// ---------- listings ----------

/** A listing from the marketplace's own form (Marketplace → Sell). From a part's page, offerPart below does it. */
export const createListing = safe(async function createListing(formData: FormData) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { id: true, name: true } });
  const listing = await listingFromForm(formData, shop);
  const l = await postListing(user.shopId, listing, listingPhotos(formData));
  refresh();
  redirect(`/market/${l.id}`);
});

// ---------- offering a part (HANDOFF item 9: chosen per item, never automatic) ----------

/**
 * "Offer this part" from the part's page: the form says where, partner shops (the partner price), the marketplace (a
 * listing), or both. Nothing goes to the hub unless the marketplace is ticked; the part page then says where it is offered.
 */
export const offerPart = safe(async function offerPart(partId: string, formData: FormData) {
  assertId(partId);
  const user = await requireUser();
  const r = await offerPartAs(user, partId, formData);
  revalidatePath(`/parts/${partId}`);
  if (r.listingId) refresh();
  return r;
});

/** Takes one offer back: from partner shops (the next partner sync carries the catalog without it) or a listing off the marketplace. */
export const withdrawOffer = safe(async function withdrawOffer(partId: string, where: "partners" | "market", listingId: string | null) {
  assertId(partId);
  const user = await requireUser();
  await withdrawOfferAs(user, partId, where, listingId);
  revalidatePath(`/parts/${partId}`);
  if (where === "market") refresh();
});

/** A listing this company made (other companies on the same install can't change it). */
async function ownListing(shopId: string, id: string) {
  const l = await db.listing.findUnique({ where: { id }, select: { shopId: true, mine: true } });
  if (!l || !l.mine || l.shopId !== shopId) throw new UserError("That listing isn't one of yours.");
}

/** An order this company is the buyer or the seller on. */
async function ownOrder(shopId: string, id: string) {
  const o = await db.marketOrder.findUnique({ where: { id }, select: { shopId: true } });
  if (!o || o.shopId !== shopId) throw new UserError("That order isn't one of yours.");
}

export const updateListing = safe(async function updateListing(id: string, formData: FormData) {
  const user = await requireUser();
  await ownListing(user.shopId, id);
  const body: Record<string, unknown> = {};
  // What's typed is checked like a new listing: a typo is an error, never skipped or saved as "no price".
  if (str(formData.get("price")) != null) {
    const price = strictCents(formData.get("price"), "Price");
    if (price == null || price <= 0) throw new UserError("Enter the price in dollars, e.g. 12.50.");
    body.priceCents = price;
  }
  if (str(formData.get("qty")) != null) {
    const qty = int(formData.get("qty"), 0);
    if (qty == null) throw new UserError("Enter how many are available: a whole number, 0 or more.");
    // Sent only when the seller changed it, with the number they saw: orders accepted or cancelled since the page
    // opened change it on the hub, and the hub refuses a number typed over theirs.
    const was = int(formData.get("qtyWas"), 0);
    if (was == null || qty !== was) {
      body.qty = qty;
      if (was != null) body.expectedQty = was;
    }
  }
  if (formData.has("shipping")) {
    const shipping = str(formData.get("shipping"));
    const cents = shipping == null ? null : strictCents(shipping, "Shipping");
    if (shipping != null && (cents == null || cents < 0)) throw new UserError("Enter shipping in dollars, e.g. 4.50, or leave it blank to quote it on the invoice.");
    body.shippingCents = cents;
  }
  for (const k of ["title", "description", "shippingNote", "shipsFrom"]) if (formData.has(k)) body[k] = str(formData.get(k));
  const condition = str(formData.get("condition"));
  if (condition && CONDITIONS.includes(condition)) body.condition = condition;
  const status = str(formData.get("status"));
  if (status === "ACTIVE" || status === "PAUSED") body.status = status;
  const l = (await (await hubFetch(`/v1/listings/${hubId(id)}`, { method: "PUT", json: body })).json()) as HubListing;
  await saveListing(l);
  refresh();
});

export const removeListing = safe(async function removeListing(id: string) {
  const user = await requireUser();
  await ownListing(user.shopId, id);
  await hubFetch(`/v1/listings/${hubId(id)}`, { method: "DELETE" });
  await db.listing.deleteMany({ where: { id } });
  refresh();
  redirect("/market/mine");
});

// ---------- orders ----------

export const placeOrder = safe(async function placeOrder(listingId: string, formData: FormData) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId } });
  const qty = int(formData.get("qty"), 1);
  if (qty == null) throw new UserError("Enter how many you want, as a whole number.");
  const shipTo = str(formData.get("shipTo")) ?? shop.address;
  if (!shipTo) throw new UserError("Enter the address to ship to.");
  const o = (await (
    await hubFetch("/v1/orders", {
      method: "POST",
      json: {
        listingId,
        qty,
        shipTo,
        buyerNote: str(formData.get("note")),
        buyerContact: { name: `${user.name}, ${shop.name}`, email: shop.email ?? user.email, phone: shop.phone },
        // Ordered by this company, under its own name; the form's id makes a retry after a lost answer the same order.
        shopRef: shop.id,
        shopName: shop.name,
        clientId: str(formData.get("clientId")),
      },
    })
  ).json()) as HubOrder;
  await saveOrder(o, user.shopId);
  refresh();
  redirect(`/market/orders/${o.id}`);
});

/** Has this order already gone into (or out of) this company's parts stock? */
const inStock = async (shopId: string, o: HubOrder) => (await db.stockMove.count({ where: { shopId, note: orderStockNote(o) } })) > 0;

async function receiveIntoStock(o: HubOrder, userId: string, shopId: string) {
  if (await inStock(shopId, o)) return;
  const key = o.item.partNumber ? numberKey(o.item.partNumber) : null;
  const note = orderStockNote(o);
  const unitCost = o.qty ? Math.round(o.totalCents / o.qty) : null;
  // What was bought, as the seller listed it. A listing that says nothing about who made it counts as genuine.
  const condition = (CONDITIONS.includes(o.item.condition) ? o.item.condition : "NEW") as PartCondition;
  const origin = (ORIGINS.includes(o.item.origin ?? "") ? o.item.origin : "GENUINE") as PartOrigin;
  // This shop's own stock of it in the same condition (never a partner's consigned item): the exact number,
  // "<number> (own)", "<number> (used)", then any number it's sold under.
  const stock = o.item.partNumber ? await stockFor(db, shopId, o.item.partNumber, condition) : null;
  const part = stock?.existing ?? (key && key.length >= 3 ? await db.part.findFirst({ where: { shopId, consignLinkId: null, condition, numberKeys: { has: key } } }) : null);
  if (part) {
    await db.$transaction([
      db.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: o.qty }, ...(unitCost ? { costCents: unitCost } : {}) } }),
      db.stockMove.create({ data: { shopId, partId: part.id, qty: o.qty, reason: "RECEIVED", userId, note } }),
    ]);
  } else {
    const item = {
      shopId,
      description: o.item.title,
      brand: o.item.brand,
      condition,
      origin,
      qtyOnHand: o.qty,
      costCents: unitCost,
      supplier: o.sellerShop,
      moves: { create: { shopId, qty: o.qty, reason: "RECEIVED" as const, userId, note } },
    };
    if (stock) {
      // The number may be a partner's consigned item here, or this shop's own stock in another condition: this
      // stock gets its own entry.
      // Someone adding the same number (in any case) at the same moment hits the case-insensitive index: say so.
      await db.part.create({ data: { ...item, partNumber: stock.partNumber, altNumbers: stock.altNumbers, numberKeys: partKeys(stock.partNumber, stock.altNumbers) } }).catch(async (e) => {
        throw await partNumberClash(e, shopId, stock.partNumber);
      });
    } else {
      // The listing has no maker's number: the item gets a shop number.
      await db.$transaction(async (tx) => {
        const partNumber = await takeShopNumber(tx, shopId);
        await tx.part.create({ data: { ...item, partNumber, ownNumber: true, numberKeys: partKeys(partNumber, []) } });
      });
    }
  }
}

/** True when it took the units out of a part; false when no part here has the number (or it was done already). */
async function takeFromStock(o: HubOrder, userId: string, shopId: string) {
  if (await inStock(shopId, o)) return false;
  const key = o.item.partNumber ? numberKey(o.item.partNumber) : null;
  // The stock item of that number in the condition it was listed in (a used one sold doesn't come off the new one's count).
  const condition = (CONDITIONS.includes(o.item.condition) ? o.item.condition : "NEW") as PartCondition;
  const part =
    (o.item.partNumber ? (await stockFor(db, shopId, o.item.partNumber, condition)).existing : null) ??
    (key && key.length >= 3 ? await db.part.findFirst({ where: { shopId, consignLinkId: null, condition, numberKeys: { has: key } } }) : null);
  if (!part) return false;
  await db.$transaction([
    db.part.update({ where: { id: part.id }, data: { qtyOnHand: { decrement: o.qty } } }),
    db.stockMove.create({ data: { shopId, partId: part.id, qty: -o.qty, reason: "ADJUSTED", userId, note: orderStockNote(o) } }),
  ]);
  return true;
}

const ACTIONS = ["accept", "decline", "buyer-paid", "paid", "ship", "received", "cancel", "message", "rate"] as const;
type OrderAction = (typeof ACTIONS)[number];

export const orderAction = safe.whileLapsed("orderAction")(async function orderAction(orderId: string, action: OrderAction, formData: FormData) {
  const user = await requireUser();
  if (!ACTIONS.includes(action)) throw new UserError("Unknown order step.");
  await ownOrder(user.shopId, orderId);
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId } });
  let body: Record<string, unknown> = {};
  // Instructions typed on a first accept become the shop's saved ones, but only once the hub has taken the step.
  let keepPay: string | null = null;
  switch (action) {
    case "accept": {
      // Where the buyer's money goes is the owner's call (Settings → Shop, owner or admin only): a tech accepting an
      // order sends the shop's saved instructions, never ones typed into the form.
      if (user.role === "TECH" && !shop.payInstructions) {
        throw new UserError("The shop hasn't said how buyers pay it yet. Ask the owner to add payment instructions in Settings → Shop.");
      }
      const pay = user.role === "TECH" ? shop.payInstructions : (str(formData.get("payInstructions")) ?? shop.payInstructions);
      if (!pay) throw new UserError("Say how the buyer should pay you (PayPal, Zelle, check to...). You can save it in Settings → Shop.");
      if (!shop.payInstructions) keepPay = pay;
      body = {
        shippingCents: formData.has("shipping") ? strictCents(formData.get("shipping"), "Shipping") : undefined,
        payInstructions: pay,
        sellerContact: { name: shop.name, address: shop.address, email: shop.email ?? user.email, phone: shop.phone },
      };
      break;
    }
    case "decline":
    case "cancel":
      body = { reason: str(formData.get("reason")) };
      break;
    case "buyer-paid":
      body = { note: str(formData.get("note")) ?? "Payment sent" };
      break;
    case "ship": {
      const carrier = str(formData.get("carrier"));
      const tracking = str(formData.get("tracking"));
      if (!carrier) throw new UserError("Pick the carrier.");
      if (!tracking) throw new UserError("Enter the tracking number.");
      body = { carrier, tracking };
      break;
    }
    case "rate": {
      const stars = Math.round(Number(str(formData.get("stars")) ?? "0"));
      if (!(stars >= 1 && stars <= 5)) throw new UserError("Pick 1 to 5 stars.");
      body = { stars, comment: str(formData.get("comment")) };
      break;
    }
    case "message": {
      const text = str(formData.get("text"));
      if (!text) throw new UserError("Write a message first.");
      body = { text };
      break;
    }
  }
  // The step is this company's (shopRef in the body, as the hub's README asks for order steps): on an install that holds
  // several companies the hub refuses it when the order is another company's, and shows the company's name on it.
  const o = (await (await hubFetch(`/v1/orders/${hubId(orderId)}/${action}`, { method: "POST", json: { ...body, shopRef: shop.id } })).json()) as HubOrder;
  await saveOrder(o);
  // A refused step (hubFetch threw) leaves the shop's settings as they were.
  if (keepPay) await db.shop.updateMany({ where: { id: shop.id, payInstructions: null }, data: { payInstructions: keepPay } });
  // The hub has the step now and can't be asked to undo it, so a stock change that fails is told apart from it: the
  // order page offers the stock change again (orderStock).
  let stockFailed = false;
  try {
    if (action === "received" && formData.get("addToStock") === "on") await receiveIntoStock(o, user.id, user.shopId);
    if (action === "ship" && formData.get("takeFromStock") === "on") await takeFromStock(o, user.id, user.shopId);
  } catch (e) {
    console.error("marketplace order, parts stock:", e instanceof Error ? e.message : e);
    stockFailed = true;
  }
  // Listing quantities change on accept / cancel; pick them up now (a few seconds at most, the rest in the background).
  if (action === "accept" || action === "cancel") await syncSoon();
  refresh();
  revalidatePath("/parts", "layout");
  if (stockFailed) throw new UserError("The order is updated, but your parts stock couldn't be changed. Use the button on the order page to try again.");
});

/**
 * Put a received order into the parts stock, or take a shipped one out, when that didn't happen with the step itself
 * (the box wasn't ticked, or the stock change failed after the hub had the step). Never twice for one order.
 */
export const orderStock = safe(async function orderStock(orderId: string) {
  const user = await requireUser();
  await ownOrder(user.shopId, orderId);
  const row = await db.marketOrder.findUnique({ where: { id: orderId }, select: { data: true } });
  const o = row?.data as unknown as HubOrder | undefined;
  if (!o) throw new UserError("That order isn't one of yours.");
  if (await inStock(user.shopId, o)) throw new UserError("That's already in your parts stock.");
  if (o.role === "buyer" && o.status === "RECEIVED") await receiveIntoStock(o, user.id, user.shopId);
  else if (o.role === "seller" && (o.status === "SHIPPED" || o.status === "RECEIVED")) {
    if (!(await takeFromStock(o, user.id, user.shopId))) throw new UserError(`No part in your stock has the number ${o.item.partNumber ?? "of this listing"}.`);
  } else throw new UserError("There is nothing to change in your parts stock for this order yet.");
  refresh();
  revalidatePath("/parts", "layout");
});

export const refreshOrders = safe.whileLapsed("refreshOrders")(async function refreshOrders() {
  await requireUser();
  // A dead line says so in seconds, not after every request of a sync has waited out its time.
  await hubReachable();
  await syncHub();
  refresh();
});
