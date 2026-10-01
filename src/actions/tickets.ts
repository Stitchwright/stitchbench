"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireAdmin, requireUser, type CurrentUser } from "@/lib/session";
import { numberKey } from "@/lib/parts";
import { withDisclosure } from "@/lib/part-labels";
import { sameText } from "@/lib/input";
import { lineTotal } from "@/lib/ticket-math";
import { modelKey, money, str, toCents } from "@/lib/format";
import type { LineKind, PaymentMethod, TicketStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { OPEN_STATUSES, PAYMENT_LABEL, STATUS_ORDER } from "@/lib/constants";
import { DEFAULT_CHECKLIST } from "@/lib/service-menu";
import { kickPartnerSync } from "@/lib/partners";
import { saveIntakeFor, saveReadingsFor } from "@/lib/equipment/ticket-data";

// $100,000 in cents: far above any real line or payment, and well inside what the books' whole numbers hold.
const MAX_MONEY = 10_000_000;
// Free text on a ticket: as long as anyone would write, not as long as a request body may be.
const MAX_TEXT = 20_000;

function fits(v: string | null, label: string): string | null {
  if (v && v.length > MAX_TEXT) throw new UserError(`${label} is too long. Keep it under ${MAX_TEXT.toLocaleString("en-US")} characters.`);
  return v;
}

async function ownTicket(shopId: string, ticketId: string) {
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId }, include: { shop: true } });
  if (!t) throw new UserError("Ticket not found.");
  return t;
}

/** A closed ticket's bill is the owner's or an admin's to change (like voiding a register sale). */
function assertBillOpen(t: { closedAt: Date | null }, user: CurrentUser) {
  if (t.closedAt && user.role === "TECH") throw new UserError("The ticket is closed: only the owner or an admin can change its bill.");
}

/** An amount typed on the ticket (pre-approved, approved): blank for none, else $0 to $100,000. */
function amountOf(v: FormDataEntryValue | null, label: string): number | null {
  if (str(v) == null) return null;
  const c = toCents(v);
  if (c == null || c < 0 || c > MAX_MONEY) throw new UserError(`${label}: enter an amount from $0 to $100,000, e.g. 150.00.`);
  return c;
}

/**
 * A check-in with a status that isn't open (a crafted request could start a ticket already collected, which the Sales log
 * never shows). Checked first, so a mistake leaves no new customer or machine behind. (A typed paper number is checked
 * in createTicket.)
 */
function checkNewTicket(formData: FormData) {
  const status = str(formData.get("status"));
  if (status != null && !OPEN_STATUSES.includes(status as TicketStatus)) throw new UserError("A new ticket has to start open.");
}

function refresh(ticketId: string) {
  // A ticket that came from a partner sewing shop: they see the change on their next sync (soon).
  kickPartnerSync();
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/tickets");
  revalidatePath("/");
}

// ---------- intake ----------

export const createTicket = safe(async function createTicket(formData: FormData) {
  const user = await requireUser();
  const shopId = user.shopId;
  checkNewTicket(formData);

  // Everything is checked first, and the new customer and machine are made in the same transaction as the ticket: a
  // refused check-in leaves nothing behind, so the retry doesn't add a second customer and machine.

  // Customer: pick an existing one or type a new name.
  const pickedCustomerId = str(formData.get("customerId"));
  const newCustomer = str(formData.get("customerName"));
  if (pickedCustomerId) {
    const ok = await db.customer.findFirst({ where: { id: pickedCustomerId, shopId } });
    if (!ok) throw new UserError("Customer not found.");
  }

  // Machine: pick an existing one, or brand + model (+ serial). An existing serial is reused.
  const pickedMachineId = str(formData.get("machineId"));
  const brand = str(formData.get("brand"));
  const model = str(formData.get("model"));
  const serial = str(formData.get("serial"));
  if (pickedMachineId) {
    const ok = await db.machine.findFirst({ where: { id: pickedMachineId, shopId } });
    if (!ok) throw new UserError("Machine not found.");
  } else if (!brand || !model) {
    throw new UserError("Enter the machine's brand and model.");
  }

  const viaAccountId = str(formData.get("viaAccountId"));
  if (viaAccountId && !(await db.customer.findFirst({ where: { id: viaAccountId, shopId, kind: "TRADE" }, select: { id: true } }))) {
    throw new UserError("Trade account not found.");
  }
  const accessories = formData.getAll("accessories").map(String).filter(Boolean);
  const otherAcc = str(formData.get("accessoriesOther"));
  if (otherAcc) accessories.push(...otherAcc.split(",").map((s) => s.trim()).filter(Boolean));

  const serviceItemId = str(formData.get("serviceItemId"));
  const serviceItem = serviceItemId ? await db.serviceItem.findFirst({ where: { id: serviceItemId, shopId } }) : null;
  const serviceRequested = fits(serviceItem?.name ?? str(formData.get("serviceRequested")), "Service requested");
  const problem = fits(str(formData.get("problem")), "Problem reported");

  // A paper ticket number typed in (blank takes the next one): a whole number of up to 8 digits, like the counter in
  // Settings. The column is a 32-bit integer and the counter moves past what is typed, so a number near the top of it
  // would break every later check-in, and every job a partner sends.
  const typedText = str(formData.get("number"))?.replace(/^#/, "") ?? null;
  const typed = typedText == null ? null : /^\d{1,8}$/.test(typedText) ? Number(typedText) : 0;
  if (typed === 0) throw new UserError("Paper ticket number: enter a whole number from 1 to 99999999, or leave it blank to use the next one.");
  const preApprovedCents = amountOf(formData.get("preApproved"), "Pre-approved");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });

  const ticket = await db.$transaction(async (tx) => {
    let number: number;
    if (typed) {
      number = typed;
      if (await tx.ticket.findFirst({ where: { shopId, number } })) throw new UserError(`Ticket ${number} already exists. Leave the number blank to use the next one.`);
    } else {
      // Taken atomically, skipping numbers already used (a partner job or a typed-in paper ticket may have them).
      const next = async () => (await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: { increment: 1 } }, select: { nextTicketNumber: true } })).nextTicketNumber - 1;
      number = await next();
      if (await tx.ticket.findFirst({ where: { shopId, number }, select: { id: true } })) {
        // The counter is behind the tickets (set back in Settings before that was refused): go straight past the
        // highest number instead of trying the used ones one at a time.
        const top = await tx.ticket.aggregate({ where: { shopId }, _max: { number: true } });
        number = (top._max.number ?? 0) + 1;
        await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: number + 1 } });
      }
    }

    const customerId =
      pickedCustomerId ??
      (newCustomer
        ? (await tx.customer.create({ data: { shopId, name: newCustomer, phone: str(formData.get("customerPhone")), email: str(formData.get("customerEmail")) } })).id
        : null);

    let machineId = pickedMachineId;
    if (!machineId) {
      const existing = serial ? await tx.machine.findFirst({ where: { shopId, serial: sameText(serial), modelKey: modelKey(model!) } }) : null;
      machineId = (
        existing ??
        (await tx.machine.create({
          data: {
            shopId,
            brand: brand!,
            model: model!,
            modelKey: modelKey(model!),
            serial,
            machineType: str(formData.get("machineType")),
            customerId,
          },
        }))
      ).id;
    }

    const t = await tx.ticket.create({
      data: {
        shopId,
        number,
        machineId,
        customerId,
        viaAccountId,
        status: (str(formData.get("status")) as TicketStatus | null) ?? (viaAccountId ? "AT_SHOP_AWAITING_PICKUP" : "ON_BENCH"),
        serviceRequested,
        problem,
        preApprovedCents,
        accessories,
        taxRatePct: shop.taxRatePct,
        openedById: user.id,
        techId: user.id,
        lines: serviceItem
          ? { create: { kind: "SERVICE", description: serviceItem.name, qty: 1, unitPriceCents: serviceItem.priceCents } }
          : undefined,
      },
    });
    // A typed number ahead of the counter moves the counter past it (never back).
    if (typed) await tx.$executeRaw`UPDATE "Shop" SET "nextTicketNumber" = GREATEST("nextTicketNumber", ${typed + 1}) WHERE id = ${shopId}`;
    return t;
  });

  revalidatePath("/tickets");
  revalidatePath("/");
  redirect(`/tickets/${ticket.id}`);
});

// ---------- status and text ----------

export const setStatus = safe(async function setStatus(ticketId: string, status: TicketStatus) {
  const user = await requireUser();
  if (!STATUS_ORDER.includes(status)) throw new UserError("Unknown status.");
  const t = await ownTicket(user.shopId, ticketId);
  if (status === "COLLECTED" && t.status !== "COLLECTED") {
    // A partner sewing shop's machine goes back to them, and they mark it collected when their customer pays and picks
    // it up. Set here, it would send "collected" and take the job off their register's pickup list, unpaid.
    const job = await db.repairJob.findFirst({ where: { shopId: user.shopId, ticketId, side: "repair" }, select: { pickedUpAt: true } });
    if (job && !job.pickedUpAt) throw new UserError("This machine came from a partner shop. They mark it collected when their customer picks it up.");
  }
  const now = new Date();
  const data: Record<string, unknown> = { status };
  const ready = (s: TicketStatus) => s === "READY_IN_TRUCK" || s === "READY_FOR_PICKUP";
  const wasClosed = !OPEN_STATUSES.includes(t.status);
  if (OPEN_STATUSES.includes(status)) {
    // Open again (a mis-click, or the repair didn't hold): it hasn't left the shop, so no return date or warranty, and
    // back on the bench it isn't ready either. Ready again later, the storage-fee clock starts from that ready-call.
    data.closedAt = null;
    data.warrantyUntil = null;
    data.tradeCommissionPct = null; // open tickets follow the account's current rate
    if (!ready(status)) data.readyAt = null;
    else if (!t.readyAt || !(ready(t.status) || wasClosed)) data.readyAt = now;
  } else {
    // Collected and returned-unrepaired swapped for each other keep the day it left; closing a reopened ticket, or
    // handing back an abandoned machine, dates from now. Only a collected repair carries the warranty.
    const closedAt = wasClosed && t.closedAt && t.status !== "ABANDONED" ? t.closedAt : now;
    data.closedAt = closedAt;
    // A trade account's commission is kept as it stands when the machine leaves, so editing the account later doesn't
    // rewrite what past months owe it.
    if (closedAt !== t.closedAt || t.tradeCommissionPct == null) {
      const account = t.viaAccountId ? await db.customer.findFirst({ where: { id: t.viaAccountId, shopId: user.shopId }, select: { commissionPct: true } }) : null;
      data.tradeCommissionPct = account ? (account.commissionPct ?? 0) : null;
    }
    data.warrantyUntil =
      status === "COLLECTED" ? (t.status === "COLLECTED" && t.warrantyUntil ? t.warrantyUntil : new Date(now.getTime() + t.shop.warrantyDays * 86400000)) : null;
  }
  await db.ticket.update({ where: { id: ticketId }, data });
  refresh(ticketId);
});

// The ticket's text form: column, form field, how it's read, and its name on the page.
const text = (v: FormDataEntryValue | null) => str(v)?.replace(/\r\n?/g, "\n") ?? null;
const TEXT_FIELDS = [
  ["serviceRequested", "serviceRequested", text, "Service requested"],
  ["problem", "problem", text, "Problem reported"],
  ["diagnosis", "diagnosis", text, "What we found"],
  ["workDone", "workDone", text, "Work done"],
  ["notes", "notes", text, "Internal notes"],
  ["preApprovedCents", "preApproved", toCents, "Pre-approved"],
  ["approvedCents", "approved", toCents, "Customer approved"],
  ["techId", "techId", str, "Tech"],
] as const;

export const saveTicketText = safe(async function saveTicketText(ticketId: string, formData: FormData) {
  const user = await requireUser();
  const t = await ownTicket(user.shopId, ticketId);
  const techId = str(formData.get("techId"));
  if (techId) {
    const ok = await db.user.findFirst({ where: { id: techId, shopId: user.shopId } });
    if (!ok) throw new UserError("Tech not found.");
  }
  // Only what was changed on this page is written. The page sends what each field showed when it loaded ("was:"), so
  // a change made meanwhile by someone else (a co-worker, or a partner shop's approval added to the notes) isn't put
  // back; the same field changed on both sides is refused rather than lost.
  const data: Record<string, string | number | null> = {};
  for (const [col, field, read, label] of TEXT_FIELDS) {
    if (!formData.has(field)) continue;
    const mine = read(formData.get(field));
    const current = typeof t[col] === "string" ? text(t[col]) : t[col];
    const was = formData.has(`was:${field}`) ? read(formData.get(`was:${field}`)) : current;
    if (mine === was) continue;
    if (current !== was && current !== mine) {
      throw new UserError(`Someone else changed "${label}" while you had this ticket open. Copy what you typed, reload the page, then save again.`);
    }
    // A changed amount is checked (an unchanged one is left as it is), and so is the length of a changed text.
    data[col] = col.endsWith("Cents") ? amountOf(formData.get(field), label) : typeof mine === "string" ? fits(mine, label) : mine;
  }
  if (Object.keys(data).length) await db.ticket.update({ where: { id: ticketId }, data });
  refresh(ticketId);
});

// ---------- checklist, tension readings, accessories ----------

export const toggleChecklist = safe(async function toggleChecklist(ticketId: string, item: string, done: boolean) {
  const user = await requireUser();
  const t = await ownTicket(user.shopId, ticketId);
  const list = { ...((t.checklist as Prisma.JsonObject | null) ?? {}) };
  if (done) {
    // The name comes from the browser: only what is on the shop's checklist is stored (not any key, of any size).
    const items = t.shop.checklistItems?.length ? t.shop.checklistItems : DEFAULT_CHECKLIST;
    if (!items.includes(item)) throw new UserError("That item isn't on the checklist any more. Reload the page.");
    list[item] = { done: true, by: user.name, at: new Date().toISOString() };
  } else delete list[item];
  await db.ticket.update({ where: { id: ticketId }, data: { checklist: list } });
  refresh(ticketId);
});

/**
 * A reading as typed: blank is none, and a unit after the number ("85 g", "2.4 mm", "15°") or a decimal comma ("22,5")
 * is fine. Anything else is refused by name: saving it as nothing would lose the reading behind a "saved".
 */
function reading(v: FormDataEntryValue | null, label: string, belowZeroOk: boolean): number | null {
  const s = str(v);
  if (s == null) return null;
  const bare = s.replace(/\s*(gf|g|mm|deg|°)\.?$/i, "").replace(/^(-?\d*),(\d+)$/, "$1.$2");
  const n = bare === "" ? NaN : Number(bare);
  if (!Number.isFinite(n) || Math.abs(n) > 9999) throw new UserError(`${label}: "${s}" isn't a number. Enter just the reading, e.g. ${belowZeroOk ? "-0.3" : "85"}.`);
  if (n < 0 && !belowZeroOk) throw new UserError(`${label}: a gauge reading can't be below 0 g.`);
  return n;
}

export const saveTension = safe(async function saveTension(ticketId: string, formData: FormData) {
  const user = await requireUser();
  await ownTicket(user.shopId, ticketId);
  await db.ticket.update({
    where: { id: ticketId },
    data: {
      upperFoundG: reading(formData.get("upperFoundG"), "Upper as found", false),
      upperLeftG: reading(formData.get("upperLeftG"), "Upper as left", false),
      bobbinFoundG: reading(formData.get("bobbinFoundG"), "Bobbin as found", false),
      bobbinLeftG: reading(formData.get("bobbinLeftG"), "Bobbin as left", false),
    },
  });
  refresh(ticketId);
});

export const saveMeasurements = safe(async function saveMeasurements(ticketId: string, formData: FormData) {
  const user = await requireUser();
  const t = await ownTicket(user.shopId, ticketId);
  // Field names come from the browser: a Map (not an object, where "__proto__" would reach every object in the
  // server) keyed only by factory settings that exist.
  const read = new Map<string, { found?: string; left?: string }>();
  for (const [k, v] of formData.entries()) {
    const m = /^(found|left):([A-Za-z0-9_.:-]{1,120})$/.exec(k);
    if (!m) continue;
    const entry = read.get(m[2]) ?? {};
    const s = str(v);
    if (s != null) entry[m[1] as "found" | "left"] = s;
    read.set(m[2], entry); // a blank box clears that reading
    if (read.size > 500) throw new UserError("Too many readings in one save.");
  }
  const known = await db.factorySetting.findMany({ where: { id: { in: [...read.keys()] } }, select: { id: true, label: true } });
  // Timing and clearances can be set below zero (a belt tensioner at -0.3 mm), so a minus sign is a real reading here.
  // Readings for settings not on this form (the model's list changed since) are kept.
  const out: Record<string, { found?: number; left?: number }> = Object.fromEntries(
    Object.entries((t.measurements as Record<string, { found?: number; left?: number }> | null) ?? {}).filter(([id]) => !read.has(id)),
  );
  for (const f of known) {
    const typed = read.get(f.id)!;
    const entry: { found?: number; left?: number } = {};
    for (const k of ["found", "left"] as const) if (typed[k] != null) entry[k] = reading(typed[k], `${f.label} as ${k}`, true)!;
    if (entry.found != null || entry.left != null) out[f.id] = entry;
  }
  await db.ticket.update({ where: { id: ticketId }, data: { measurements: out } });
  refresh(ticketId);
});

export const saveAccessories = safe(async function saveAccessories(ticketId: string, formData: FormData) {
  const user = await requireUser();
  const t = await ownTicket(user.shopId, ticketId);
  const added = str(formData.get("add"));
  const accessories = [...t.accessories];
  if (added) accessories.push(...added.split(",").map((s) => s.trim()).filter(Boolean));
  const returned = formData.getAll("returned").map(String).filter((a) => accessories.includes(a));
  await db.ticket.update({ where: { id: ticketId }, data: { accessories, accessoriesReturned: returned } });
  refresh(ticketId);
});

export const removeAccessory = safe(async function removeAccessory(ticketId: string, item: string) {
  const user = await requireUser();
  const t = await ownTicket(user.shopId, ticketId);
  await db.ticket.update({
    where: { id: ticketId },
    data: {
      accessories: t.accessories.filter((a) => a !== item),
      accessoriesReturned: t.accessoriesReturned.filter((a) => a !== item),
    },
  });
  refresh(ticketId);
});

// ---------- line items ----------

/** Suggestions for the part box on a ticket: the shop's own stock (a partner's consigned items can't be added there). */
export async function findStockedParts(q: string): Promise<string[]> {
  const user = await requireUser();
  const t = String(q ?? "").trim().slice(0, 60);
  if (t.length < 2) return [];
  const words = t.split(/\s+/).slice(0, 5);
  const parts = await db.part.findMany({
    where: {
      shopId: user.shopId,
      consignLinkId: null,
      OR: [
        { partNumber: { contains: t, mode: "insensitive" } },
        { numberKeys: { has: numberKey(t) } },
        { AND: words.map((w) => ({ description: { contains: w, mode: "insensitive" as const } })) },
      ],
    },
    orderBy: { partNumber: "asc" },
    take: 25,
    select: { partNumber: true, description: true, qtyOnHand: true },
  });
  return parts.map((p) => `${p.partNumber} | ${p.description} (${p.qtyOnHand} on hand)`);
}

export const addLine = safe(async function addLine(ticketId: string, formData: FormData) {
  const user = await requireUser();
  const t = await ownTicket(user.shopId, ticketId);
  assertBillOpen(t, user);
  const kind = str(formData.get("kind")) as LineKind;
  // A price typed on the ticket: blank for the usual price, else $0 to $100,000. Money comes off as a Discount line,
  // not a negative price.
  const priceOf = (k: string) => {
    const raw = str(formData.get(k));
    if (raw == null) return null;
    const c = toCents(raw);
    if (c == null || c < 0 || c > MAX_MONEY) throw new UserError("Enter a price from $0 to $100,000, e.g. 45.00. To take money off, add a discount.");
    return c;
  };

  if (kind === "SERVICE") {
    const item = await db.serviceItem.findFirst({ where: { id: String(formData.get("serviceItemId")), shopId: user.shopId } });
    const price = priceOf("price");
    const desc = fits(str(formData.get("description")), "Description");
    if (!item && !desc) throw new UserError("Pick a service or type a description.");
    if (!item && price == null) throw new UserError("Enter a price for a service that isn't on the menu, e.g. 45.00.");
    await db.ticketLine.create({
      data: { ticketId, kind, description: desc ?? item!.name, qty: 1, unitPriceCents: price ?? item?.priceCents ?? 0 },
    });
  } else if (kind === "LABOR") {
    const hours = Number(str(formData.get("hours")) ?? "0");
    if (!(hours > 0 && hours <= 100)) throw new UserError("Enter labor hours up to 100, e.g. 0.25 for 15 minutes.");
    const rate = priceOf("rate") ?? t.shop.laborRateCents;
    await db.ticketLine.create({
      data: { ticketId, kind, description: fits(str(formData.get("description")), "Description") ?? "Repair labor", qty: hours, unitPriceCents: rate },
    });
  } else if (kind === "PART") {
    const pn = str(formData.get("partNumber"))?.split(" | ")[0].trim();
    // The shop's own stock (not a partner's consigned items), by its number, any case, or another number it's sold under.
    const key = pn ? numberKey(pn) : "";
    const part = pn
      ? ((await db.part.findFirst({ where: { shopId: user.shopId, consignLinkId: null, partNumber: sameText(pn) } })) ??
        (key.length >= 3 ? await db.part.findFirst({ where: { shopId: user.shopId, consignLinkId: null, numberKeys: { has: key } } }) : null))
      : null;
    const rawQty = Number(str(formData.get("qty")) ?? "1");
    if (!Number.isFinite(rawQty) || rawQty < 0 || rawQty > 10_000) {
      throw new UserError(part?.unit === "yd" ? "Enter yards from 0.125 to 10,000." : "Enter a quantity from 1 to 10,000.");
    }
    const qty = part?.unit === "yd" ? Math.max(0.125, Math.round((rawQty || 1) * 1000) / 1000) : Math.max(1, Math.round(rawQty || 1));
    const desc = fits(str(formData.get("description")), "Description");
    const price = priceOf("price");
    if (!part && price == null) throw new UserError(pn ? `${pn} isn't in your parts. Pick it from the list, or enter a price for a part you don't stock.` : "Pick a part from inventory, or describe it and enter a price.");
    if (part) {
      const unit = price ?? part.priceCents ?? Math.round((part.costCents ?? 0) * (1 + t.shop.partsMarkupPct / 100));
      await db.$transaction([
        db.ticketLine.create({
          // A used, refurbished, compatible or 3D printed part says so on the invoice: written now, so the bill stays
          // right if the part is changed later.
          data: { ticketId, kind, description: withDisclosure(`${part.partNumber} ${part.description}`, part), qty, unitPriceCents: unit, partId: part.id },
        }),
        db.part.update({ where: { id: part.id }, data: { qtyOnHand: { decrement: qty } } }),
        db.stockMove.create({ data: { shopId: user.shopId, partId: part.id, qty: -qty, reason: "USED", ticketId, userId: user.id } }),
      ]);
    } else {
      if (!desc && !pn) throw new UserError("Pick a part from inventory or type a description.");
      await db.ticketLine.create({
        data: { ticketId, kind, description: [pn, desc].filter(Boolean).join(" "), qty, unitPriceCents: price ?? 0 },
      });
    }
  } else if (kind === "FEE" || kind === "DISCOUNT") {
    const amt = toCents(formData.get("price"));
    if (amt == null) throw new UserError("Enter an amount.");
    if (kind === "FEE" && (amt < 0 || amt > MAX_MONEY)) throw new UserError("Enter a fee from $0 to $100,000. To take money off, pick Discount.");
    if (kind === "DISCOUNT") {
      // No more off than the bill so far: the invoice would come out below zero.
      const billSoFar = (await db.ticketLine.findMany({ where: { ticketId }, select: { qty: true, unitPriceCents: true } })).reduce((s, l) => s + lineTotal(l), 0);
      if (Math.abs(amt) > billSoFar) throw new UserError(`That's more than the bill so far (${money(billSoFar)}).`);
    }
    await db.ticketLine.create({
      data: {
        ticketId,
        kind,
        description: fits(str(formData.get("description")), "Description") ?? (kind === "FEE" ? "Fee" : "Discount"),
        qty: 1,
        unitPriceCents: kind === "DISCOUNT" ? -Math.abs(amt) : amt,
        taxable: kind === "FEE",
      },
    });
  } else {
    throw new UserError("Unknown line type.");
  }
  refresh(ticketId);
});

export const removeLine = safe(async function removeLine(lineId: string) {
  const user = await requireUser();
  const line = await db.ticketLine.findFirst({ where: { id: lineId, ticket: { shopId: user.shopId } }, include: { ticket: { select: { closedAt: true } } } });
  if (!line) throw new UserError("Line not found.");
  assertBillOpen(line.ticket, user);
  if (line.kind === "PART" && line.partId) {
    const qty = line.qty;
    await db.$transaction([
      db.ticketLine.delete({ where: { id: lineId } }),
      db.part.update({ where: { id: line.partId }, data: { qtyOnHand: { increment: qty } } }),
      db.stockMove.create({
        data: { shopId: user.shopId, partId: line.partId, qty, reason: "RETURNED", ticketId: line.ticketId, userId: user.id, note: "Removed from ticket" },
      }),
    ]);
  } else {
    await db.ticketLine.delete({ where: { id: lineId } });
  }
  refresh(line.ticketId);
});

// ---------- payments ----------

export const addPayment = safe(async function addPayment(ticketId: string, formData: FormData) {
  const user = await requireUser();
  await ownTicket(user.shopId, ticketId);
  const amount = toCents(formData.get("amount"));
  if (amount == null || amount === 0) throw new UserError("Enter the amount paid.");
  if (Math.abs(amount) > MAX_MONEY) throw new UserError("That's more than $100,000. Check the amount.");
  // Money back (a minus amount) cancels what was taken, like removing a payment: the owner's or an admin's call.
  if (amount < 0 && user.role === "TECH") throw new UserError("Only the shop owner or an admin can record a refund.");
  const method = (str(formData.get("method")) ?? "CARD") as PaymentMethod;
  if (!Object.hasOwn(PAYMENT_LABEL, method)) throw new UserError("Pick how it was paid.");
  await db.payment.create({
    data: {
      ticketId,
      method,
      amountCents: amount,
      note: fits(str(formData.get("note")), "Note"),
    },
  });
  refresh(ticketId);
  revalidatePath("/sales");
});

export const removePayment = safe(async function removePayment(paymentId: string) {
  // Taking a payment off a ticket is for the owner or an admin (like voiding a register sale).
  const user = await requireAdmin();
  const p = await db.payment.findFirst({ where: { id: paymentId, ticket: { shopId: user.shopId } } });
  if (!p) throw new UserError("Payment not found.");
  await db.payment.delete({ where: { id: paymentId } });
  refresh(p.ticketId);
  revalidatePath("/sales");
});

// ---------- a kind's readings and intake answers (bodies in src/lib/equipment/ticket-data.ts) ----------

export const saveReadings = safe(async (ticketId: string, fd: FormData) => saveReadingsFor(await requireUser(), ticketId, fd));
export const saveIntake = safe(async (ticketId: string, fd: FormData) => saveIntakeFor(await requireUser(), ticketId, fd));
