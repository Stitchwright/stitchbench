import "server-only";
// Shipping labels through Shippo (shop-features-round-2-design.md 9.5, package shippo). Off until an owner or admin turns
// it on in Settings → Shipping labels with the shop's own Shippo API key (sealed; labels are paid on the shop's Shippo
// account) and where parcels ship from. On Online orders, a paid order to post gets "Get rates" (the usual box and its
// weight), the cheapest few rates, and "Buy" (owner or admin, asked once): the label's address to print, and the
// tracking number on the order, ready for Shipped. Plain fetch against SHIPPO_API_BASE (api.goshippo.com; the checks
// use scripts/test-mail/shippo-mock.mjs). Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { money, str, toCents } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { seal, unseal } from "@/lib/messaging/secrets";
import { splitAddress } from "@/lib/ship-export";
import type { CurrentUser } from "@/lib/session";

const BASE = () => (process.env.SHIPPO_API_BASE?.trim() || "https://api.goshippo.com").replace(/\/$/, "");
export const looksLikeShippoKey = (s: string) => /^shippo_(test|live)_[A-Za-z0-9]{8,}$/.test(s);

export type ShipFrom = { name: string; street1: string; city: string; state: string; zip: string; phone: string };
export type Parcel = { lengthIn: number; widthIn: number; heightIn: number; weightOz: number };
const DEFAULT_PARCEL: Parcel = { lengthIn: 12, widthIn: 9, heightIn: 4, weightOz: 16 };

export function readShipFrom(raw: unknown): ShipFrom {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const t = (k: keyof ShipFrom) => (typeof o[k] === "string" ? (o[k] as string) : "");
  return { name: t("name"), street1: t("street1"), city: t("city"), state: t("state"), zip: t("zip"), phone: t("phone") };
}
export function readParcel(raw: unknown): Parcel {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (k: keyof Parcel) => (typeof o[k] === "number" && (o[k] as number) > 0 ? (o[k] as number) : DEFAULT_PARCEL[k]);
  return { lengthIn: n("lengthIn"), widthIn: n("widthIn"), heightIn: n("heightIn"), weightOz: n("weightOz") };
}
const fromComplete = (f: ShipFrom) => !!(f.name && f.street1 && f.city && /^[A-Z]{2}$/.test(f.state) && /^\d{5}(-\d{4})?$/.test(f.zip));

async function call<T>(key: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE()}${path}`, { method, headers: { authorization: `ShippoToken ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000), cache: "no-store" });
  } catch (e) {
    throw new UserError(`Couldn't reach Shippo (${e instanceof Error ? e.message : "network"}). Try again in a minute.`);
  }
  const text = await res.text();
  let j: unknown = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (res.status === 401) throw new UserError("Shippo refused the key. Check it in Settings, Shipping labels.");
  if (!res.ok) {
    console.error(`shippo ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    throw new UserError("Shippo refused that. Check the addresses and the box, then try again.");
  }
  return j as T;
}

export async function shippoSettings(shopId: string) {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { shippoOn: true, shippoKeySealed: true, shipFrom: true, shipParcel: true, name: true, phone: true, address: true } });
  const key = unseal(s.shippoKeySealed, shopId, "shippoKey")?.plain ?? null;
  const from = readShipFrom(s.shipFrom);
  // Filled from the shop's own address the first time.
  if (!from.street1 && s.address) {
    const a = splitAddress(s.address);
    Object.assign(from, { name: from.name || s.name, street1: a.street, city: a.city, state: a.state, zip: a.zip, phone: from.phone || (s.phone ?? "") });
  }
  return { on: s.shippoOn, hasKey: !!key, testMode: !!key && key.startsWith("shippo_test_"), from, parcel: readParcel(s.shipParcel) };
}

export async function saveShippoSettingsFor(user: CurrentUser, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  if (user.role === "TECH") throw new UserError("Only an owner or admin sets up shipping labels.");
  const key = str(fd.get("shippoKey"));
  if (key && !looksLikeShippoKey(key)) throw new UserError("A Shippo API key starts with shippo_live_ or shippo_test_.");
  const from: ShipFrom = {
    name: (str(fd.get("fromName")) ?? "").slice(0, 80),
    street1: (str(fd.get("fromStreet")) ?? "").slice(0, 100),
    city: (str(fd.get("fromCity")) ?? "").slice(0, 60),
    state: (str(fd.get("fromState")) ?? "").toUpperCase().slice(0, 2),
    zip: (str(fd.get("fromZip")) ?? "").slice(0, 10),
    phone: (str(fd.get("fromPhone")) ?? "").slice(0, 30),
  };
  const num = (k: string, words: string, max: number) => {
    const raw = str(fd.get(k));
    if (!raw) return undefined;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0 || v > max) throw new UserError(`${words}: a number up to ${max}.`);
    return v;
  };
  const parcel = { lengthIn: num("lengthIn", "Length (inches)", 108), widthIn: num("widthIn", "Width (inches)", 108), heightIn: num("heightIn", "Height (inches)", 108), weightOz: num("weightOz", "Weight (ounces)", 1120) };
  const on = fd.get("on") === "on";
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { shippoKeySealed: true } });
  if (on && !key && !shop.shippoKeySealed) throw new UserError("Paste your Shippo API key to turn labels on.");
  if (on && !fromComplete(from)) throw new UserError("Fill in where parcels ship from: name, street, city, two-letter state and ZIP.");
  await db.shop.update({
    where: { id: user.shopId },
    data: { shippoOn: on, shipFrom: from, shipParcel: readParcel(parcel), ...(key ? { shippoKeySealed: seal(key, user.shopId, "shippoKey") } : {}) },
  });
  return on ? "Shipping labels are on." : "Saved. Labels are off.";
}

async function keyAndFrom(shopId: string) {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { shippoOn: true, shippoKeySealed: true, shipFrom: true, shipParcel: true } });
  if (!s.shippoOn) throw new UserError("Shipping labels are off (Settings, Shipping labels).");
  const key = unseal(s.shippoKeySealed, shopId, "shippoKey")?.plain;
  if (!key) throw new UserError("Paste your Shippo API key in Settings, Shipping labels.");
  const from = readShipFrom(s.shipFrom);
  if (!fromComplete(from)) throw new UserError("Fill in where parcels ship from in Settings, Shipping labels.");
  return { key, from, parcel: readParcel(s.shipParcel) };
}

async function orderToShip(shopId: string, id: string) {
  const o = await db.webOrder.findFirst({ where: { id: assertId(id), shopId } });
  if (!o) throw new UserError("Order not found.");
  if (o.fulfil !== "ship") throw new UserError("That order is picked up, not posted.");
  if (o.status !== "PAID") throw new UserError("Only a paid order waiting to be packed gets a label.");
  if (o.shippoTxId) throw new UserError("That order already has a label.");
  return o;
}

export type RateChoice = { id: string; carrier: string; service: string; cents: number; days: number | null };
type ShippoRate = { object_id: string; amount: string; provider: string; servicelevel?: { name?: string }; estimated_days?: number | null };

/** The cheapest rates for an order's parcel (its weight typed, else the usual box's). */
export async function ratesFor(user: CurrentUser, orderId: string, fd: FormData | null): Promise<RateChoice[]> {
  const { key, from, parcel } = await keyAndFrom(user.shopId);
  const o = await orderToShip(user.shopId, orderId);
  const to = splitAddress(o.address ?? "", o.name);
  if (!to.sure) throw new UserError("The address couldn't be read for a label (street, city, state, ZIP). Check it with the customer, or use Export for Pirate Ship.");
  const rawOz = str(fd?.get("weightOz"));
  const weightOz = rawOz ? Number(rawOz) : parcel.weightOz;
  if (!Number.isFinite(weightOz) || weightOz <= 0 || weightOz > 1120) throw new UserError("The weight: ounces, like 24.");
  const s = await call<{ rates?: ShippoRate[]; messages?: { text?: string }[] }>(key, "POST", "/shipments/", {
    address_from: { name: from.name, street1: from.street1, city: from.city, state: from.state, zip: from.zip, country: "US", phone: from.phone || undefined },
    address_to: { name: o.name, street1: to.street, street2: to.line2 || undefined, city: to.city, state: to.state, zip: to.zip, country: "US", phone: o.phone || undefined, email: o.email || undefined },
    parcels: [{ length: String(parcel.lengthIn), width: String(parcel.widthIn), height: String(parcel.heightIn), distance_unit: "in", weight: String(weightOz), mass_unit: "oz" }],
    async: false,
  });
  const rates = (s.rates ?? [])
    .map((r) => ({ id: r.object_id, carrier: r.provider, service: r.servicelevel?.name ?? "", cents: toCents(r.amount) ?? 0, days: r.estimated_days ?? null }))
    .filter((r) => r.cents > 0)
    .sort((a, b) => a.cents - b.cents)
    .slice(0, 4);
  if (!rates.length) throw new UserError(`No rates for that address${s.messages?.[0]?.text ? ` (${s.messages[0].text})` : ""}. Check it with the customer.`);
  return rates;
}

/** Buys the label at the rate picked (paid on the shop's Shippo account). Owner or admin. */
export async function buyLabelFor(user: CurrentUser, orderId: string, rateId: string): Promise<string> {
  await requireBaseWritable(user);
  if (user.role === "TECH") throw new UserError("Only an owner or admin buys labels (they cost the shop money).");
  if (!/^[A-Za-z0-9_]{6,80}$/.test(rateId)) throw new UserError("Get the rates again.");
  const { key } = await keyAndFrom(user.shopId);
  const o = await orderToShip(user.shopId, orderId);
  // One label an order: claimed before the purchase, released if it fails.
  const claim = await db.webOrder.updateMany({ where: { id: o.id, shopId: user.shopId, shippoTxId: null }, data: { shippoTxId: "buying" } });
  if (!claim.count) throw new UserError("That order already has a label.");
  try {
    const t = await call<{ object_id: string; status: string; tracking_number?: string; label_url?: string; rate?: string; messages?: { text?: string }[] }>(key, "POST", "/transactions/", { rate: rateId, label_file_type: "PDF", async: false });
    if (t.status !== "SUCCESS" || !t.label_url) throw new UserError(`The label wasn't made${t.messages?.[0]?.text ? ` (${t.messages[0].text})` : ""}. Try another rate.`);
    const r = await call<ShippoRate>(key, "GET", `/rates/${encodeURIComponent(rateId)}`).catch(() => null);
    await db.webOrder.updateMany({
      where: { id: o.id, shopId: user.shopId },
      data: { shippoTxId: t.object_id, labelUrl: t.label_url, tracking: t.tracking_number ?? o.tracking, labelCarrier: r ? `${r.provider} ${r.servicelevel?.name ?? ""}`.trim() : null, labelCents: r ? toCents(r.amount) : null },
    });
    return `Label bought${r ? ` (${money(toCents(r.amount))})` : ""}. Print it, pack the order, then press Shipped.`;
  } catch (e) {
    await db.webOrder.updateMany({ where: { id: o.id, shopId: user.shopId, shippoTxId: "buying" }, data: { shippoTxId: null } });
    throw e;
  }
}
