import "server-only";
// Sharing is chosen per item, never automatic (HANDOFF section 3 item 9, owner decision of 27 Sep 2026; the word is
// "offer"). Two offers live here, as bodies that take the user so the check script can drive them:
//   - a hint about a model, from a machine or a ticket: the form starts with the brand and model only (hintFormFor),
//     and the note that goes out carries the brand, model, kind, title, body and the ticked photos, never the
//     customer, the serial, the problem or the ticket's notes (offerHintAs);
//   - a part, offered where the shop chooses (offerPartAs): to its partner shops (the partner price; the catalog goes
//     with the next partner sync), on the marketplace (a listing on the hub), or both. Withdrawn one at a time
//     (withdrawOfferAs). Nothing reaches the hub unless chosen.
// src/actions/shared.ts and src/actions/market.ts wrap them.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { str } from "@/lib/format";
import { hubFetch, hubId, saveListing, type HubListing } from "@/lib/hub";
import { requireHubWrites } from "@/lib/hub-writes";
import { baseNumber, centsField, numberKey } from "@/lib/parts";
import { CONDITIONS as PART_CONDITIONS, ORIGINS as PART_ORIGINS } from "@/lib/part-labels";
import type { CurrentUser } from "@/lib/session";
import type { NoteKind, PhotoKind } from "@/generated/prisma/enums";

// ---------- a hint about a model ----------

export type HintPhoto = { id: string; caption: string | null; kind: PhotoKind };

/** What the hint form starts with: the machine's brand and model, and its photos to tick. Nothing else of the machine or its tickets. */
export type HintForm = { machineId: string; brand: string; model: string; photos: HintPhoto[] };

/**
 * The hint form for a machine, or for the machine a ticket is about. Both are the signed-in company's or the answer
 * is null. The customer, the serial number, the problem and the notes are never part of it: a hint is about the model.
 */
export async function hintFormFor(shopId: string, ref: { machineId: string } | { ticketId: string }): Promise<HintForm | null> {
  const machineId = "machineId" in ref ? ref.machineId : (await db.ticket.findFirst({ where: { id: ref.ticketId, shopId }, select: { machineId: true } }))?.machineId;
  if (!machineId) return null;
  const m = await db.machine.findFirst({
    where: { id: machineId, shopId },
    select: { id: true, brand: true, model: true, photos: { select: { id: true, caption: true, kind: true }, orderBy: { createdAt: "desc" } } },
  });
  if (!m) return null;
  return { machineId: m.id, brand: m.brand, model: m.model, photos: m.photos };
}

const HINT_KINDS: NoteKind[] = ["GOTCHA", "TIP", "FACT"];

/**
 * Saves the hint as a SharedPost of this company (the next hub sync sends it). What goes out is the brand and model,
 * the kind, title and body typed, and the photos ticked. A title or body that names the machine's serial number or the
 * customer is refused: that stays in the shop.
 */
export async function offerHintAs(user: CurrentUser, machineId: string, formData: FormData): Promise<string> {
  await requireHubWrites(user);
  const m = await db.machine.findFirst({
    where: { id: machineId, shopId: user.shopId },
    select: { brand: true, model: true, modelKey: true, serial: true, customer: { select: { name: true } } },
  });
  if (!m) throw new UserError("Machine not found.");
  const title = str(formData.get("title"));
  const body = str(formData.get("body"));
  if (!title || !body) throw new UserError("Give it a short title and write what you found.");
  // Said, not cut off: the hub keeps a title to 140 characters and a note to 5,000, and would drop the rest silently.
  if (title.length > 140) throw new UserError(`Keep the title to 140 characters (it is ${title.length}).`);
  if (body.length > 5000) throw new UserError(`A note can be up to 5,000 characters; this one is ${body.length.toLocaleString("en-US")}. Shorten it, or offer it as two hints.`);
  const text = `${title}\n${body}`.toLowerCase();
  const serial = m.serial?.trim();
  if (serial && serial.length >= 4 && text.includes(serial.toLowerCase())) throw new UserError("Leave the serial number out: a hint is about the model, and every shop on the hub reads it.");
  const customer = m.customer?.name.trim();
  if (customer && customer.length >= 5 && text.includes(customer.toLowerCase())) throw new UserError("Leave the customer's name out: a hint is about the model, and every shop on the hub reads it.");
  const kind = (str(formData.get("kind")) ?? "GOTCHA") as NoteKind;
  if (!HINT_KINDS.includes(kind)) throw new UserError("Pick what kind of hint this is.");
  const photoIds = formData.getAll("photoIds").map(String).slice(0, 12);
  const photos = photoIds.length
    ? await db.machinePhoto.findMany({ where: { id: { in: photoIds }, machineId, shopId: user.shopId }, select: { kind: true, caption: true, mime: true, data: true } })
    : [];
  const post = await db.sharedPost.create({
    data: {
      shopId: user.shopId,
      authorId: user.id,
      brand: m.brand,
      model: m.model,
      modelKey: m.modelKey,
      kind,
      title,
      body,
      photos: { create: photos.map((p, i) => ({ kind: p.kind, caption: p.caption, mime: p.mime, data: p.data, sortOrder: i })) },
    },
    select: { id: true },
  });
  return post.id;
}

// ---------- a listing on the marketplace ----------

const CONDITIONS: string[] = PART_CONDITIONS;
const ORIGINS: string[] = PART_ORIGINS;
const LISTING_KINDS = ["PART", "ACCESSORY", "SUPPLY", "NOTION", "FABRIC", "THREAD", "PATTERN"];
const IMAGE = ["image/jpeg", "image/png", "image/webp"];
const MAX_CENTS = 100_000_000; // $1,000,000: far more than a part sells for, and well inside the hub's integer columns

/** A whole number from `min` up (1.5 is not 2: it is refused, the seller is asked). */
function int(v: FormDataEntryValue | null, min: number) {
  const n = Number(str(v) ?? "NaN");
  return Number.isInteger(n) && n >= min && n <= 1_000_000 ? n : null;
}

/**
 * Dollars typed as cents. Blank is null. More than two decimals (19.999) isn't rounded behind the seller's back, and a
 * word, a minus sign or a price no part has is refused.
 */
export function strictCents(v: FormDataEntryValue | null, what: string): number | null {
  const s = (str(v) ?? "").replace(/[$,\s]/g, "");
  if (s === "") return null;
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(s)) throw new UserError(`${what}: enter dollars and cents, like 12.50.`);
  const cents = Math.round(Number(s) * 100);
  if (cents > MAX_CENTS) throw new UserError(`${what} can't be more than $${(MAX_CENTS / 100).toLocaleString("en-US")}.`);
  return cents;
}

/** The listing the form describes, checked, with the company's name on it. Nothing of the shop but its id and name. */
export async function listingFromForm(formData: FormData, shop: { id: string; name: string }) {
  const title = str(formData.get("title"));
  const priceCents = strictCents(formData.get("price"), "Price");
  const qty = int(formData.get("qty"), 1);
  if (!title) throw new UserError('Give the listing a title, e.g. "Brother PR bobbin case, new".');
  if (priceCents == null || priceCents <= 0) throw new UserError("Enter the price each.");
  if (qty == null) throw new UserError("Enter how many you have to sell, as a whole number.");
  // The hub keeps a title to 160 characters and a description to 4,000: say so, instead of cutting the end off.
  if (title.length > 160) throw new UserError(`Keep the title to 160 characters (it is ${title.length}).`);
  const description = str(formData.get("description"));
  if (description && description.length > 4000) throw new UserError(`Keep the description to 4,000 characters (it is ${description.length.toLocaleString("en-US")}).`);
  const kind = str(formData.get("kind")) ?? "PART";
  const condition = str(formData.get("condition")) ?? "NEW";
  const origin = str(formData.get("origin"));
  const partNumber = str(formData.get("partNumber"));
  const xpart = partNumber ? await db.xPart.findFirst({ where: { numberKeys: { has: numberKey(partNumber) } }, select: { id: true } }) : null;
  return {
    title,
    description,
    kind: LISTING_KINDS.includes(kind) ? kind : "PART",
    condition: CONDITIONS.includes(condition) ? condition : "NEW",
    // Who made it. An older hub ignores this; a form that doesn't say (opened before it was added) leaves it unstated.
    origin: origin && ORIGINS.includes(origin) ? origin : null,
    brand: str(formData.get("brand")),
    partNumber,
    xpartId: xpart?.id ?? null,
    fits: str(formData.get("fits")),
    priceCents,
    currency: "USD",
    qty,
    shippingCents: strictCents(formData.get("shipping"), "Shipping"),
    shippingNote: str(formData.get("shippingNote")),
    // Only what the seller typed: never the shop's street address, which every hub member would see.
    shipsFrom: str(formData.get("shipsFrom")),
    // Listed by this company, under its own name (several companies can share one StitchBench).
    shopRef: shop.id,
    shopName: shop.name,
    // The form's own id: sent again after a lost answer, it's the same listing on the hub, not a second one.
    clientId: str(formData.get("clientId")),
  };
}

/** The photos the form carries, checked (JPEG, PNG or WebP, under 3 MB, at most 8). */
export function listingPhotos(formData: FormData): File[] {
  const photos = formData
    .getAll("photos")
    .filter((f): f is File => f instanceof File && f.size > 0)
    .slice(0, 8);
  for (const f of photos) {
    if (!IMAGE.includes(f.type)) throw new UserError("Photos must be JPEG, PNG or WebP.");
    if (f.size > 3 * 1024 * 1024) throw new UserError("Each photo must be under 3 MB.");
  }
  return photos;
}

/** Puts the listing on the hub and keeps the copy here as this company's. The one hub write a part offer makes. */
export async function postListing(shopId: string, listing: Awaited<ReturnType<typeof listingFromForm>>, photos: File[]): Promise<HubListing> {
  const fd = new FormData();
  fd.set("listing", JSON.stringify(listing));
  for (const f of photos) fd.append("photo", f, f.name || "photo.jpg");
  const l = (await (await hubFetch("/v1/listings", { method: "POST", body: fd })).json()) as HubListing;
  await saveListing(l);
  await db.listing.update({ where: { id: l.id }, data: { shopId } });
  return l;
}

// ---------- offering a part ----------

export type PartOffer = { partners: boolean; listingId: string | null };

/** The part, if it's this company's (and not a partner's consigned stock, which isn't the shop's to offer). */
async function ownPart(shopId: string, partId: string) {
  const p = await db.part.findFirst({ where: { id: partId, shopId } });
  if (!p) throw new UserError("Part not found.");
  return p;
}

/**
 * One "Offer this part": the form ticks `partners` (to the shop's partner sewing shops, at the partner price typed or
 * already saved), `market` (a listing on the community marketplace, from the listing fields), or both. Neither is
 * refused, so nothing is offered by accident. The hub is written only for the marketplace choice; the partner offer is
 * a flag on the part that the next partner sync carries in the catalog. Only an owner or admin sets what partners pay.
 */
export async function offerPartAs(user: CurrentUser, partId: string, formData: FormData): Promise<PartOffer> {
  const p = await ownPart(user.shopId, partId);
  const toPartners = formData.get("partners") === "on";
  const toMarket = formData.get("market") === "on";
  if (!toPartners && !toMarket) throw new UserError("Pick where to offer it: your partner shops, the marketplace, or both.");
  if (p.consignLinkId) throw new UserError(`${p.partNumber} is a partner's consigned stock: it's theirs to offer, not yours.`);
  let wholesaleCents: number | null = null;
  if (toPartners) {
    if (user.role === "TECH") throw new UserError("Only an owner or admin can offer a part to partner shops (it sets what they pay).");
    wholesaleCents = centsField(formData.get("wholesale"), "Partner price") ?? p.wholesaleCents;
    if (wholesaleCents == null) throw new UserError("Enter the partner price: what partner shops pay for it.");
  }
  let listingId: string | null = null;
  if (toMarket) {
    // Switched off for this company by the StitchBench administrator: no listing goes out.
    await requireHubWrites(user);
    const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { id: true, name: true } });
    const listing = await listingFromForm(formData, shop);
    listingId = (await postListing(user.shopId, listing, listingPhotos(formData))).id;
  }
  // The hub answered (or wasn't asked): now the partner offer, so a refused listing leaves the part as it was.
  if (toPartners) await db.part.update({ where: { id: p.id }, data: { offerToPartners: true, wholesaleCents } });
  return { partners: toPartners, listingId };
}

/**
 * Takes one offer back: "partners" clears the flag (the next partner sync sends the catalog without it); "market"
 * removes the listing from the hub and the copy here. The listing must be this company's own.
 */
export async function withdrawOfferAs(user: CurrentUser, partId: string, where: "partners" | "market", listingId?: string | null): Promise<void> {
  const p = await ownPart(user.shopId, partId);
  if (where === "partners") {
    if (user.role === "TECH") throw new UserError("Only an owner or admin can withdraw a part from partner shops.");
    if (!p.offerToPartners) throw new UserError("It isn't offered to partner shops.");
    await db.part.update({ where: { id: p.id }, data: { offerToPartners: false } });
    return;
  }
  if (where !== "market") throw new UserError("Say which offer to withdraw.");
  if (!listingId) throw new UserError("Say which listing to withdraw.");
  const l = await db.listing.findUnique({ where: { id: listingId }, select: { shopId: true, mine: true, numberKey: true } });
  if (!l || !l.mine || l.shopId !== user.shopId) throw new UserError("That listing isn't one of yours.");
  if (l.numberKey && !p.numberKeys.includes(l.numberKey)) throw new UserError("That listing isn't of this part.");
  await hubFetch(`/v1/listings/${hubId(listingId)}`, { method: "DELETE" });
  await db.listing.deleteMany({ where: { id: listingId } });
}

export type PartOffers = {
  /** Offered to partner shops, and at what price (null when the price isn't set, so the catalog leaves it out). */
  partners: { on: boolean; wholesaleCents: number | null };
  /** This company's live listings of the part on the marketplace. */
  listings: { id: string; title: string; qty: number; priceCents: number; status: string }[];
};

/** What the part page says plainly: where this part is offered right now. */
export async function offersFor(shopId: string, part: { id: string; numberKeys: string[] }): Promise<PartOffers> {
  const [p, listings] = await Promise.all([
    db.part.findFirst({ where: { id: part.id, shopId }, select: { offerToPartners: true, wholesaleCents: true } }),
    part.numberKeys.length
      ? db.listing.findMany({
          where: { mine: true, shopId, numberKey: { in: part.numberKeys } },
          orderBy: { createdAt: "desc" },
          select: { id: true, title: true, qty: true, priceCents: true, status: true },
        })
      : [],
  ]);
  return { partners: { on: p?.offerToPartners ?? false, wholesaleCents: p?.wholesaleCents ?? null }, listings };
}

/** The listing fields a part fills in: its own description, number and prices. The suffix that tells stock apart ("X (used)") isn't part of the number. */
export function listingDefaultsFor(p: {
  description: string;
  partNumber: string;
  ownNumber: boolean;
  brand: string | null;
  fits: string | null;
  kind: string;
  condition: string;
  origin: string;
  priceCents: number | null;
  qtyOnHand: number;
}) {
  return {
    title: p.description,
    // A shop number isn't the maker's, so a listing of such an item has none; what it fits and its photos say what it is.
    partNumber: p.ownNumber ? null : baseNumber(p.partNumber),
    brand: p.brand,
    fits: p.fits,
    kind: p.kind,
    condition: p.condition,
    origin: p.origin,
    priceCents: p.priceCents,
    // Whole units: a listing's quantity is a count (for fabric, whole yards).
    qty: Math.max(1, Math.floor(p.qtyOnHand)),
  };
}
