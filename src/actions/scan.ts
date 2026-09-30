"use server";

// The barcode scanner station: look a part up, receive it, put it on a ticket, or count the shelf.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { OPEN_STATUSES } from "@/lib/constants";
import { numberKey } from "@/lib/parts";
import { assertId, sameText } from "@/lib/input";

export type ScannedPart = {
  id: string;
  partNumber: string;
  description: string;
  brand: string | null;
  qtyOnHand: number;
  location: string | null;
  priceCents: number | null;
  unit: string | null;
  consigned?: boolean;
};
export type ScanResult =
  | { ok: true; part: ScannedPart; message: string }
  | { ok: false; code: string; message: string; xpart?: { id: string; name: string } | null };

/** The item a code means: the exact number first, and the shop's own stock before a partner's consigned stock. */
async function findPart(shopId: string, code: string) {
  const key = numberKey(code);
  const matches = await db.part.findMany({
    where: { shopId, OR: [{ partNumber: sameText(code) }, ...(key.length >= 3 ? [{ numberKeys: { has: key } }] : [])] },
    take: 20,
  });
  const rank = (p: (typeof matches)[number]) => (p.consignLinkId ? 2 : 0) + (p.partNumber.toLowerCase() === code.toLowerCase() ? 0 : 1);
  return matches.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

const view = (p: Omit<ScannedPart, "consigned"> & { consignLinkId: string | null }): ScannedPart => ({
  unit: p.unit,
  consigned: Boolean(p.consignLinkId),
  id: p.id,
  partNumber: p.partNumber,
  description: p.description,
  brand: p.brand,
  qtyOnHand: p.qtyOnHand,
  location: p.location,
  priceCents: p.priceCents,
});

export async function scanCode(code: string, mode: "lookup" | "receive" | "ticket", qty = 1, ticketId?: string): Promise<ScanResult> {
  if (ticketId) assertId(ticketId);
  const user = await requireUser();
  const c = String(code ?? "").trim();
  if (!c) return { ok: false, code: c, message: "Nothing scanned." };
  const part = await findPart(user.shopId, c);
  if (!part) {
    const key = numberKey(c);
    const xpart = key.length >= 3 ? await db.xPart.findFirst({ where: { numberKeys: { has: key } }, select: { id: true, name: true } }) : null;
    return { ok: false, code: c, xpart, message: xpart ? `Not in your parts, but the cross-reference knows it: ${xpart.name}` : `${c} isn't in your parts.` };
  }
  // Whole pieces, or yards to the eighth for fabric.
  const n = part.unit === "yd" ? Math.max(0.125, Math.min(999, Math.round((Number(qty) || 1) * 1000) / 1000)) : Math.max(1, Math.min(999, Math.round(qty) || 1));
  if (part.consignLinkId && mode !== "lookup") {
    return { ok: false, code: c, message: `${part.partNumber} is a partner's consigned stock: sell it at the register (it isn't received or used here).` };
  }
  if (mode === "receive") {
    const [p] = await db.$transaction([
      db.part.update({ where: { id: part.id }, data: { qtyOnHand: { increment: n } } }),
      db.stockMove.create({ data: { shopId: user.shopId, partId: part.id, qty: n, reason: "RECEIVED", userId: user.id, note: "Scanned in" } }),
    ]);
    revalidatePath("/parts", "layout");
    return { ok: true, part: view(p), message: `+${n} received: ${part.partNumber} (now ${p.qtyOnHand})` };
  }
  if (mode === "ticket") {
    const t = ticketId
      ? await db.ticket.findFirst({ where: { id: ticketId, shopId: user.shopId, status: { in: OPEN_STATUSES } }, include: { shop: { select: { partsMarkupPct: true } } } })
      : null;
    if (!t) return { ok: false, code: c, message: "Pick an open ticket first." };
    const unit = part.priceCents ?? Math.round((part.costCents ?? 0) * (1 + t.shop.partsMarkupPct / 100));
    const [, p] = await db.$transaction([
      db.ticketLine.create({ data: { ticketId: t.id, kind: "PART", description: `${part.partNumber} ${part.description}`, qty: n, unitPriceCents: unit, partId: part.id } }),
      db.part.update({ where: { id: part.id }, data: { qtyOnHand: { decrement: n } } }),
      db.stockMove.create({ data: { shopId: user.shopId, partId: part.id, qty: -n, reason: "USED", ticketId: t.id, userId: user.id } }),
    ]);
    revalidatePath(`/tickets/${t.id}`);
    revalidatePath("/parts", "layout");
    return { ok: true, part: view(p), message: `${n} × ${part.partNumber} added to ticket #${String(t.number).padStart(4, "0")} (${p.qtyOnHand} left)` };
  }
  return { ok: true, part: view(part), message: `${part.partNumber}: ${part.qtyOnHand} on hand${part.location ? `, bin ${part.location}` : ""}` };
}

/** A shelf count done by scanning: set each counted part to what was scanned. */
export async function saveCounts(counts: { partId: string; qty: number }[]): Promise<{ saved: number } | { error: string }> {
  const user = await requireUser();
  if (!Array.isArray(counts)) return { error: "Nothing to save." };
  let saved = 0;
  for (const c of counts.slice(0, 2000)) {
    if (typeof c?.partId !== "string" || !c.partId) continue;
    const p = await db.part.findFirst({ where: { id: c.partId, shopId: user.shopId } });
    // Fabric isn't counted by scanning bolts, and a partner's consigned stock is counted by the partner.
    if (!p || p.unit === "yd" || p.consignLinkId) continue;
    const n = Math.max(0, Math.round(c.qty));
    if (p.qtyOnHand === n) continue;
    await db.$transaction([
      db.part.update({ where: { id: p.id }, data: { qtyOnHand: n } }),
      db.stockMove.create({ data: { shopId: user.shopId, partId: p.id, qty: n - p.qtyOnHand, reason: "ADJUSTED", userId: user.id, note: "Scanned shelf count" } }),
    ]);
    saved++;
  }
  revalidatePath("/parts", "layout");
  return { saved };
}
