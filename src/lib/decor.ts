import "server-only";
// Decorating orders (docs/plans/decorators-proposal.md, packages D1, D2 and the file import of D5): the print and cut jobs'
// pattern for a counter that decorates garments. An order is who it is for, what it is, the garments (lines) and the
// decorations that go on every piece (placements, each with the design file, read for its stitch count when it is DST).
// The price is worked out from the shop's table (src/lib/decor-math.ts) every time the order changes while it is open, and
// kept as worked out: a sale bills exactly those parts. Quoted, approved, in production, ready (the ready message),
// collected (billed at the register). Every query filters by shopId. No quote by link yet: the price is told at the counter.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str, toCents } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireModule } from "@/lib/modules";
import { moduleOn } from "@/lib/module-gate";
import { customerFromForm } from "@/lib/customer-input";
import { completeSaleAs } from "@/lib/register-sale";
import { TENDER_METHODS, type TenderMethod } from "@/lib/register-math";
import { shopTimeZone } from "@/lib/shop-zone";
import { parseYmd, zonedTime } from "@/lib/zoned";
import { queueToCustomer } from "@/lib/messaging/queue";
import { firstName } from "@/lib/messaging/templates";
import { currentStoreId } from "@/lib/stores";
import { MAX_DESIGN_BYTES, formatOf, readEmbroidery } from "@/lib/embroidery-file";
import { DECOR_MOVES, OPEN_DECOR, cleanPrices, decorStatusLabel, orderPrice, parseBreaks, parseTiers, pieceCents, runMinutes, sizesTotal, type DecorPrices, type DecorStatus } from "@/lib/decor-math";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

const MAX_CENTS = 10_000_000;
const MAX_LINES = 60;
const MAX_PLACEMENTS = 12;
const MAX_PIECES = 100_000;

// ---------------------------------------------------------------------------------------------------------------
// The price table

export async function decorPrices(shopId: string): Promise<DecorPrices> {
  const row = await db.decorSettings.findUnique({ where: { shopId }, select: { prices: true } });
  return cleanPrices(row?.prices);
}

/** The price table from Settings: the stitch tiers, quantity breaks and the fees. Owner or admin. */
export async function saveDecorPricesFor(user: CurrentUser, fd: FormData): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change the prices.");
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const tiers = parseTiers(str(fd.get("tiers")) ?? "");
  if ("error" in tiers) throw new UserError(tiers.error);
  const breaks = parseBreaks(str(fd.get("breaks")) ?? "");
  if ("error" in breaks) throw new UserError(breaks.error);
  const cents = (name: string, what: string, max = 100_000) => {
    const c = toCents(str(fd.get(name)) ?? "0");
    if (c == null || c < 0 || c > max) throw new UserError(`${what}: dollars, like 5 (0 for none).`);
    return c;
  };
  const whole = (name: string, what: string, lo: number, hi: number) => {
    const n = Number(str(fd.get(name)) ?? "");
    if (!Number.isInteger(n) || n < lo || n > hi) throw new UserError(`${what}: a whole number from ${lo} to ${hi}.`);
    return n;
  };
  const prices: DecorPrices = {
    tiers: tiers.tiers,
    breaks: breaks.breaks,
    extraPer1000Cents: cents("extra", "The price for each extra thousand stitches"),
    digitizingCents: cents("digitizing", "The digitizing fee"),
    setupCents: cents("setup", "The set-up fee"),
    stitchesPerMinute: whole("spm", "The machine's speed (stitches a minute)", 50, 3000),
    colorChangeSeconds: whole("colorSeconds", "Seconds for a colour change", 0, 3600),
  };
  await db.decorSettings.upsert({ where: { shopId: user.shopId }, create: { shopId: user.shopId, prices }, update: { prices } });
  return "Saved the prices. Orders already quoted keep the price they were quoted at.";
}

// ---------------------------------------------------------------------------------------------------------------
// Working out an order's price (kept on the order and its placements)

/** Recomputes the price from the order's lines and placements and the shop's table, and stores the parts. */
async function requote(tx: Prisma.TransactionClient, shopId: string, orderId: string): Promise<number> {
  const [lines, placements, settings] = await Promise.all([
    tx.decorLine.findMany({ where: { orderId, shopId }, select: { qty: true, garmentCents: true } }),
    tx.decorPlacement.findMany({ where: { orderId, shopId }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, stitches: true, newDesign: true, priceEachCents: true } }),
    tx.decorSettings.findUnique({ where: { shopId }, select: { prices: true } }),
  ]);
  const prices = cleanPrices(settings?.prices);
  const price = orderPrice(lines, placements, prices);
  for (const [i, pl] of placements.entries()) await tx.decorPlacement.updateMany({ where: { id: pl.id, shopId }, data: { quotedEachCents: price.eachCents[i] } });
  if (price.totalCents > MAX_CENTS) throw new UserError("That comes to more than $100,000. Check the quantities and prices.");
  await tx.decorOrder.updateMany({ where: { id: orderId, shopId }, data: { quoteCents: price.totalCents, digitizingCents: price.digitizingCents, setupCents: price.setupCents } });
  return price.totalCents;
}

async function ownOrder(shopId: string, id: string) {
  const o = await db.decorOrder.findFirst({ where: { id: assertId(id), shopId } });
  if (!o) throw new UserError("Order not found.");
  return o;
}

/** Lines and placements can change until the order is in production. */
function assertEditable(o: { status: string; number: number }) {
  if (!["QUOTED", "APPROVED"].includes(o.status)) throw new UserError(`Order #${o.number} is ${decorStatusLabel(o.status).toLowerCase()}: its garments and decorations can't be changed now. Move it back to approved first.`);
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

// ---------------------------------------------------------------------------------------------------------------
// The order

export async function createOrderFor(user: CurrentUser, fd: FormData): Promise<{ id: string; number: number }> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const shopId = user.shopId;
  const title = (str(fd.get("title")) ?? "").replace(/\s+/g, " ").slice(0, 120);
  if (!title) throw new UserError('Say what it is, like "Riverside Fire Dept polos".');
  const dueRaw = str(fd.get("due"));
  const dueYmd = dueRaw ? parseYmd(dueRaw) : null;
  if (dueRaw && !dueYmd) throw new UserError("Enter the due date as a date.");
  const tz = await shopTimeZone(shopId);
  const here = await currentStoreId(user);
  return db.$transaction(async (tx) => {
    const customer = await customerFromForm(tx, shopId, fd, user.id, "counter");
    const sh = await tx.shop.update({ where: { id: shopId }, data: { nextDecorOrderNumber: { increment: 1 } }, select: { nextDecorOrderNumber: true } });
    const number = sh.nextDecorOrderNumber - 1;
    const o = await tx.decorOrder.create({
      data: {
        shopId,
        locationId: here,
        number,
        customerId: customer.id,
        name: customer.name,
        title,
        dueAt: dueYmd ? zonedTime(dueYmd, 12 * 60, tz) : null,
        note: str(fd.get("note"))?.slice(0, 1000) ?? null,
        taxable: !fd.has("taxable") || fd.getAll("taxable").map(String).includes("on"),
        createdById: user.id,
      },
      select: { id: true },
    });
    return { id: o.id, number };
  });
}

/** Changes an open order's title, due date, notes and whether it is taxed. */
export async function saveOrderFor(user: CurrentUser, id: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const o = await ownOrder(user.shopId, id);
  if (!OPEN_DECOR.includes(o.status as DecorStatus)) throw new UserError(`An order that is ${decorStatusLabel(o.status).toLowerCase()} can't be changed.`);
  const title = (str(fd.get("title")) ?? "").replace(/\s+/g, " ").slice(0, 120);
  if (!title) throw new UserError("Say what it is.");
  const dueRaw = str(fd.get("due"));
  const dueYmd = dueRaw ? parseYmd(dueRaw) : null;
  if (dueRaw && !dueYmd) throw new UserError("Enter the due date as a date.");
  const tz = await shopTimeZone(user.shopId);
  await db.decorOrder.updateMany({
    where: { id: o.id, shopId: user.shopId },
    data: { title, dueAt: dueYmd ? zonedTime(dueYmd, 12 * 60, tz) : null, note: str(fd.get("note"))?.slice(0, 1000) ?? null, taxable: !fd.has("taxable") || fd.getAll("taxable").map(String).includes("on") },
  });
  return "Saved.";
}

// ---------------------------------------------------------------------------------------------------------------
// Garments

export async function addLineFor(user: CurrentUser, orderId: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const shopId = user.shopId;
  const o = await ownOrder(shopId, orderId);
  assertEditable(o);
  const description = (str(fd.get("description")) ?? "").replace(/\s+/g, " ").slice(0, 120);
  if (!description) throw new UserError('Say what the garment is, like "Port Authority polo".');
  const sizes = (str(fd.get("sizes")) ?? "").replace(/\s+/g, " ").slice(0, 120) || null;
  const typedQty = str(fd.get("qty"));
  const fromSizes = sizes ? sizesTotal(sizes) : null;
  let qty = typedQty ? Number(typedQty) : (fromSizes ?? NaN);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_PIECES) throw new UserError("How many: a whole number, or sizes with counts like S 2, M 4.");
  if (typedQty && fromSizes != null && fromSizes !== qty) throw new UserError(`The sizes add up to ${fromSizes}, not ${qty}. Fix one of them.`);
  qty = Math.round(qty);
  const each = str(fd.get("garment"));
  const garmentCents = each ? toCents(each) : 0;
  if (garmentCents == null || garmentCents < 0 || garmentCents > 100_000) throw new UserError("What you charge for each garment: dollars, or leave it empty when the customer brings them.");
  await db.$transaction(async (tx) => {
    const count = await tx.decorLine.count({ where: { orderId: o.id, shopId } });
    if (count >= MAX_LINES) throw new UserError(`${MAX_LINES} garment lines is the most on one order.`);
    await tx.decorLine.create({ data: { shopId, orderId: o.id, sortOrder: count, description, color: str(fd.get("color"))?.slice(0, 40) ?? null, sizes, qty, garmentCents } });
    await requote(tx, shopId, o.id);
  });
  return "Added the garment.";
}

export async function removeLineFor(user: CurrentUser, orderId: string, lineId: string): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const shopId = user.shopId;
  const o = await ownOrder(shopId, orderId);
  assertEditable(o);
  await db.$transaction(async (tx) => {
    const r = await tx.decorLine.deleteMany({ where: { id: assertId(lineId), orderId: o.id, shopId } });
    if (r.count !== 1) throw new UserError("That garment isn't on this order.");
    await requote(tx, shopId, o.id);
  });
  return "Removed.";
}

// ---------------------------------------------------------------------------------------------------------------
// Decorations and the design file

/** The design file from the form: 10 MB at most. Null when none was chosen. */
async function designFrom(fd: FormData): Promise<{ name: string; data: Uint8Array<ArrayBuffer> } | null> {
  const f = fd.get("file");
  if (!(f instanceof File) || f.size === 0) return null;
  if (f.size > MAX_DESIGN_BYTES) throw new UserError(`That file is larger than ${MAX_DESIGN_BYTES / 1024 / 1024} MB. Ask for a smaller one.`);
  const name = f.name.replace(/[^\w .()-]+/g, "_").slice(-120) || "design";
  return { name, data: new Uint8Array(await f.arrayBuffer()) };
}

const positive = (v: string | null, what: string, max: number, whole = true): number | null => {
  if (!v) return null;
  const n = Number(v.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > max || (whole && !Number.isInteger(n))) throw new UserError(`${what}: ${whole ? "a whole number" : "a number"} up to ${max.toLocaleString("en-US")}.`);
  return n;
};

/**
 * Adds a decoration to every piece. A DST file is read for its stitch count, colours and size (what the file says wins
 * over anything typed); any other file is kept and the stitch count is typed.
 */
export async function addPlacementFor(user: CurrentUser, orderId: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const shopId = user.shopId;
  const o = await ownOrder(shopId, orderId);
  assertEditable(o);
  const location = (str(fd.get("location")) ?? "").replace(/\s+/g, " ").slice(0, 40);
  if (!location) throw new UserError('Where it goes, like "Left chest".');
  const file = await designFrom(fd);
  const info = file ? readEmbroidery(file.name, file.data) : null;
  let stitches = positive(str(fd.get("stitches")), "The stitch count", 5_000_000) ?? 0;
  let colors = positive(str(fd.get("colors")), "The number of colours", 100) ?? 1;
  let widthMm = positive(str(fd.get("width")), "The width in mm", 2000, false);
  let heightMm = positive(str(fd.get("height")), "The height in mm", 2000, false);
  let said = "";
  if (info?.readable) {
    stitches = info.stitches ?? stitches;
    colors = info.colors ?? colors;
    widthMm = info.widthMm ?? widthMm;
    heightMm = info.heightMm ?? heightMm;
    said = ` The file says ${stitches.toLocaleString("en-US")} stitches in ${colors} colour${colors === 1 ? "" : "s"}.`;
  }
  if (stitches < 1 && !str(fd.get("price"))) throw new UserError(file && !info?.readable ? `${formatOf(file.name)} files aren't read yet: type the stitch count (the design program shows it).` : "Give the stitch count, or choose a DST file, or type the price for each piece.");
  const priceRaw = str(fd.get("price"));
  const priceEachCents = priceRaw ? toCents(priceRaw) : null;
  if (priceRaw && (priceEachCents == null || priceEachCents < 0 || priceEachCents > 100_000)) throw new UserError("The price for each piece: dollars, like 7.50 (leave empty to use your price table).");
  await db.$transaction(async (tx) => {
    const count = await tx.decorPlacement.count({ where: { orderId: o.id, shopId } });
    if (count >= MAX_PLACEMENTS) throw new UserError(`${MAX_PLACEMENTS} decorations is the most on one order.`);
    await tx.decorPlacement.create({
      data: {
        shopId,
        orderId: o.id,
        sortOrder: count,
        location,
        method: "EMBROIDERY",
        stitches,
        colors: Math.max(1, colors),
        widthMm,
        heightMm,
        newDesign: fd.getAll("newDesign").map(String).includes("on"),
        priceEachCents,
        note: str(fd.get("note"))?.slice(0, 300) ?? null,
        ...(file ? { fileName: file.name, fileFormat: info?.format ?? formatOf(file.name), fileData: file.data, fileReadable: !!info?.readable } : {}),
      },
    });
    await requote(tx, shopId, o.id);
  });
  return `Added ${location.toLowerCase()}.${said}`;
}

export async function removePlacementFor(user: CurrentUser, orderId: string, placementId: string): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const shopId = user.shopId;
  const o = await ownOrder(shopId, orderId);
  assertEditable(o);
  await db.$transaction(async (tx) => {
    const r = await tx.decorPlacement.deleteMany({ where: { id: assertId(placementId), orderId: o.id, shopId } });
    if (r.count !== 1) throw new UserError("That decoration isn't on this order.");
    await requote(tx, shopId, o.id);
  });
  return "Removed.";
}

/** The price worked out again from today's price table (an owner's or admin's choice: it moves a quoted price). */
export async function requoteFor(user: CurrentUser, orderId: string): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  if (user.role === "TECH") throw new UserError("Only an owner or admin can work the price out again.");
  const o = await ownOrder(user.shopId, orderId);
  assertEditable(o);
  const total = await db.$transaction((tx) => requote(tx, user.shopId, o.id));
  return `The price is ${money(total)} before tax.`;
}

/** A design file for download: this company's own order only. */
export async function placementFile(shopId: string, placementId: string): Promise<{ name: string; data: Uint8Array } | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(placementId)) return null;
  const p = await db.decorPlacement.findFirst({ where: { id: placementId, shopId }, select: { fileName: true, fileData: true } });
  if (!p?.fileData) return null;
  return { name: p.fileName ?? "design", data: p.fileData };
}

// ---------------------------------------------------------------------------------------------------------------
// The steps

/** Moves an order one step (see DECOR_MOVES); Ready tells the customer when Messages is on. */
export async function setOrderStatusFor(user: CurrentUser, id: string, to: string): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const o = await ownOrder(user.shopId, id);
  if (to === "COLLECTED") throw new UserError("Collect it to take payment and hand it over.");
  if (!(DECOR_MOVES[o.status] ?? []).includes(to as DecorStatus)) throw new UserError(`An order that is ${decorStatusLabel(o.status).toLowerCase()} can't go to ${decorStatusLabel(to).toLowerCase()}.`);
  if (to === "APPROVED" && o.quoteCents <= 0) throw new UserError("Add the garments and decorations first, so there is a price to approve.");
  const at = new Date();
  const stamps: Prisma.DecorOrderUpdateManyMutationInput =
    to === "APPROVED" ? { approvedAt: o.approvedAt ?? at, startedAt: null, readyAt: null } : to === "IN_PRODUCTION" ? { startedAt: o.startedAt ?? at, readyAt: null } : to === "READY" ? { readyAt: at } : to === "QUOTED" ? { approvedAt: null } : to === "CANCELLED" ? { closedAt: at } : {};
  const r = await db.decorOrder.updateMany({ where: { id: o.id, shopId: user.shopId, status: o.status }, data: { status: to, ...stamps } });
  if (r.count !== 1) throw new UserError("The order changed while you were looking. Reload and try again.");
  let told = "";
  if (to === "READY" && o.customerId && (await moduleOn(user.shopId, "marketing"))) {
    const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true } });
    const body = `Hi ${firstName(o.name)}, your order (${o.title}, #${o.number}) is ready to pick up at ${shop.name}.${shop.phone ? ` Questions? Call ${shop.phone}.` : ""}`;
    const q = await db.$transaction((tx) =>
      queueToCustomer(tx, {
        shopId: user.shopId,
        customerId: o.customerId!,
        kind: "order_notice",
        channels: "preferred",
        content: (ch) => (ch === "email" ? { subject: `Your order is ready`, body } : { body }),
        dedupeKey: `decor:${o.id}:ready:${at.toISOString().slice(0, 10)}`,
        refType: "decor_order",
        refId: o.id,
        byUserId: user.id,
      }),
    );
    told = q.queued.length ? " The customer is told it's ready." : " The customer couldn't be messaged: call them.";
  }
  return `Order #${o.number} is ${decorStatusLabel(to).toLowerCase()}.${told}`;
}

/** The shop won't make it (a copied logo, a trademark it can't use): turned down with the reason, kept as a record. */
export async function turnDownOrderFor(user: CurrentUser, id: string, why: string): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const o = await ownOrder(user.shopId, id);
  const reason = String(why ?? "").trim().slice(0, 300);
  if (!reason) throw new UserError("Say why, in a few words (the customer may ask).");
  if (!["QUOTED", "APPROVED"].includes(o.status)) throw new UserError(`An order that is ${decorStatusLabel(o.status).toLowerCase()} can't be turned down.`);
  const r = await db.decorOrder.updateMany({ where: { id: o.id, shopId: user.shopId, status: o.status }, data: { status: "TURNED_DOWN", turnedDownWhy: reason, closedAt: new Date() } });
  if (r.count !== 1) throw new UserError("The order changed while you were looking. Reload and try again.");
  return `Order #${o.number} is turned down.`;
}

/**
 * The customer picks it up and pays: the order is billed as a register sale from the parts kept when it was priced
 * (garments, each decoration, digitizing, set-up; taxed at the shop's rate if taxable) and marked collected.
 */
export async function collectOrderFor(user: CurrentUser, id: string, fd: FormData | null): Promise<string> {
  const shopId = user.shopId;
  await requireModule(user, "decorating");
  const o = await db.decorOrder.findFirst({ where: { id: assertId(id), shopId }, include: { lines: { orderBy: { sortOrder: "asc" } }, placements: { orderBy: { sortOrder: "asc" }, omit: { fileData: true } } } });
  if (!o) throw new UserError("Order not found.");
  const asked = String(fd?.get("method") ?? "CASH");
  const method: TenderMethod = (TENDER_METHODS as string[]).includes(asked) ? (asked as TenderMethod) : "CASH";
  const at = new Date();
  const claimed = await db.decorOrder.updateMany({ where: { id: o.id, shopId, status: "READY", saleId: null }, data: { status: "COLLECTED", collectedAt: at, closedAt: at } });
  if (claimed.count !== 1) throw new UserError(o.status === "READY" ? "That order was just collected." : `Only a ready order can be collected (this one is ${decorStatusLabel(o.status).toLowerCase()}).`);
  try {
    if (o.quoteCents <= 0) return `Order #${o.number} is collected (no charge).`;
    const pieces = o.lines.reduce((s, l) => s + l.qty, 0);
    const lines = [
      ...o.lines.filter((l) => l.garmentCents > 0).map((l) => ({ description: `${l.description}${l.color ? `, ${l.color}` : ""} (order #${o.number})`.slice(0, 200), qty: l.qty, unitPriceCents: l.garmentCents, taxable: o.taxable })),
      ...o.placements.filter((p) => p.quotedEachCents > 0).map((p) => ({ description: `Embroidery, ${p.location.toLowerCase()}${p.stitches ? `, ${p.stitches.toLocaleString("en-US")} stitches` : ""} (order #${o.number})`.slice(0, 200), qty: pieces, unitPriceCents: p.quotedEachCents, taxable: o.taxable })),
      ...(o.digitizingCents > 0 ? [{ description: `Digitizing, order #${o.number}`, qty: 1, unitPriceCents: o.digitizingCents, taxable: o.taxable }] : []),
      ...(o.setupCents > 0 ? [{ description: `Set-up, order #${o.number}`, qty: 1, unitPriceCents: o.setupCents, taxable: o.taxable }] : []),
    ];
    const billed = lines.reduce((s, l) => s + l.qty * l.unitPriceCents, 0);
    if (billed !== o.quoteCents) throw new UserError(`Order #${o.number}'s parts add up to ${money(billed)} but it was priced at ${money(o.quoteCents)}. Work the price out again and try once more.`);
    const sale = await completeSaleAs(user, { customerId: o.customerId, lines, tenders: [], note: `Decorating order #${o.number}`, clientKey: `decor-${o.id}-${at.getTime()}` }, { tenderExact: { method, amountCents: 0, note: null } });
    await db.decorOrder.updateMany({ where: { id: o.id, shopId }, data: { saleId: sale.saleId } });
    return `Order #${o.number} is collected: sale #${sale.number} in the register.`;
  } catch (e) {
    // Nothing was billed: it is still waiting on the shelf.
    await db.decorOrder.updateMany({ where: { id: o.id, shopId, status: "COLLECTED", saleId: null }, data: { status: "READY", collectedAt: null, closedAt: null } });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

export type OrderRow = { id: string; number: number; name: string; customerId: string | null; title: string; status: string; quoteCents: number; dueAt: Date | null; createdAt: Date; overdue: boolean; pieces: number };

/** Open orders first (soonest due), then the latest closed ones. */
export async function ordersFor(shopId: string, o: { closed?: boolean; take?: number } = {}, now = new Date()): Promise<OrderRow[]> {
  const rows = await db.decorOrder.findMany({
    where: { shopId, status: o.closed ? { in: ["COLLECTED", "CANCELLED", "TURNED_DOWN"] } : { in: OPEN_DECOR } },
    select: { id: true, number: true, name: true, customerId: true, title: true, status: true, quoteCents: true, dueAt: true, createdAt: true, lines: { select: { qty: true } } },
    orderBy: o.closed ? [{ number: "desc" }] : [{ dueAt: { sort: "asc", nulls: "last" } }, { number: "asc" }],
    take: o.take ?? 200,
  });
  return rows.map(({ lines, ...r }) => ({ ...r, pieces: lines.reduce((s, l) => s + l.qty, 0), overdue: !!r.dueAt && r.status !== "READY" && r.dueAt.getTime() < now.getTime() }));
}

export type ProductionRow = { id: string; number: number; name: string; title: string; status: string; dueAt: Date | null; overdue: boolean; pieces: number; minutes: number; stitches: number; placements: number };

/**
 * The production list: orders that are approved or in production, soonest due first, with the machine time each needs at the
 * shop's set speed (every placement, on every piece) and the total queued. A placement with no stitch count (an agreed price
 * only) counts no time.
 */
export async function productionFor(shopId: string, now = new Date()): Promise<{ rows: ProductionRow[]; totalMinutes: number; lateCount: number }> {
  const [orders, prices] = await Promise.all([
    db.decorOrder.findMany({
      where: { shopId, status: { in: ["APPROVED", "IN_PRODUCTION"] } },
      select: { id: true, number: true, name: true, title: true, status: true, dueAt: true, lines: { select: { qty: true } }, placements: { select: { stitches: true, colors: true } } },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { number: "asc" }],
      take: 300,
    }),
    decorPrices(shopId),
  ]);
  const rows = orders.map((o) => {
    const pieces = o.lines.reduce((t, l) => t + l.qty, 0);
    const minutes = o.placements.reduce((t, p) => t + runMinutes(p.stitches, p.colors, prices), 0) * pieces;
    return {
      id: o.id,
      number: o.number,
      name: o.name,
      title: o.title,
      status: o.status,
      dueAt: o.dueAt,
      overdue: !!o.dueAt && o.dueAt.getTime() < now.getTime(),
      pieces,
      minutes,
      stitches: o.placements.reduce((t, p) => t + p.stitches, 0) * pieces,
      placements: o.placements.length,
    };
  });
  return { rows, totalMinutes: rows.reduce((t, r) => t + r.minutes, 0), lateCount: rows.filter((r) => r.overdue).length };
}

export async function orderView(shopId: string, id: string) {
  const o = await db.decorOrder.findFirst({ where: { id, shopId }, include: { lines: { orderBy: { sortOrder: "asc" } }, placements: { orderBy: { sortOrder: "asc" }, omit: { fileData: true } } } });
  if (!o) return null;
  const [prices, fileIds, sale] = await Promise.all([
    decorPrices(shopId),
    db.decorPlacement.findMany({ where: { orderId: o.id, shopId, fileData: { not: null } }, select: { id: true } }),
    o.saleId ? db.sale.findFirst({ where: { id: o.saleId, shopId }, select: { id: true, number: true } }) : null,
  ]);
  const withFile = new Set(fileIds.map((f) => f.id));
  const pieces = o.lines.reduce((s, l) => s + l.qty, 0);
  const placements = o.placements.map((p) => ({ ...p, hasFile: withFile.has(p.id), runMinutesEach: runMinutes(p.stitches, p.colors, prices), tableEachCents: pieceCents(p.stitches, pieces, prices) }));
  const runTotal = placements.reduce((s, p) => s + p.runMinutesEach, 0) * pieces;
  return { ...o, placements, pieces, garmentCents: o.lines.reduce((s, l) => s + l.qty * l.garmentCents, 0), runMinutesTotal: runTotal, sale };
}
