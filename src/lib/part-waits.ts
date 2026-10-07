import "server-only";
// Parts a ticket is waiting for (online-and-parts-design.md section 1): recorded when the shop has to order one,
// received when it is checked in (the customer hears "the part came in" through the parts_in notice, Marketing on),
// reopened within an hour if marked by mistake, or cancelled when it isn't coming. Bodies take the user so the check
// script can drive them; src/actions/part-waits.ts wraps them.
import type { OutMessage, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { CLOSING_STATUSES } from "@/lib/constants";
import { requireEquipment } from "@/lib/equipment/gate";
import { str } from "@/lib/format";
import { queueToCustomer } from "@/lib/messaging/queue";
import { renderKind } from "@/lib/messaging/templates";
import { hookContext } from "@/lib/notices/context";
import { ticketVars } from "@/lib/notices/vars";
import type { CurrentUser } from "@/lib/session";
import { changeTicketStatus } from "@/lib/ticket-status";
import { parseYmd, ymdParts } from "@/lib/zoned";

const HOUR = 3_600_000;
/** A wait marked received by mistake can be reopened this long after. */
export const REOPEN_WINDOW_MS = HOUR;

export type WaitRow = Prisma.PartWaitGetPayload<{ include: { part: { select: { partNumber: true } }; ticket: { select: { id: true; number: true; status: true; jobType: true; customer: { select: { id: true; name: true; phone: true } }; machine: { select: { brand: true; model: true } } } } } }>;

const INCLUDE = { part: { select: { partNumber: true } }, ticket: { select: { id: true, number: true, status: true, jobType: true, customer: { select: { id: true, name: true, phone: true } }, machine: { select: { brand: true, model: true } } } } } as const;

/** A ticket of this company that may still be worked on (a lapsed module still finishes work that came in before it ended). */
async function workTicket(user: CurrentUser, ticketId: string) {
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId: user.shopId }, include: { machine: { select: { equipment: true } }, shop: { select: { warrantyDays: true } } } });
  if (!t) throw new UserError("Ticket not found.");
  await requireEquipment(user, t.machine.equipment, { ticket: t, closing: true });
  return t;
}

/** The open waits of a company, newest supplier group first; `partId` or `supplier` narrow it. */
export async function openWaits(shopId: string, o: { partId?: string | null; supplier?: string | null; ticketId?: string } = {}): Promise<WaitRow[]> {
  return db.partWait.findMany({
    where: { shopId, receivedAt: null, cancelledAt: null, ...(o.partId ? { partId: o.partId } : {}), ...(o.supplier ? { supplier: { equals: o.supplier, mode: "insensitive" } } : {}), ...(o.ticketId ? { ticketId: o.ticketId } : {}) },
    include: INCLUDE,
    orderBy: [{ supplier: { sort: "asc", nulls: "last" } }, { orderedAt: "asc" }],
    take: 500,
  });
}

/** Every wait of one ticket, open first then the rest newest first. */
export async function waitsForTicket(shopId: string, ticketId: string): Promise<WaitRow[]> {
  const rows = await db.partWait.findMany({ where: { shopId, ticketId }, include: INCLUDE, orderBy: { orderedAt: "desc" }, take: 50 });
  return rows.sort((a, b) => Number(!!(a.receivedAt || a.cancelledAt)) - Number(!!(b.receivedAt || b.cancelledAt)) || b.orderedAt.getTime() - a.orderedAt.getTime());
}

/** The "Waiting on a part" form: a stocked part by number (optional) or a description; quantity; supplier; expected date; "mark the ticket Waiting on parts". */
export async function addWaitFor(user: CurrentUser, ticketId: string, fd: FormData): Promise<string> {
  const shopId = user.shopId;
  const t = await workTicket(user, ticketId);
  if (CLOSING_STATUSES.includes(t.status)) throw new UserError("This ticket is closed. Reopen it before ordering parts for it.");
  const partNumber = str(fd.get("partNumber"));
  const part = partNumber ? await db.part.findFirst({ where: { shopId, partNumber: { equals: partNumber, mode: "insensitive" } }, select: { id: true, description: true, partNumber: true, supplier: true } }) : null;
  if (partNumber && !part) throw new UserError(`No part numbered ${partNumber} in your inventory. Leave the number blank to order it by description.`);
  const description = (str(fd.get("description")) ?? part?.description ?? "").slice(0, 120);
  if (!description) throw new UserError("Say which part (a short description the customer would understand).");
  const qty = Number(str(fd.get("qty")) ?? "1");
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1000) throw new UserError("Quantity: a number above 0.");
  const supplier = (str(fd.get("supplier")) ?? part?.supplier ?? null)?.slice(0, 80) ?? null;
  const expectedRaw = str(fd.get("expectedOn"));
  const expectedOn = expectedRaw ? parseYmd(expectedRaw) : null;
  if (expectedRaw && !expectedOn) throw new UserError("Expected date: pick a date, or leave it blank.");
  const note = str(fd.get("note"))?.slice(0, 500) ?? null;
  const markWaiting = fd.get("markWaiting") != null && String(fd.get("markWaiting")) !== "false";
  const ctx = markWaiting && t.status !== "WAITING_PARTS" ? await hookContext(shopId, user.name) : null;
  return db.$transaction(async (tx) => {
    const w = await tx.partWait.create({ data: { shopId, ticketId: t.id, partId: part?.id ?? null, description, qty, supplier, expectedOn, note }, select: { id: true } });
    if (ctx) await changeTicketStatus(tx, t, "WAITING_PARTS", new Date(), t.shop.warrantyDays, ctx);
    return w.id;
  });
}

export type ReceiveResult = { received: number; tickets: number; queued: boolean; words: string };

/** "a bobbin case and a feed dog assembly" */
export function partsWords(descriptions: string[]): string {
  const list = descriptions.map((d) => d.trim()).filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** "Oct 9" from a YYYY-MM-DD. */
const fmtEta = (ymd: string) => {
  const { y, m, d } = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
};

/**
 * Marks waits received (one person's click; several at once from the Parts on order page). Per ticket: one parts_in
 * message naming every part received together (in the base since 7 Oct 2026: once email or texts are on, the
 * customer's own channel, consent and address permitting), and, when asked and nothing else is still on order, the ticket goes back on the bench.
 */
export async function receiveWaitsFor(user: CurrentUser, waitIds: string[], fd?: FormData, now = new Date()): Promise<ReceiveResult> {
  const shopId = user.shopId;
  const ids = [...new Set(waitIds.filter((x) => typeof x === "string" && x))];
  if (!ids.length) throw new UserError("Pick what came in.");
  // In the order they were recorded, so the message reads the way the parts were ordered.
  const waits = await db.partWait.findMany({ where: { id: { in: ids }, shopId, receivedAt: null, cancelledAt: null }, include: INCLUDE, orderBy: { orderedAt: "asc" } });
  if (!waits.length) throw new UserError("Those parts are already marked received (or aren't waits of this shop).");
  const backOnBench = fd?.get("backOnBench") != null && String(fd.get("backOnBench")) !== "false";
  const etaRaw = str(fd?.get("eta") ?? null);
  const eta = etaRaw ? parseYmd(etaRaw) : null;
  if (etaRaw && !eta) throw new UserError("Done by: pick a date, or leave it blank.");
  const ctx = await hookContext(shopId, user.name);
  const tell = ctx.notices;
  const byTicket = new Map<string, WaitRow[]>();
  for (const w of waits) byTicket.set(w.ticketId, [...(byTicket.get(w.ticketId) ?? []), w]);
  let queued = 0;
  let noAddress = 0;
  const notTold: string[] = [];
  await db.$transaction(async (tx) => {
    for (const [ticketId, list] of byTicket) {
      const r = await tx.partWait.updateMany({ where: { id: { in: list.map((w) => w.id) }, shopId, receivedAt: null, cancelledAt: null }, data: { receivedAt: now, receivedBy: user.name } });
      if (r.count !== list.length) throw new UserError("Someone marked one of these received a moment ago. Reload the page.");
      const t = await tx.ticket.findFirst({ where: { id: ticketId, shopId }, include: { machine: { select: { equipment: true } }, shop: { select: { warrantyDays: true } } } });
      if (!t) continue;
      // Tell the customer (notice purpose: anyone who asked to be told by email or text; no marketing consent needed).
      const v = tell && t.customerId && !CLOSING_STATUSES.includes(t.status) ? await ticketVars(tx, t.id, shopId) : null;
      if (v?.customerId) {
        const vars = { ...v.vars, parts: partsWords(list.map((w) => w.description)), eta_line: eta ? ` We expect to have it done by ${fmtEta(eta)}.` : "" };
        const q = await queueToCustomer(tx, {
          shopId,
          customerId: v.customerId,
          kind: "parts_in",
          channels: "preferred",
          // One per receipt: a wait reopened and received again gets a new message (the first was cancelled).
          dedupeKey: `parts_in:${list[0].id}:${now.getTime()}`,
          ticketId: t.id,
          refType: "wait",
          refId: list[0].id,
          sendAfter: now,
          byUserId: user.id,
          staffCap: false,
          ms: ctx.ms,
          content: (ch) => renderKind(ctx.ms, "parts_in", ch, vars),
        });
        if (q.queued.length) {
          queued += 1;
          await tx.partWait.updateMany({ where: { id: { in: list.map((w) => w.id) }, shopId }, data: { noticedAt: now } });
        } else if (q.skipped.some((s) => s.reason === "no_address" || s.reason === "no_messages" || s.reason === "channel_off")) noAddress += 1;
        else notTold.push(list[0].ticket.customer?.name ?? "the customer");
      }
      // Back on the bench when asked and nothing else is still on order for it.
      if (backOnBench && t.status === "WAITING_PARTS") {
        const stillOpen = await tx.partWait.count({ where: { shopId, ticketId: t.id, receivedAt: null, cancelledAt: null } });
        if (!stillOpen) await changeTicketStatus(tx, t, "ON_BENCH", now, t.shop.warrantyDays, ctx);
      }
    }
  });
  const tickets = byTicket.size;
  const parts: string[] = [`Received ${waits.length === 1 ? "it" : `${waits.length} parts`}.`];
  if (!tell) parts.push(`Call ${tickets === 1 ? "the customer" : "the customers"}: email and texts aren't set up, so nothing was sent.`);
  else if (queued) parts.push(`${tickets === 1 ? "The customer hears" : `${queued} of ${tickets} customers hear`} the part is in.`);
  if (tell && noAddress) parts.push(`${noAddress === 1 ? "One customer has" : `${noAddress} customers have`} no email or mobile number on file: call them.`);
  if (notTold.length) parts.push(`Not sent to ${partsWords(notTold)} (see the ticket's Messages).`);
  return { received: waits.length, tickets, queued: queued > 0, words: parts.join(" ") };
}

/** "Not received after all": within an hour, the wait reopens and its queued message is cancelled. */
export async function reopenWaitFor(user: CurrentUser, waitId: string, now = new Date()): Promise<void> {
  const shopId = user.shopId;
  const w = await db.partWait.findFirst({ where: { id: waitId, shopId } });
  if (!w || !w.receivedAt) throw new UserError("That part isn't marked received.");
  if (now.getTime() - w.receivedAt.getTime() > REOPEN_WINDOW_MS) throw new UserError("It was received more than an hour ago. Record a new wait instead.");
  await db.$transaction([
    db.partWait.updateMany({ where: { id: w.id, shopId }, data: { receivedAt: null, receivedBy: null, noticedAt: null } }),
    db.outMessage.updateMany({ where: { shopId, kind: "parts_in", refType: "wait", refId: w.id, status: { in: ["QUEUED", "SENDING"] } }, data: { status: "CANCELLED", error: "Not received after all", cancelledById: user.id } }),
  ]);
}

/** The part isn't coming: the wait closes with the reason; the ticket's status is left for staff to decide. */
export async function cancelWaitFor(user: CurrentUser, waitId: string, fd?: FormData, now = new Date()): Promise<void> {
  const shopId = user.shopId;
  const w = await db.partWait.findFirst({ where: { id: waitId, shopId, receivedAt: null, cancelledAt: null }, select: { id: true, note: true } });
  if (!w) throw new UserError("That wait is already closed.");
  const why = str(fd?.get("why") ?? null)?.slice(0, 200);
  await db.partWait.updateMany({ where: { id: w.id, shopId }, data: { cancelledAt: now, note: [w.note, why ? `Cancelled: ${why}` : "Cancelled"].filter(Boolean).join("\n") } });
}

/** The worker's "still wanted?" for a parts_in message: a reason to cancel, or null to send. */
export async function partsInStillWanted(row: Pick<OutMessage, "shopId" | "refType" | "refId" | "ticketId">): Promise<string | null> {
  if (row.refType !== "wait" || !row.refId) return null;
  const w = await db.partWait.findFirst({ where: { id: row.refId, shopId: row.shopId }, select: { receivedAt: true, cancelledAt: true, ticket: { select: { status: true } } } });
  if (!w) return "The wait is gone";
  if (!w.receivedAt) return "Not received after all";
  if (w.cancelledAt) return "The part isn't coming";
  if (CLOSING_STATUSES.includes(w.ticket.status)) return "The ticket has closed";
  return null;
}

/** Open waits per supplier, for the Parts on order page's headings and "Received all of these". */
export function groupBySupplier(rows: WaitRow[]): { supplier: string | null; rows: WaitRow[] }[] {
  const out = new Map<string, { supplier: string | null; rows: WaitRow[] }>();
  for (const r of rows) {
    const k = (r.supplier ?? "").trim().toLowerCase();
    const g = out.get(k) ?? { supplier: r.supplier?.trim() || null, rows: [] };
    g.rows.push(r);
    out.set(k, g);
  }
  return [...out.values()].sort((a, b) => (a.supplier ?? "zzz").localeCompare(b.supplier ?? "zzz"));
}
