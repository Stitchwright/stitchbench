"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { numberKey } from "@/lib/parts";
import { modelKey, str, toCents } from "@/lib/format";
import type { LineKind, PaymentMethod, TicketStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { STATUS_ORDER } from "@/lib/constants";
import { kickPartnerSync } from "@/lib/partners";
import { PAID_ELSEWHERE } from "@/lib/sales";

async function ownTicket(shopId: string, ticketId: string) {
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId }, include: { shop: true } });
  if (!t) throw new UserError("Ticket not found.");
  return t;
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

  // Customer: pick an existing one or type a new name.
  let customerId = str(formData.get("customerId"));
  const newCustomer = str(formData.get("customerName"));
  if (!customerId && newCustomer) {
    const c = await db.customer.create({
      data: {
        shopId,
        name: newCustomer,
        phone: str(formData.get("customerPhone")),
        email: str(formData.get("customerEmail")),
      },
    });
    customerId = c.id;
  } else if (customerId) {
    const ok = await db.customer.findFirst({ where: { id: customerId, shopId } });
    if (!ok) throw new UserError("Customer not found.");
  }

  // Machine: pick an existing one, or brand + model (+ serial). The same serial and make again is the same machine:
  // its history follows it, and it's owned by whoever brought it in this time (a traded-in machine sold on comes
  // back with a new owner).
  let machineId = str(formData.get("machineId"));
  if (machineId) {
    const ok = await db.machine.findFirst({ where: { id: machineId, shopId } });
    if (!ok) throw new UserError("Machine not found.");
  } else {
    const brand = str(formData.get("brand"));
    const model = str(formData.get("model"));
    if (!brand || !model) throw new UserError("Enter the machine's brand and model.");
    const serial = str(formData.get("serial"));
    const existing = serial
      ? await db.machine.findFirst({
          where: { shopId, serial: { equals: serial, mode: "insensitive" }, brand: { equals: brand, mode: "insensitive" }, modelKey: modelKey(model) },
        })
      : null;
    const m =
      existing ??
      (await db.machine.create({
        data: {
          shopId,
          brand,
          model,
          modelKey: modelKey(model),
          serial,
          machineType: str(formData.get("machineType")),
          customerId,
        },
      }));
    if (existing && customerId && existing.customerId !== customerId) await db.machine.update({ where: { id: existing.id }, data: { customerId } });
    machineId = m.id;
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

  const typedNumber = Number(str(formData.get("number")) ?? "");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });

  const ticket = await db.$transaction(async (tx) => {
    const typed = Number.isInteger(typedNumber) && typedNumber > 0 ? typedNumber : null;
    let number: number;
    if (typed) {
      number = typed;
      if (await tx.ticket.findFirst({ where: { shopId, number } })) throw new UserError(`Ticket ${number} already exists. Leave the number blank to use the next one.`);
    } else {
      // Taken atomically, skipping numbers already used (a partner job or a typed-in paper ticket may have them).
      const next = async () => (await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: { increment: 1 } }, select: { nextTicketNumber: true } })).nextTicketNumber - 1;
      number = await next();
      while (await tx.ticket.findFirst({ where: { shopId, number }, select: { id: true } })) number = await next();
    }
    const t = await tx.ticket.create({
      data: {
        shopId,
        number,
        machineId: machineId!,
        customerId,
        viaAccountId,
        status: (str(formData.get("status")) as TicketStatus | null) ?? (viaAccountId ? "AT_SHOP_AWAITING_PICKUP" : "ON_BENCH"),
        serviceRequested: serviceItem?.name ?? str(formData.get("serviceRequested")),
        problem: str(formData.get("problem")),
        preApprovedCents: toCents(formData.get("preApproved")),
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
  const now = new Date();
  const data: Record<string, unknown> = { status };
  if ((status === "READY_IN_TRUCK" || status === "READY_FOR_PICKUP") && !t.readyAt) data.readyAt = now;
  if (status === "COLLECTED" || status === "RETURNED_UNREPAIRED" || status === "ABANDONED") {
    data.closedAt = t.closedAt ?? now;
    if (status === "COLLECTED" && !t.warrantyUntil) {
      data.warrantyUntil = new Date(now.getTime() + t.shop.warrantyDays * 86400000);
    }
  }
  await db.ticket.update({ where: { id: ticketId }, data });
  refresh(ticketId);
});

export const saveTicketText = safe(async function saveTicketText(ticketId: string, formData: FormData) {
  const user = await requireUser();
  const t = await ownTicket(user.shopId, ticketId);
  // Only the boxes the tech changed are written. The form carries each box's value as the page drew it ("was:"
  // fields): a partner sewing shop's reply may have set the approved amount and added a line to the notes while the
  // page was open, and a save from that page mustn't put the old values back. A form without "was:" fields writes all.
  const changed = (name: string) => {
    const now = str(formData.get(name));
    return formData.has(`was:${name}`) && now === str(formData.get(`was:${name}`)) ? undefined : now;
  };
  const cents = (name: string) => {
    const v = changed(name);
    return v === undefined ? undefined : toCents(v);
  };
  const techId = changed("techId");
  if (techId) {
    const ok = await db.user.findFirst({ where: { id: techId, shopId: user.shopId } });
    if (!ok) throw new UserError("Tech not found.");
  }
  let notes = changed("notes");
  const wasNotes = str(formData.get("was:notes"));
  // The tech rewrote the notes while the partner added a line under the old ones: keep the tech's text and that line.
  if (notes !== undefined && t.notes && t.notes !== wasNotes && (wasNotes == null || t.notes.startsWith(wasNotes))) {
    notes = [notes, t.notes.slice(wasNotes?.length ?? 0).trim()].filter(Boolean).join("\n").slice(-20_000) || null;
  }
  await db.ticket.update({
    where: { id: ticketId },
    data: {
      serviceRequested: changed("serviceRequested"),
      problem: changed("problem"),
      diagnosis: changed("diagnosis"),
      workDone: changed("workDone"),
      notes,
      preApprovedCents: cents("preApproved"),
      approvedCents: cents("approved"),
      techId,
    },
  });
  refresh(ticketId);
});

// ---------- checklist, tension readings, accessories ----------

export const toggleChecklist = safe(async function toggleChecklist(ticketId: string, item: string, done: boolean) {
  const user = await requireUser();
  const t = await ownTicket(user.shopId, ticketId);
  const list = { ...((t.checklist as Prisma.JsonObject | null) ?? {}) };
  if (done) list[item] = { done: true, by: user.name, at: new Date().toISOString() };
  else delete list[item];
  await db.ticket.update({ where: { id: ticketId }, data: { checklist: list } });
  refresh(ticketId);
});

function grams(v: FormDataEntryValue | null): number | null {
  const s = str(v);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export const saveTension = safe(async function saveTension(ticketId: string, formData: FormData) {
  const user = await requireUser();
  await ownTicket(user.shopId, ticketId);
  await db.ticket.update({
    where: { id: ticketId },
    data: {
      upperFoundG: grams(formData.get("upperFoundG")),
      upperLeftG: grams(formData.get("upperLeftG")),
      bobbinFoundG: grams(formData.get("bobbinFoundG")),
      bobbinLeftG: grams(formData.get("bobbinLeftG")),
    },
  });
  refresh(ticketId);
});

export const saveMeasurements = safe(async function saveMeasurements(ticketId: string, formData: FormData) {
  const user = await requireUser();
  await ownTicket(user.shopId, ticketId);
  // Field names come from the browser: a Map (not an object, where "__proto__" would reach every object in the
  // server) keyed only by factory settings that exist.
  const read = new Map<string, { found?: number; left?: number }>();
  for (const [k, v] of formData.entries()) {
    const m = /^(found|left):([A-Za-z0-9_.:-]{1,120})$/.exec(k);
    const n = grams(v); // non-negative number or null
    if (!m || n == null) continue;
    const entry = read.get(m[2]) ?? {};
    entry[m[1] as "found" | "left"] = n;
    read.set(m[2], entry);
    if (read.size > 500) throw new UserError("Too many readings in one save.");
  }
  const known = new Set(
    (await db.factorySetting.findMany({ where: { id: { in: [...read.keys()] } }, select: { id: true } })).map((f) => f.id),
  );
  const out = Object.fromEntries([...read].filter(([id]) => known.has(id)));
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

export const addLine = safe(async function addLine(ticketId: string, formData: FormData) {
  const user = await requireUser();
  const t = await ownTicket(user.shopId, ticketId);
  const kind = str(formData.get("kind")) as LineKind;

  if (kind === "SERVICE") {
    const item = await db.serviceItem.findFirst({ where: { id: String(formData.get("serviceItemId")), shopId: user.shopId } });
    const price = toCents(formData.get("price"));
    const desc = str(formData.get("description"));
    if (!item && !desc) throw new UserError("Pick a service or type a description.");
    await db.ticketLine.create({
      data: { ticketId, kind, description: desc ?? item!.name, qty: 1, unitPriceCents: price ?? item?.priceCents ?? 0 },
    });
  } else if (kind === "LABOR") {
    const hours = Number(str(formData.get("hours")) ?? "0");
    if (!(hours > 0)) throw new UserError("Enter labor hours, e.g. 0.25 for 15 minutes.");
    const rate = toCents(formData.get("rate")) ?? t.shop.laborRateCents;
    await db.ticketLine.create({
      data: { ticketId, kind, description: str(formData.get("description")) ?? "Repair labor", qty: hours, unitPriceCents: rate },
    });
  } else if (kind === "PART") {
    const pn = str(formData.get("partNumber"))?.split(" | ")[0].trim();
    // The shop's own stock (not a partner's consigned items), by its number, any case, or another number it's sold under.
    const key = pn ? numberKey(pn) : "";
    const part = pn
      ? ((await db.part.findFirst({ where: { shopId: user.shopId, consignLinkId: null, partNumber: { equals: pn, mode: "insensitive" } } })) ??
        (key.length >= 3 ? await db.part.findFirst({ where: { shopId: user.shopId, consignLinkId: null, numberKeys: { has: key } } }) : null))
      : null;
    const rawQty = Number(str(formData.get("qty")) ?? "1");
    const qty = part?.unit === "yd" ? Math.max(0.125, Math.round((rawQty || 1) * 1000) / 1000) : Math.max(1, Math.round(rawQty || 1));
    const desc = str(formData.get("description"));
    const price = toCents(formData.get("price"));
    if (!part && price == null) throw new UserError(pn ? `${pn} isn't in your parts. Pick it from the list, or enter a price for a part you don't stock.` : "Pick a part from inventory, or describe it and enter a price.");
    if (part) {
      const unit = price ?? part.priceCents ?? Math.round((part.costCents ?? 0) * (1 + t.shop.partsMarkupPct / 100));
      await db.$transaction([
        db.ticketLine.create({
          data: { ticketId, kind, description: `${part.partNumber} ${part.description}`, qty, unitPriceCents: unit, partId: part.id },
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
    await db.ticketLine.create({
      data: {
        ticketId,
        kind,
        description: str(formData.get("description")) ?? (kind === "FEE" ? "Fee" : "Discount"),
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
  if (line.ticket.closedAt && user.role === "TECH") throw new UserError("The ticket is closed: only the owner or an admin can change its bill.");
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
  const method = (str(formData.get("method")) ?? "CARD") as PaymentMethod;
  // A machine from a partner sewing shop: what they take at their counter arrives from their register and goes on the
  // statement, less their commission. Typed in here as "Shop collected" or "Invoice" it would count as paid to us,
  // and the statement would owe them the commission instead of billing them for what they collected.
  if (PAID_ELSEWHERE.includes(method) && (await db.repairJob.findFirst({ where: { shopId: user.shopId, ticketId, side: "repair" }, select: { id: true } }))) {
    throw new UserError("This machine came through a partner shop. What they collect is rung up on their register and shows up here on its own; record here only what the customer paid us.");
  }
  await db.payment.create({
    data: {
      ticketId,
      method,
      amountCents: amount,
      note: str(formData.get("note")),
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
