"use server";

// The community marketplace on the hub: shops list parts and accessories; another shop orders; the buyer pays the
// seller directly (the seller's payment instructions are on the invoice); the seller adds carrier and tracking.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str, toCents } from "@/lib/format";
import { hubFetch, hubId, hubReachable, saveListing, saveOrder, syncHub, syncSoon, type HubListing, type HubOrder } from "@/lib/hub";
import { numberKey } from "@/lib/parts";

const CONDITIONS = ["NEW", "USED", "REFURB"];
const KINDS = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"];
const IMAGE = ["image/jpeg", "image/png", "image/webp"];

function refresh() {
  revalidatePath("/market", "layout");
}

function int(v: FormDataEntryValue | null, min: number) {
  const n = Math.round(Number(str(v) ?? "NaN"));
  return Number.isFinite(n) && n >= min ? n : null;
}

// ---------- listings ----------

export const createListing = safe(async function createListing(formData: FormData) {
  const user = await requireUser();
  const title = str(formData.get("title"));
  const priceCents = toCents(formData.get("price"));
  const qty = int(formData.get("qty"), 1);
  if (!title) throw new UserError("Give the listing a title, e.g. \"Brother PR bobbin case, new\".");
  if (priceCents == null || priceCents <= 0) throw new UserError("Enter the price each.");
  if (qty == null) throw new UserError("Enter how many you have to sell.");
  const kind = str(formData.get("kind")) ?? "PART";
  const condition = str(formData.get("condition")) ?? "NEW";
  const partNumber = str(formData.get("partNumber"));
  const xpart = partNumber ? await db.xPart.findFirst({ where: { numberKeys: { has: numberKey(partNumber) } }, select: { id: true } }) : null;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId } });
  const listing = {
    title,
    description: str(formData.get("description")),
    kind: KINDS.includes(kind) ? kind : "PART",
    condition: CONDITIONS.includes(condition) ? condition : "NEW",
    brand: str(formData.get("brand")),
    partNumber,
    xpartId: xpart?.id ?? null,
    fits: str(formData.get("fits")),
    priceCents,
    currency: "USD",
    qty,
    shippingCents: toCents(formData.get("shipping")),
    shippingNote: str(formData.get("shippingNote")),
    // Only what the seller typed: never the shop's street address, which every hub member would see.
    shipsFrom: str(formData.get("shipsFrom")),
    // Listed by this company, under its own name (several companies can share one StitchBench).
    shopRef: shop.id,
    shopName: shop.name,
    // The form's own id: sent again after a lost answer, it's the same listing on the hub, not a second one.
    clientId: str(formData.get("clientId")),
  };
  const photos = formData.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0).slice(0, 8);
  for (const f of photos) {
    if (!IMAGE.includes(f.type)) throw new UserError("Photos must be JPEG, PNG or WebP.");
    if (f.size > 3 * 1024 * 1024) throw new UserError("Each photo must be under 3 MB.");
  }
  const fd = new FormData();
  fd.set("listing", JSON.stringify(listing));
  for (const f of photos) fd.append("photo", f, f.name || "photo.jpg");
  const l = (await (await hubFetch("/v1/listings", { method: "POST", body: fd })).json()) as HubListing;
  await saveListing(l);
  await db.listing.update({ where: { id: l.id }, data: { shopId: user.shopId } });
  refresh();
  redirect(`/market/${l.id}`);
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
    const price = toCents(formData.get("price"));
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
    const cents = shipping == null ? null : toCents(shipping);
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
  if (qty == null) throw new UserError("Enter how many you want.");
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

async function receiveIntoStock(o: HubOrder, userId: string, shopId: string) {
  const key = o.item.partNumber ? numberKey(o.item.partNumber) : null;
  const note = `Marketplace order ${o.number} from ${o.sellerShop}`;
  const unitCost = o.qty ? Math.round(o.totalCents / o.qty) : null;
  // This shop's own stock of it (never a partner's consigned item): the exact number, then any number it's sold under.
  const partNumber = o.item.partNumber ?? o.number;
  const part =
    (await db.part.findFirst({ where: { shopId, consignLinkId: null, partNumber: { equals: partNumber, mode: "insensitive" } } })) ??
    (key && key.length >= 3 ? await db.part.findFirst({ where: { shopId, consignLinkId: null, numberKeys: { has: key } } }) : null);
  if (part) {
    await db.$transaction([
      db.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: o.qty }, ...(unitCost ? { costCents: unitCost } : {}) } }),
      db.stockMove.create({ data: { shopId, partId: part.id, qty: o.qty, reason: "RECEIVED", userId, note } }),
    ]);
  } else {
    // The number may be a partner's consigned item here: this shop's own stock gets its own entry.
    const taken = await db.part.findFirst({ where: { shopId, partNumber } });
    await db.part.create({
      data: {
        shopId,
        partNumber: taken ? `${partNumber} (own)` : partNumber,
        altNumbers: taken ? [partNumber] : [],
        numberKeys: [numberKey(partNumber)].filter((k) => k.length >= 3),
        description: o.item.title,
        brand: o.item.brand,
        qtyOnHand: o.qty,
        costCents: unitCost,
        supplier: o.sellerShop,
        moves: { create: { shopId, qty: o.qty, reason: "RECEIVED", userId, note } },
      },
    });
  }
}

async function takeFromStock(o: HubOrder, userId: string, shopId: string) {
  const key = o.item.partNumber ? numberKey(o.item.partNumber) : null;
  const part =
    (o.item.partNumber ? await db.part.findFirst({ where: { shopId, consignLinkId: null, partNumber: { equals: o.item.partNumber, mode: "insensitive" } } }) : null) ??
    (key && key.length >= 3 ? await db.part.findFirst({ where: { shopId, consignLinkId: null, numberKeys: { has: key } } }) : null);
  if (!part) return;
  await db.$transaction([
    db.part.update({ where: { id: part.id }, data: { qtyOnHand: { decrement: o.qty } } }),
    db.stockMove.create({ data: { shopId, partId: part.id, qty: -o.qty, reason: "ADJUSTED", userId, note: `Sold on the marketplace, order ${o.number} to ${o.buyerShop}` } }),
  ]);
}

const ACTIONS = ["accept", "decline", "buyer-paid", "paid", "ship", "received", "cancel", "message", "rate"] as const;
type OrderAction = (typeof ACTIONS)[number];

export const orderAction = safe(async function orderAction(orderId: string, action: OrderAction, formData: FormData) {
  const user = await requireUser();
  if (!ACTIONS.includes(action)) throw new UserError("Unknown order step.");
  await ownOrder(user.shopId, orderId);
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId } });
  let body: Record<string, unknown> = {};
  switch (action) {
    case "accept": {
      // Where the buyer's money goes is the owner's call (Settings → Shop, owner or admin only): a tech accepting an
      // order sends the shop's saved instructions, never ones typed into the form.
      if (user.role === "TECH" && !shop.payInstructions) {
        throw new UserError("The shop hasn't said how buyers pay it yet. Ask the owner to add payment instructions in Settings → Shop.");
      }
      const pay = user.role === "TECH" ? shop.payInstructions : (str(formData.get("payInstructions")) ?? shop.payInstructions);
      if (!pay) throw new UserError("Say how the buyer should pay you (PayPal, Zelle, check to...). You can save it in Settings → Shop.");
      if (!shop.payInstructions) await db.shop.update({ where: { id: shop.id }, data: { payInstructions: pay } });
      body = {
        shippingCents: formData.has("shipping") ? toCents(formData.get("shipping")) : undefined,
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
  const o = (await (await hubFetch(`/v1/orders/${hubId(orderId)}/${action}`, { method: "POST", json: body })).json()) as HubOrder;
  await saveOrder(o);
  if (action === "received" && formData.get("addToStock") === "on") await receiveIntoStock(o, user.id, user.shopId);
  if (action === "ship" && formData.get("takeFromStock") === "on") await takeFromStock(o, user.id, user.shopId);
  // Listing quantities change on accept / cancel; pick them up now (a few seconds at most, the rest in the background).
  if (action === "accept" || action === "cancel") await syncSoon();
  refresh();
  revalidatePath("/parts", "layout");
});

export const refreshOrders = safe(async function refreshOrders() {
  await requireUser();
  // A dead line says so in seconds, not after every request of a sync has waited out its time.
  await hubReachable();
  await syncHub();
  refresh();
});
