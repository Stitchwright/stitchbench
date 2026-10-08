import "server-only";
// Stock between stores (shop-features-round-2-design.md 7.2, 7.3 and 7.7). A transfer is SENT by the store that has the
// stock (off its shelf at once, a TRANSFER move there) and ARRIVED when the other store taps "It arrived" (onto its
// shelf, a TRANSFER move there; counts corrected on arrival are an adjustment there). A request is the same row in
// ASKED: the asking store names what it wants, the other store sends it ("Send it") or says it can't ("Can't this
// time", with a reason). Stock on its way is on no shelf, and shows as "on the way" on both stores' pages, so nothing
// is lost in between. A request for a customer holds the stock at the sending store from the start (a HELD move), and
// on arrival her special order is here and she hears it. Machines for sale move with the same transfer (their store
// changes when sent). Every query by shopId.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { actorOf, audit } from "@/lib/audit";
import { activeStores, currentStore, storesOf, type Store } from "@/lib/stores";
import { moveStock, storeQty, takeStockIfThere } from "@/lib/stock";
import { inEighths, qtyText } from "@/lib/register-math";
import { pushEvent, unitDescription } from "@/lib/units/units";

type Tx = Prisma.TransactionClient;

export type TransferLineIn = { partId?: string | null; unitId?: string | null; qty?: number };

export type TransferView = {
  id: string;
  number: number;
  status: string;
  from: { id: string; name: string };
  to: { id: string; name: string };
  note: string | null;
  neededBy: string | null;
  declineReason: string | null;
  forCustomer: { id: string; name: string } | null;
  specialOrderId: string | null;
  poId: string | null;
  askedAt: Date | null;
  sentAt: Date | null;
  arrivedAt: Date | null;
  lines: { id: string; partId: string | null; unitId: string | null; description: string; unit: string | null; qty: number; qtySent: number | null; qtyArrived: number | null }[];
};

export const TRANSFER_STATUS_LABEL: Record<string, string> = { ASKED: "Asked for", SENT: "On the way", ARRIVED: "Arrived", CANCELLED: "Cancelled", DECLINED: "Can't send" };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

async function storePair(shopId: string, fromId: string, toId: string): Promise<{ from: Store; to: Store }> {
  const stores = await activeStores(shopId);
  const from = stores.find((s) => s.id === fromId);
  const to = stores.find((s) => s.id === toId);
  if (!from || !to) throw new UserError("Store not found.");
  if (from.id === to.id) throw new UserError("Pick the other store.");
  return { from, to };
}

/** The lines as the database has them: this company's items (not a partner's consigned stock), quantities checked. */
async function cleanLines(shopId: string, lines: TransferLineIn[]): Promise<{ partId: string | null; unitId: string | null; description: string; unit: string | null; qty: number }[]> {
  if (!Array.isArray(lines) || !lines.length) throw new UserError("Pick what to send: an item and how many.");
  if (lines.length > 200) throw new UserError("200 lines at most on one transfer.");
  const out: { partId: string | null; unitId: string | null; description: string; unit: string | null; qty: number }[] = [];
  for (const l of lines) {
    if (l?.unitId) {
      const u = await db.stockUnit.findFirst({ where: { id: String(l.unitId), shopId }, include: { machine: true } });
      if (!u) throw new UserError("That machine isn't one of yours.");
      if (u.status !== "IN_STOCK") throw new UserError(`${unitDescription(u)} isn't in stock (sold or held).`);
      out.push({ partId: null, unitId: u.id, description: unitDescription(u), unit: null, qty: 1 });
      continue;
    }
    const part = l?.partId ? await db.part.findFirst({ where: { id: String(l.partId), shopId }, select: { id: true, partNumber: true, description: true, unit: true, kind: true, consignLinkId: true } }) : null;
    if (!part) throw new UserError("Pick an item from your inventory.");
    if (part.consignLinkId) throw new UserError(`${part.partNumber} is a partner's consigned stock: it stays where the partner placed it.`);
    if (part.kind === "MACHINE") throw new UserError(`${part.partNumber} is a machine model: send the machines themselves (Machines for sale).`);
    const qty = r3(Number(l.qty));
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100_000) throw new UserError(`${part.partNumber}: how many?`);
    if (part.unit === "yd" ? !inEighths(qty) : !Number.isInteger(qty)) throw new UserError(part.unit === "yd" ? `${part.partNumber}: yards in eighths (2 3/8 is 2.375).` : `${part.partNumber}: a whole number.`);
    out.push({ partId: part.id, unitId: null, description: `${part.partNumber} ${part.description}`.slice(0, 200), unit: part.unit, qty });
  }
  return out;
}

/** Takes a line off the sending store's shelf (a part: only if it has that many; a machine: it moves store). */
async function takeLine(tx: Tx, user: Pick<CurrentUser, "id" | "name" | "shopId">, t: { id: string; number: number; fromId: string; toId: string }, l: { id: string; partId: string | null; unitId: string | null; description: string; qty: number }, names: { from: string; to: string }, reason: "TRANSFER" | "HELD", at: Date) {
  if (l.unitId) {
    const u = await tx.stockUnit.findFirst({ where: { id: l.unitId, shopId: user.shopId } });
    if (!u || u.status !== "IN_STOCK") throw new UserError(`${l.description} isn't in stock any more.`);
    const fromMain = (await storesOf(user.shopId)).find((s) => s.id === t.fromId)?.main ?? false;
    if (u.locationId !== t.fromId && !(fromMain && u.locationId == null)) throw new UserError(`${l.description} isn't at ${names.from}.`);
    await tx.stockUnit.updateMany({ where: { id: u.id, shopId: user.shopId, status: "IN_STOCK" }, data: { locationId: t.toId, events: pushEvent(u.events, { at: at.toISOString(), note: `Sent to ${names.to} (transfer ${t.number}, ${user.name})` }) } });
  } else if (l.partId) {
    const ok = await takeStockIfThere(tx, user.shopId, l.partId, t.fromId, l.qty);
    if (!ok) {
      const have = await storeQty(tx, user.shopId, l.partId, t.fromId);
      throw new UserError(`${l.description}: ${names.from} has ${have > 0 ? `only ${have}` : "none"}.`);
    }
    await tx.stockMove.create({ data: { shopId: user.shopId, partId: l.partId, locationId: t.fromId, qty: -l.qty, reason, userId: user.id, note: `${reason === "HELD" ? "Held to send" : "Sent"} to ${names.to} (transfer ${t.number})`, createdAt: at } });
  }
  await tx.stockTransferLine.update({ where: { id: l.id }, data: { qtySent: l.qty } });
}

/** Puts what left the sending store's shelf back on it (a cancel, or "Can't this time" on a held request). */
async function putBack(tx: Tx, user: Pick<CurrentUser, "id" | "shopId">, t: { number: number; fromId: string; lines: { partId: string | null; unitId: string | null; qtySent: number | null }[] }, why: string, at: Date) {
  for (const l of t.lines) {
    if (l.qtySent == null) continue;
    if (l.partId) await moveStock(tx, { shopId: user.shopId, partId: l.partId, locationId: t.fromId, qty: l.qtySent, reason: "TRANSFER", userId: user.id, note: `Transfer ${t.number} ${why}`, createdAt: at });
    if (l.unitId) await tx.stockUnit.updateMany({ where: { id: l.unitId, shopId: user.shopId, status: "IN_STOCK" }, data: { locationId: t.fromId } });
  }
}

async function nextNumber(tx: Tx, shopId: string): Promise<number> {
  const s = await tx.shop.update({ where: { id: shopId }, data: { nextTransferNumber: { increment: 1 } }, select: { nextTransferNumber: true } });
  return s.nextTransferNumber - 1;
}

/** "Send to another store": from this store (or the one named), off its shelf now; the other store taps It arrived. */
export async function sendStockFor(
  user: CurrentUser,
  a: { toId: string; fromId?: string | null; lines: TransferLineIn[]; note?: string | null; poId?: string | null },
  now = new Date(),
): Promise<{ id: string; number: number }> {
  const here = await currentStore(user);
  const fromId = a.fromId ?? here?.id ?? "";
  const { from, to } = await storePair(user.shopId, fromId, String(a.toId ?? ""));
  const lines = await cleanLines(user.shopId, a.lines);
  const t = await db.$transaction(async (tx) => {
    const number = await nextNumber(tx, user.shopId);
    const made = await tx.stockTransfer.create({
      data: { shopId: user.shopId, number, fromId: from.id, toId: to.id, status: "SENT", note: a.note?.trim().slice(0, 300) || null, poId: a.poId ?? null, sentById: user.id, sentAt: now, lines: { create: lines.map(({ unit, ...l }) => (void unit, l)) } },
      include: { lines: true },
    });
    for (const l of made.lines) await takeLine(tx, user, made, l, { from: from.name, to: to.name }, "TRANSFER", now);
    await audit(tx, actorOf(user), { action: "stock.transfer", subjectType: "StockTransfer", subjectId: made.id, subjectLabel: `Transfer ${number}: ${from.name} to ${to.name}` });
    return made;
  });
  return { id: t.id, number: t.number };
}

/**
 * "Ask <store> to send some" (7.7): a request from this store to the other. For a customer (`forCustomerId`, with her
 * special order) the stock is held at the other store from now (if it has it), so it isn't sold meanwhile.
 */
export async function askStockFor(
  user: CurrentUser,
  a: { fromId: string; lines: TransferLineIn[]; note?: string | null; neededBy?: string | null; forCustomerId?: string | null; specialOrderId?: string | null; saleId?: string | null },
  now = new Date(),
): Promise<{ id: string; number: number; held: boolean }> {
  const here = await currentStore(user);
  const { from, to } = await storePair(user.shopId, String(a.fromId ?? ""), here?.id ?? "");
  const lines = await cleanLines(user.shopId, a.lines);
  if (a.forCustomerId && !(await db.customer.findFirst({ where: { id: a.forCustomerId, shopId: user.shopId }, select: { id: true } }))) throw new UserError("Customer not found.");
  const neededBy = a.neededBy && /^\d{4}-\d{2}-\d{2}$/.test(a.neededBy) ? a.neededBy : null;
  return db.$transaction(async (tx) => {
    const number = await nextNumber(tx, user.shopId);
    const made = await tx.stockTransfer.create({
      data: {
        shopId: user.shopId,
        number,
        fromId: from.id,
        toId: to.id,
        status: "ASKED",
        note: a.note?.trim().slice(0, 300) || null,
        neededBy,
        forCustomerId: a.forCustomerId ?? null,
        specialOrderId: a.specialOrderId ?? null,
        saleId: a.saleId ?? null,
        askedById: user.id,
        askedAt: now,
        lines: { create: lines.map(({ unit, ...l }) => (void unit, l)) },
      },
      include: { lines: true },
    });
    // For her: held at the other store now when it has enough (otherwise the other store sees the request and decides).
    let held = false;
    if (a.forCustomerId) {
      held = true;
      for (const l of made.lines) {
        if (l.partId && (await storeQty(tx, user.shopId, l.partId, from.id)) + 1e-9 < l.qty) held = false;
      }
      if (held) for (const l of made.lines) await takeLine(tx, user, made, l, { from: from.name, to: to.name }, "HELD", now);
    }
    await audit(tx, actorOf(user), { action: "stock.transfer", subjectType: "StockTransfer", subjectId: made.id, subjectLabel: `Transfer ${number}: ${to.name} asks ${from.name}` });
    return { id: made.id, number, held };
  });
}

async function ownTransfer(shopId: string, id: string) {
  const t = typeof id === "string" ? await db.stockTransfer.findFirst({ where: { id, shopId }, include: { lines: true } }) : null;
  if (!t) throw new UserError("Transfer not found.");
  return t;
}

async function namesOf(shopId: string, t: { fromId: string; toId: string }) {
  const stores = await storesOf(shopId);
  return { from: stores.find((s) => s.id === t.fromId)?.name ?? "the other store", to: stores.find((s) => s.id === t.toId)?.name ?? "the other store" };
}

/** "Send it": the other store sends what was asked (or less: `qtys` by line id), off its shelf now. */
export async function sendAskedFor(user: CurrentUser, id: string, qtys: Record<string, number> = {}, now = new Date()): Promise<void> {
  const t = await ownTransfer(user.shopId, id);
  if (t.status !== "ASKED") throw new UserError(t.status === "SENT" ? "It was sent already." : "That request isn't open any more.");
  const names = await namesOf(user.shopId, t);
  await db.$transaction(async (tx) => {
    const claim = await tx.stockTransfer.updateMany({ where: { id: t.id, shopId: user.shopId, status: "ASKED" }, data: { status: "SENT", sentById: user.id, sentAt: now } });
    if (!claim.count) throw new UserError("That request just changed. Look again.");
    let any = false;
    for (const l of t.lines) {
      if (l.qtySent != null) {
        any = true;
        continue; // held for her when asked: already off the shelf
      }
      const want = qtys[l.id] != null ? r3(Number(qtys[l.id])) : l.qty;
      if (!Number.isFinite(want) || want < 0 || want > l.qty) throw new UserError(`${l.description}: send from 0 to ${l.qty}.`);
      if (want === 0) {
        await tx.stockTransferLine.update({ where: { id: l.id }, data: { qtySent: 0 } });
        continue;
      }
      any = true;
      await takeLine(tx, user, t, { ...l, qty: want }, names, "TRANSFER", now);
    }
    if (!any) throw new UserError("Nothing to send: use Can't this time instead.");
  });
}

/** "Can't this time" (the other store, with a one-line reason): anything held for her goes back on its shelf. */
export async function declineAskedFor(user: CurrentUser, id: string, reason: string | null, now = new Date()): Promise<void> {
  const t = await ownTransfer(user.shopId, id);
  if (t.status !== "ASKED") throw new UserError("That request isn't open any more.");
  await db.$transaction(async (tx) => {
    const r = await tx.stockTransfer.updateMany({ where: { id: t.id, shopId: user.shopId, status: "ASKED" }, data: { status: "DECLINED", declineReason: reason?.trim().slice(0, 200) || "No reason given", cancelledAt: now } });
    if (!r.count) throw new UserError("That request just changed. Look again.");
    await putBack(tx, user, t, "not sent", now);
  });
}

/** Cancel a request or a transfer on its way: what left the sending store goes back on its shelf. */
export async function cancelTransferFor(user: CurrentUser, id: string, now = new Date()): Promise<void> {
  const t = await ownTransfer(user.shopId, id);
  if (t.status !== "ASKED" && t.status !== "SENT") throw new UserError("That transfer is finished already.");
  await db.$transaction(async (tx) => {
    const r = await tx.stockTransfer.updateMany({ where: { id: t.id, shopId: user.shopId, status: t.status }, data: { status: "CANCELLED", cancelledAt: now } });
    if (!r.count) throw new UserError("That transfer just changed. Look again.");
    await putBack(tx, user, t, "cancelled", now);
  });
}

/**
 * "It arrived" (the receiving store): onto its shelf. `counts` (by line id) are what was really in the box: a difference
 * from what was sent is recorded at the receiving store as an adjustment. A request for a customer: her special order
 * is here and held, and she hears it (as with special orders).
 */
export async function arrivedTransferFor(user: CurrentUser, id: string, counts: Record<string, number> = {}, now = new Date()): Promise<string> {
  const t = await ownTransfer(user.shopId, id);
  if (t.status !== "SENT") throw new UserError(t.status === "ARRIVED" ? "It's marked arrived already." : "That transfer isn't on its way.");
  const names = await namesOf(user.shopId, t);
  let short = 0;
  await db.$transaction(async (tx) => {
    const claim = await tx.stockTransfer.updateMany({ where: { id: t.id, shopId: user.shopId, status: "SENT" }, data: { status: "ARRIVED", arrivedById: user.id, arrivedAt: now } });
    if (!claim.count) throw new UserError("That transfer just changed. Look again.");
    for (const l of t.lines) {
      const sent = l.qtySent ?? 0;
      const got = counts[l.id] != null ? r3(Number(counts[l.id])) : sent;
      if (!Number.isFinite(got) || got < 0 || got > 100_000) throw new UserError(`${l.description}: how many came?`);
      if (l.partId && sent > 0) {
        await moveStock(tx, { shopId: user.shopId, partId: l.partId, locationId: t.toId, qty: sent, reason: "TRANSFER", userId: user.id, note: `Arrived from ${names.from} (transfer ${t.number})`, createdAt: now });
        if (got !== sent) {
          short += 1;
          await moveStock(tx, { shopId: user.shopId, partId: l.partId, locationId: t.toId, qty: r3(got - sent), reason: "ADJUSTED", userId: user.id, note: `Counted on arrival: ${got} of ${sent} sent (transfer ${t.number})`, createdAt: now });
        }
      }
      if (l.unitId) {
        const u = await tx.stockUnit.findFirst({ where: { id: l.unitId, shopId: user.shopId } });
        if (u) await tx.stockUnit.updateMany({ where: { id: u.id, shopId: user.shopId }, data: { locationId: t.toId, events: pushEvent(u.events, { at: now.toISOString(), note: `Arrived at ${names.to} (transfer ${t.number}, ${user.name})` }) } });
      }
      await tx.stockTransferLine.update({ where: { id: l.id }, data: { qtyArrived: got } });
    }
  });
  const words = [`Transfer ${t.number} from ${names.from} is on the shelf here.`];
  if (short) words.push(`${short === 1 ? "One line was" : `${short} lines were`} counted differently: recorded as an adjustment here.`);
  // Brought over for her: her special order is here (held at this store) and she hears it's in.
  if (t.specialOrderId) {
    const o = await db.specialOrder.findFirst({ where: { id: t.specialOrderId, shopId: user.shopId }, select: { id: true, status: true } });
    if (o && ["WAITING", "ORDERED"].includes(o.status)) {
      const { markHereFor } = await import("@/lib/special-orders");
      words.push(await markHereFor({ ...user }, o.id, now));
    }
  }
  return words.join(" ");
}

function toView(t: Prisma.StockTransferGetPayload<{ include: { lines: true } }>, stores: Store[], customers: Map<string, string>, units: Map<string, string | null>): TransferView {
  const name = (id: string) => stores.find((s) => s.id === id)?.name ?? "A closed store";
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    from: { id: t.fromId, name: name(t.fromId) },
    to: { id: t.toId, name: name(t.toId) },
    note: t.note,
    neededBy: t.neededBy,
    declineReason: t.declineReason,
    forCustomer: t.forCustomerId ? { id: t.forCustomerId, name: customers.get(t.forCustomerId) ?? "A customer" } : null,
    specialOrderId: t.specialOrderId,
    poId: t.poId,
    askedAt: t.askedAt,
    sentAt: t.sentAt,
    arrivedAt: t.arrivedAt,
    lines: t.lines.map((l) => ({ id: l.id, partId: l.partId, unitId: l.unitId, description: l.description, unit: l.partId ? (units.get(l.partId) ?? null) : null, qty: l.qty, qtySent: l.qtySent, qtyArrived: l.qtyArrived })),
  };
}

/** Transfers for the Between stores page: open ones (asked, on the way) and the last finished ones. */
export async function transfersFor(shopId: string, o: { open?: boolean; storeId?: string | null; partId?: string | null; take?: number } = {}): Promise<TransferView[]> {
  const where: Prisma.StockTransferWhereInput = {
    shopId,
    ...(o.open === true ? { status: { in: ["ASKED", "SENT"] } } : o.open === false ? { status: { in: ["ARRIVED", "CANCELLED", "DECLINED"] } } : {}),
    ...(o.storeId ? { OR: [{ fromId: o.storeId }, { toId: o.storeId }] } : {}),
    ...(o.partId ? { lines: { some: { partId: o.partId } } } : {}),
  };
  const rows = await db.stockTransfer.findMany({ where, include: { lines: true }, orderBy: { number: "desc" }, take: o.take ?? 100 });
  const [stores, customers, parts] = await Promise.all([
    storesOf(shopId),
    db.customer.findMany({ where: { shopId, id: { in: rows.map((r) => r.forCustomerId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    db.part.findMany({ where: { shopId, id: { in: rows.flatMap((r) => r.lines.map((l) => l.partId)).filter((x): x is string => !!x) } }, select: { id: true, unit: true } }),
  ]);
  return rows.map((r) => toView(r, stores, new Map(customers.map((c) => [c.id, c.name])), new Map(parts.map((p) => [p.id, p.unit]))));
}

/** What is on its way to or from a store for one item ("On the way to Florida: 3"), for the item's page. */
export async function onTheWay(shopId: string, partId: string): Promise<{ number: number; from: string; to: string; qty: number; status: string }[]> {
  const rows = await transfersFor(shopId, { open: true, partId, take: 20 });
  return rows.flatMap((t) => t.lines.filter((l) => l.partId === partId).map((l) => ({ number: t.number, from: t.from.name, to: t.to.name, qty: l.qtySent ?? l.qty, status: t.status })));
}

/** The words for a transfer line's amount: "2", "1 1/2 yd". */
export const lineQty = (l: { qty: number; unit: string | null }) => qtyText(l.qty, l.unit);

/** Open requests and transfers a store must act on: asked of it (Send it / Can't this time) and coming to it (It arrived). */
export async function storeTodo(shopId: string, storeId: string): Promise<{ askedOfUs: TransferView[]; comingHere: TransferView[]; weAsked: TransferView[] }> {
  const open = await transfersFor(shopId, { open: true, storeId, take: 200 });
  return {
    askedOfUs: open.filter((t) => t.status === "ASKED" && t.from.id === storeId),
    comingHere: open.filter((t) => t.status === "SENT" && t.to.id === storeId),
    weAsked: open.filter((t) => t.status === "ASKED" && t.to.id === storeId),
  };
}
