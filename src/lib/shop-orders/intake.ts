import "server-only";
// Taking an order from MakerFoundry into a decorating order (docs/plans/makerfoundry-orders-plan.md package 3). The hub has delivered an
// `order.placed` whose body has been checked against its version (contract.ts). Here it becomes a DecorOrder: QUOTED, already paid, its
// price the customer's total as paid (never re-worked from the shop's price table), and `received` goes back in the same transaction.
// The customer's art is fetched afterwards, one file at a time, by a short-lived signed address, and checked against the size and
// SHA-256 in the order before it is used (as the StitchFoundry inbox does); a failure is tried again later and never leaves half an order.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { imageType } from "@/lib/decor";
import { readEmbroidery, formatOf } from "@/lib/embroidery-file";
import { checkBucketUrl } from "@/lib/offsite/hub-store";
import { splitList } from "@/lib/shop-orders/catalog";
import { MAX_ART_BYTES, MAX_PREVIEW_BYTES, type OrderPlaced } from "@/lib/shop-orders/contract";
import { backoff, plain, v2 } from "@/lib/shop-orders/hubv2";
import { enqueue } from "@/lib/shop-orders/outbox";
import type { MessageContext } from "@/lib/shop-orders/handlers";
import type { Prisma } from "@/generated/prisma/client";

const MAX_LINES = 60;
const MAX_PLACEMENTS = 12;
const METHOD = { embroidery: "EMBROIDERY", screen_print: "SCREEN_PRINT" } as const;

const LADDER = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL", "5XL"];
/**
 * "M 4, L 2": the sizes as the shop types them, smallest first. (The queue stores a message as JSON that does not keep the order keys
 * were sent in, so the order comes from the shop's own list for the garment, then the usual ladder, then the name.)
 */
export const sizesText = (sizes: Record<string, number>, order: string[] = []): string => {
  const rank = (k: string) => {
    const mine = order.findIndex((x) => x.toLowerCase() === k.toLowerCase());
    if (mine >= 0) return mine;
    const lad = LADDER.indexOf(k.toUpperCase());
    return lad >= 0 ? 1000 + lad : 2000;
  };
  return Object.entries(sizes)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
};

/**
 * The order as a DecorOrder. Idempotent: the same order reference twice is one order (a unique key on the company and the reference), so a
 * message applied again after a crash does nothing. Returns the order's id.
 */
export async function takeOrder(c: MessageContext, files?: Map<string, Uint8Array<ArrayBuffer>>): Promise<string> {
  const o = c.body as OrderPlaced;
  const shopId = c.shopId;
  const existing = await db.decorOrder.findFirst({ where: { shopId, onlineRef: c.conversation }, select: { id: true } });
  if (existing) return existing.id;

  const skus = [...new Set(o.lines.map((l) => l.sku))];
  const products = await db.onlineProduct.findMany({ where: { shopId, sku: { in: skus } } });
  const nameOf = new Map(products.map((p) => [p.sku, p.name]));
  const sizeOrder = new Map(products.map((p) => [p.sku, splitList(p.sizes, 20)]));

  const lines = o.lines.slice(0, MAX_LINES).map((l, i) => ({
    sortOrder: i,
    description: (nameOf.get(l.sku) ?? l.sku).slice(0, 120),
    color: l.colour.slice(0, 40),
    sizes: sizesText(l.sizes, sizeOrder.get(l.sku)).slice(0, 200),
    qty: Object.values(l.sizes).reduce((s, n) => s + n, 0),
  }));

  // A decoration in the order belongs to a line; a DecorOrder's decorations go on every piece. The union is kept (each distinct
  // method, place and design once), and a line that has only some of them says so in the order's note.
  const placements = new Map<string, { location: string; method: "EMBROIDERY" | "SCREEN_PRINT"; fileName: string; sha: string; size: number; onLines: number[] }>();
  o.lines.forEach((l, i) => {
    for (const d of l.decorations) {
      const key = `${d.method}|${d.placement}|${d.art.sha256}`;
      const p = placements.get(key) ?? { location: d.placement.slice(0, 40), method: METHOD[d.method], fileName: d.art.file, sha: d.art.sha256, size: d.art.size, onLines: [] };
      p.onLines.push(i);
      placements.set(key, p);
    }
  });
  const all = [...placements.values()];
  const kept = all.slice(0, MAX_PLACEMENTS);
  const notes: string[] = [];
  if (o.note) notes.push(`Customer's note: ${o.note}`);
  if (o.lines.length > 1 && all.some((p) => p.onLines.length !== o.lines.length)) {
    notes.push(`Not every line has every decoration: ${all.map((p) => `${p.location} (${p.fileName}) on ${p.onLines.map((i) => `line ${i + 1}`).join(", ")}`).join("; ")}.`);
  }
  if (all.length > kept.length) notes.push(`${all.length - kept.length} more decorations than fit on one order were left out: see the customer's order on MakerFoundry.`);
  if (o.lines.length > lines.length) notes.push(`${o.lines.length - lines.length} more lines than fit on one order were left out.`);

  const title = `Online order ${c.conversation.slice(-8)}: ${lines[0]?.description ?? "garments"}${lines.length > 1 ? ` and ${lines.length - 1} more` : ""}`.slice(0, 120);
  const t = o.totals;
  const id = await db.$transaction(async (tx) => {
    const sh = await tx.shop.update({ where: { id: shopId }, data: { nextDecorOrderNumber: { increment: 1 } }, select: { nextDecorOrderNumber: true } });
    const made = await tx.decorOrder.create({
      data: {
        shopId,
        number: sh.nextDecorOrderNumber - 1,
        name: o.customer.name.slice(0, 120),
        title,
        status: "QUOTED",
        note: notes.join("\n").slice(0, 1000) || null,
        // Tax on physical goods is still the owner's to decide: kept as paid, not taxed again here.
        taxable: false,
        quoteCents: t.goods_cents + t.setup_cents,
        setupCents: t.setup_cents,
        source: "MAKERFOUNDRY",
        onlineRef: c.conversation,
        paidCents: t.paid_cents,
        shopGetsCents: t.shop_gets_cents,
        feeCents: t.fee_cents,
        cardFeeCents: t.card_fee_cents,
        shippingPaidCents: t.shipping_cents,
        taxPaidCents: t.tax_cents,
        fulfilment: o.fulfilment === "ship" ? "SHIP" : "PICKUP",
        shipTo: o.fulfilment === "ship" && o.customer.ship_to ? (o.customer.ship_to as Prisma.InputJsonValue) : undefined,
        previewSha256: o.preview?.sha256 ?? null,
        previewSize: o.preview?.size ?? null,
        lines: { create: lines.map((l) => ({ shopId, ...l, garmentCents: 0 })) },
        placements: {
          create: kept.map((p, i) => ({
            shopId,
            sortOrder: i,
            location: p.location,
            method: p.method,
            colors: 1,
            fileName: p.fileName,
            fileFormat: formatOf(p.fileName),
            artSha256: p.sha,
            artSize: p.size,
            note: o.lines.length > 1 && p.onLines.length !== o.lines.length ? `On ${p.onLines.map((n) => `line ${n + 1}`).join(", ")}`.slice(0, 300) : null,
          })),
        },
      },
      select: { id: true },
    });
    // Told in the same transaction: an order the shop has is an order the customer is told the shop has.
    await enqueue(tx, shopId, { conversation: c.conversation, type: "order.status", body: { status: "received" } });
    return made.id;
  });
  // The files come after, and never undo the order: a failure is kept on it and tried again.
  await fetchOrderFiles(shopId, id, files).catch(() => {});
  return id;
}

// ---------------------------------------------------------------------------------------------------------------
// the customer's files

async function download(shopId: string, conversation: string, sha256: string, size: number, max: number, given?: Map<string, Uint8Array<ArrayBuffer>>): Promise<Uint8Array<ArrayBuffer>> {
  // The demo's simulated orders bring their files with them (there is no hub to ask); they are checked just the same.
  const have = given?.get(sha256);
  if (have) {
    if (have.length !== size || have.length > max || crypto.createHash("sha256").update(have).digest("hex") !== sha256) throw new Error("The file isn't the one the order named.");
    return have;
  }
  const a = (await (await v2(shopId, "/v2/files/get", { method: "POST", json: { conversation, sha256 } })).json()) as { url?: unknown; size?: unknown };
  if (typeof a.size === "number" && a.size !== size) throw new Error("The hub says the file is a different size than the order does, so it wasn't used.");
  const r = await fetch(checkBucketUrl(a.url), { redirect: "manual", signal: AbortSignal.timeout(2 * 60_000) });
  if (!r.ok) throw new Error(`The file store didn't give the file (${r.status}).`);
  const len = Number(r.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) throw new Error("The file is bigger than the order said, so it wasn't used.");
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length !== size || crypto.createHash("sha256").update(buf).digest("hex") !== sha256) throw new Error("What came back isn't the file the order named (its size or checksum is different), so it wasn't used.");
  return buf;
}

/**
 * Fetches what an online order is still missing: each design file and the customer's picture. Each is checked against the order before it is
 * kept. A design bigger than the shop's offer covers is flagged on the order for the shop to read (turning it down is the shop's call).
 * Errors are kept on the order with a retry time; what already arrived stays.
 */
export async function fetchOrderFiles(shopId: string, orderId: string, given?: Map<string, Uint8Array<ArrayBuffer>>): Promise<{ fetched: number; failed: number }> {
  const o = await db.decorOrder.findFirst({
    where: { id: orderId, shopId, source: "MAKERFOUNDRY" },
    select: { id: true, onlineRef: true, previewSha256: true, previewSize: true, mockupName: true, fileTries: true, placements: { select: { id: true, location: true, method: true, fileName: true, artSha256: true, artSize: true, fileFormat: true, fileData: false }, orderBy: { sortOrder: "asc" } } },
  });
  if (!o?.onlineRef) return { fetched: 0, failed: 0 };
  const have = await db.decorPlacement.findMany({ where: { orderId, shopId, fileData: { not: null } }, select: { id: true } });
  const done = new Set(have.map((h) => h.id));
  const offers = await db.onlineOffer.findMany({ where: { shopId } });
  const cache = new Map<string, Uint8Array<ArrayBuffer>>();
  let fetched = 0;
  let failed = 0;
  let lastError: string | null = null;
  const flags: string[] = [];
  for (const p of o.placements) {
    if (done.has(p.id) || !p.artSha256 || !p.artSize) continue;
    try {
      let buf = cache.get(p.artSha256);
      if (!buf) {
        buf = await download(shopId, o.onlineRef, p.artSha256, p.artSize, MAX_ART_BYTES, given);
        cache.set(p.artSha256, buf);
      }
      const info = p.method === "EMBROIDERY" ? readEmbroidery(p.fileName ?? "", buf) : null;
      await db.decorPlacement.updateMany({
        where: { id: p.id, shopId },
        data: {
          fileData: buf,
          fileReadable: !!info?.readable,
          fileFormat: info?.format ?? p.fileFormat,
          ...(info?.readable ? { stitches: info.stitches ?? 0, colors: Math.max(1, info.colors ?? 1), widthMm: info.widthMm, heightMm: info.heightMm } : {}),
        },
      });
      fetched += 1;
      const offer = offers.find((x) => x.method.toUpperCase() === p.method && x.placement.toLowerCase() === p.location.toLowerCase());
      if (info?.readable && offer?.maxStitches && (info.stitches ?? 0) > offer.maxStitches) {
        flags.push(`${p.location}: the design has ${(info.stitches ?? 0).toLocaleString("en-US")} stitches; your offer covers up to ${offer.maxStitches.toLocaleString("en-US")}. Turn the order down for a full refund, or make it anyway.`);
      }
    } catch (e) {
      failed += 1;
      lastError = plain(e);
    }
  }
  if (o.previewSha256 && o.previewSize && !o.mockupName) {
    try {
      const buf = await download(shopId, o.onlineRef, o.previewSha256, o.previewSize, MAX_PREVIEW_BYTES, given);
      const mime = imageType(buf);
      // The customer's picture is a nicety: one that isn't a PNG or JPEG is simply not used.
      if (mime) await db.decorOrder.updateMany({ where: { id: orderId, shopId, mockupData: null }, data: { mockupName: "customer-preview", mockupMime: mime, mockupData: buf } });
      await db.decorOrder.updateMany({ where: { id: orderId, shopId }, data: { previewSha256: null, previewSize: null } });
      fetched += 1;
    } catch (e) {
      failed += 1;
      lastError = plain(e);
    }
  }
  await db.decorOrder.updateMany({
    where: { id: orderId, shopId },
    data: failed ? { fileTries: { increment: 1 }, fileError: lastError, filesNextTryAt: backoff(o.fileTries + 1) } : { fileError: null, filesNextTryAt: null },
  });
  if (flags.length) {
    const cur = await db.decorOrder.findUniqueOrThrow({ where: { id: orderId }, select: { onlineFlag: true } });
    await db.decorOrder.updateMany({ where: { id: orderId, shopId }, data: { onlineFlag: [cur.onlineFlag, ...flags].filter(Boolean).join("\n").slice(0, 600) } });
  }
  return { fetched, failed };
}

/** Orders still missing files whose retry time has come, a few at a time (called on every sync round). */
export async function retryPendingFiles(shopId: string): Promise<void> {
  const now = new Date();
  const due = await db.decorOrder.findMany({
    where: {
      shopId,
      source: "MAKERFOUNDRY",
      OR: [{ filesNextTryAt: null }, { filesNextTryAt: { lte: now } }],
      AND: [{ OR: [{ previewSha256: { not: null }, mockupData: null }, { placements: { some: { artSha256: { not: null }, fileData: null } } }] }],
      status: { in: ["QUOTED", "APPROVED", "IN_PRODUCTION", "READY"] },
    },
    select: { id: true },
    take: 5,
  });
  for (const d of due) await fetchOrderFiles(shopId, d.id).catch(() => {});
}
