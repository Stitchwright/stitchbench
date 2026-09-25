"use server";

// The community marketplace on the hub: shops list parts and accessories; another shop orders; the buyer pays the
// seller directly (the seller's payment instructions are on the invoice); the seller adds carrier and tracking.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str, toCents } from "@/lib/format";
import { hubFetch, saveListing, saveOrder, syncHub, type HubListing, type HubOrder } from "@/lib/hub";
import { numberKey } from "@/lib/parts";

const CONDITIONS = ["NEW", "USED", "REFURB"];
const KINDS = ["PART", "ACCESSORY", "SUPPLY"];
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
    shipsFrom: str(formData.get("shipsFrom")) ?? shop.address?.split("\n").slice(-1)[0] ?? null,
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
  refresh();
  redirect(`/market/${l.id}`);
});

export const updateListing = safe(async function updateListing(id: string, formData: FormData) {
  await requireUser();
  const body: Record<string, unknown> = {};
  const price = toCents(formData.get("price"));
  if (price != null) body.priceCents = price;
  const qty = int(formData.get("qty"), 0);
  if (qty != null) body.qty = qty;
  if (formData.has("shipping")) body.shippingCents = toCents(formData.get("shipping"));
  for (const k of ["title", "description", "shippingNote", "shipsFrom"]) if (formData.has(k)) body[k] = str(formData.get(k));
  const condition = str(formData.get("condition"));
  if (condition && CONDITIONS.includes(condition)) body.condition = condition;
  const status = str(formData.get("status"));
  if (status === "ACTIVE" || status === "PAUSED") body.status = status;
  const l = (await (await hubFetch(`/v1/listings/${id}`, { method: "PUT", json: body })).json()) as HubListing;
  await saveListing(l);
  refresh();
});

export const removeListing = safe(async function removeListing(id: string) {
  await requireUser();
  await hubFetch(`/v1/listings/${id}`, { method: "DELETE" });
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
      },
    })
  ).json()) as HubOrder;
  await saveOrder(o);
  refresh();
  redirect(`/market/orders/${o.id}`);
});

async function receiveIntoStock(o: HubOrder, userId: string, shopId: string) {
  const key = o.item.partNumber ? numberKey(o.item.partNumber) : null;
  const note = `Marketplace order ${o.number} from ${o.sellerShop}`;
  const unitCost = o.qty ? Math.round(o.totalCents / o.qty) : null;
  const part = key ? await db.part.findFirst({ where: { shopId, numberKeys: { has: key } } }) : null;
  if (part) {
    await db.$transaction([
      db.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: o.qty }, ...(unitCost ? { costCents: unitCost } : {}) } }),
      db.stockMove.create({ data: { shopId, partId: part.id, qty: o.qty, reason: "RECEIVED", userId, note } }),
    ]);
  } else {
    const partNumber = o.item.partNumber ?? o.number;
    const exists = await db.part.findFirst({ where: { shopId, partNumber } });
    if (exists) return;
    await db.part.create({
      data: {
        shopId,
        partNumber,
        numberKeys: [numberKey(partNumber)],
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
  const part = key ? await db.part.findFirst({ where: { shopId, numberKeys: { has: key } } }) : null;
  if (!part) return;
  await db.$transaction([
    db.part.update({ where: { id: part.id }, data: { qtyOnHand: { decrement: o.qty } } }),
    db.stockMove.create({ data: { shopId, partId: part.id, qty: -o.qty, reason: "ADJUSTED", userId, note: `Sold on the marketplace, order ${o.number} to ${o.buyerShop}` } }),
  ]);
}

const ACTIONS = ["accept", "decline", "buyer-paid", "paid", "ship", "received", "cancel", "message"] as const;
type OrderAction = (typeof ACTIONS)[number];

export const orderAction = safe(async function orderAction(orderId: string, action: OrderAction, formData: FormData) {
  const user = await requireUser();
  if (!ACTIONS.includes(action)) throw new UserError("Unknown order step.");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId } });
  let body: Record<string, unknown> = {};
  switch (action) {
    case "accept": {
      const pay = str(formData.get("payInstructions")) ?? shop.payInstructions;
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
      body = { carrier, tracking };
      break;
    }
    case "message": {
      const text = str(formData.get("text"));
      if (!text) throw new UserError("Write a message first.");
      body = { text };
      break;
    }
  }
  const o = (await (await hubFetch(`/v1/orders/${orderId}/${action}`, { method: "POST", json: body })).json()) as HubOrder;
  await saveOrder(o);
  if (action === "received" && formData.get("addToStock") === "on") await receiveIntoStock(o, user.id, user.shopId);
  if (action === "ship" && formData.get("takeFromStock") === "on") await takeFromStock(o, user.id, user.shopId);
  // Listing quantities change on accept / cancel; pick them up now.
  if (action === "accept" || action === "cancel") await syncHub().catch(() => {});
  refresh();
  revalidatePath("/parts", "layout");
});

export const refreshOrders = safe(async function refreshOrders() {
  await requireUser();
  await syncHub();
  refresh();
});
