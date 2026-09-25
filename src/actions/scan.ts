"use server";

// The barcode scanner station: look a part up, receive it, put it on a ticket, or count the shelf.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { OPEN_STATUSES } from "@/lib/constants";
import { numberKey } from "@/lib/parts";

export type ScannedPart = { id: string; partNumber: string; description: string; brand: string | null; qtyOnHand: number; location: string | null; priceCents: number | null };
export type ScanResult =
  | { ok: true; part: ScannedPart; message: string }
  | { ok: false; code: string; message: string; xpart?: { id: string; name: string } | null };

async function findPart(shopId: string, code: string) {
  const key = numberKey(code);
  return (
    (await db.part.findFirst({ where: { shopId, partNumber: { equals: code, mode: "insensitive" } } })) ??
    (key.length >= 3 ? await db.part.findFirst({ where: { shopId, numberKeys: { has: key } } }) : null)
  );
}

const view = (p: { id: string; partNumber: string; description: string; brand: string | null; qtyOnHand: number; location: string | null; priceCents: number | null }): ScannedPart => ({
  id: p.id,
  partNumber: p.partNumber,
  description: p.description,
  brand: p.brand,
  qtyOnHand: p.qtyOnHand,
  location: p.location,
  priceCents: p.priceCents,
});

export async function scanCode(code: string, mode: "lookup" | "receive" | "ticket", qty = 1, ticketId?: string): Promise<ScanResult> {
  const user = await requireUser();
  const c = code.trim();
  if (!c) return { ok: false, code: c, message: "Nothing scanned." };
  const part = await findPart(user.shopId, c);
  if (!part) {
    const key = numberKey(c);
    const xpart = key.length >= 3 ? await db.xPart.findFirst({ where: { numberKeys: { has: key } }, select: { id: true, name: true } }) : null;
    return { ok: false, code: c, xpart, message: xpart ? `Not in your parts, but the cross-reference knows it: ${xpart.name}` : `${c} isn't in your parts.` };
  }
  const n = Math.max(1, Math.min(999, Math.round(qty) || 1));
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
  let saved = 0;
  for (const c of counts.slice(0, 2000)) {
    const n = Math.max(0, Math.round(c.qty));
    const p = await db.part.findFirst({ where: { id: c.partId, shopId: user.shopId } });
    if (!p || p.qtyOnHand === n) continue;
    await db.$transaction([
      db.part.update({ where: { id: p.id }, data: { qtyOnHand: n } }),
      db.stockMove.create({ data: { shopId: user.shopId, partId: p.id, qty: n - p.qtyOnHand, reason: "ADJUSTED", userId: user.id, note: "Scanned shelf count" } }),
    ]);
    saved++;
  }
  revalidatePath("/parts", "layout");
  return { saved };
}
