"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { modelKey, str, toCents } from "@/lib/format";
import type { LineKind, PaymentMethod, TicketStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { STATUS_ORDER } from "@/lib/constants";
import { kickPartnerSync } from "@/lib/partners";

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

  // Machine: pick an existing one, or brand + model (+ serial). An existing serial is reused.
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
      ? await db.machine.findFirst({ where: { shopId, serial: { equals: serial, mode: "insensitive" }, modelKey: modelKey(model) } })
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
    machineId = m.id;
  }

  const viaAccountId = str(formData.get("viaAccountId"));
  const accessories = formData.getAll("accessories").map(String).filter(Boolean);
  const otherAcc = str(formData.get("accessoriesOther"));
  if (otherAcc) accessories.push(...otherAcc.split(",").map((s) => s.trim()).filter(Boolean));

  const serviceItemId = str(formData.get("serviceItemId"));
  const serviceItem = serviceItemId ? await db.serviceItem.findFirst({ where: { id: serviceItemId, shopId } }) : null;

  const typedNumber = Number(str(formData.get("number")) ?? "");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });

  const ticket = await db.$transaction(async (tx) => {
    const number = Number.isInteger(typedNumber) && typedNumber > 0 ? typedNumber : shop.nextTicketNumber;
    const clash = await tx.ticket.findFirst({ where: { shopId, number } });
    if (clash) throw new UserError(`Ticket ${number} already exists. Leave the number blank to use the next one.`);
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
    await tx.shop.update({ where: { id: shopId }, data: { nextTicketNumber: Math.max(shop.nextTicketNumber, number + 1) } });
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
  await ownTicket(user.shopId, ticketId);
  const techId = str(formData.get("techId"));
  if (techId) {
    const ok = await db.user.findFirst({ where: { id: techId, shopId: user.shopId } });
    if (!ok) throw new UserError("Tech not found.");
  }
  await db.ticket.update({
    where: { id: ticketId },
    data: {
      serviceRequested: str(formData.get("serviceRequested")),
      problem: str(formData.get("problem")),
      diagnosis: str(formData.get("diagnosis")),
      workDone: str(formData.get("workDone")),
      notes: str(formData.get("notes")),
      preApprovedCents: toCents(formData.get("preApproved")),
      approvedCents: toCents(formData.get("approved")),
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
  const out: Record<string, { found?: number; left?: number }> = {};
  for (const [k, v] of formData.entries()) {
    const m = /^(found|left):(.+)$/.exec(k);
    const n = grams(v); // non-negative number or null
    if (!m || n == null) continue;
    (out[m[2]] ??= {})[m[1] as "found" | "left"] = n;
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
    const qty = Math.max(1, Math.round(Number(str(formData.get("qty")) ?? "1")));
    const part = pn ? await db.part.findFirst({ where: { shopId: user.shopId, partNumber: pn } }) : null;
    const desc = str(formData.get("description"));
    const price = toCents(formData.get("price"));
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
  const line = await db.ticketLine.findFirst({ where: { id: lineId, ticket: { shopId: user.shopId } } });
  if (!line) throw new UserError("Line not found.");
  if (line.kind === "PART" && line.partId) {
    const qty = Math.round(line.qty);
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
  await db.payment.create({
    data: {
      ticketId,
      method: (str(formData.get("method")) ?? "CARD") as PaymentMethod,
      amountCents: amount,
      note: str(formData.get("note")),
    },
  });
  refresh(ticketId);
  revalidatePath("/sales");
});

export const removePayment = safe(async function removePayment(paymentId: string) {
  const user = await requireUser();
  const p = await db.payment.findFirst({ where: { id: paymentId, ticket: { shopId: user.shopId } } });
  if (!p) throw new UserError("Payment not found.");
  await db.payment.delete({ where: { id: paymentId } });
  refresh(p.ticketId);
  revalidatePath("/sales");
});
