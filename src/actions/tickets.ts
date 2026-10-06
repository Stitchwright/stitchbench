"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { isUserError, safe, UserError } from "@/lib/action";
import { requireAdmin, requireUser, type CurrentUser } from "@/lib/session";
import { numberKey } from "@/lib/parts";
import { withDisclosure } from "@/lib/part-labels";
import { sameText } from "@/lib/input";
import { lineTotal } from "@/lib/ticket-math";
import { modelKey, money, str, ticketNo, toCents } from "@/lib/format";
import { addPaymentFor, removePaymentFor } from "@/lib/payments";
import { actorOf, audit } from "@/lib/audit";
import type { LineKind, PaymentMethod, TicketStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { CLOSING_STATUSES, SITE_STATUS_ORDER, STATUS_LABEL, STATUS_ORDER } from "@/lib/constants";
import { kickPartnerSync } from "@/lib/partners";
import { requireModule } from "@/lib/modules";
import { changeTicketStatus } from "@/lib/ticket-status";
import { hookContext } from "@/lib/notices/context";
import { applyNotifyBy, needNotifyBy } from "@/lib/customer-input";
import { recordConsent } from "@/lib/messaging/consent";
import { isNotifyBy } from "@/components/notify-by-field";
import { canWorkOn, requireEquipment } from "@/lib/equipment/gate";
import { requireBaseWritable } from "@/lib/base-gate";
import { checklistFor, kindOf, shopKinds } from "@/lib/equipment/shop";
import { readAnswers } from "@/lib/equipment/form";
import { saveIntakeFor, saveReadingsFor } from "@/lib/equipment/ticket-data";
import { takeTicketNumber, typedTicketNumber } from "@/lib/ticket-number";
import { INSTALL_CHECKLIST } from "@/lib/vac/installs";

// $100,000 in cents: far above any real line or payment, and well inside what the books' whole numbers hold.
const MAX_MONEY = 10_000_000;
// Free text on a ticket: as long as anyone would write, not as long as a request body may be.
const MAX_TEXT = 20_000;

function fits(v: string | null, label: string): string | null {
  if (v && v.length > MAX_TEXT) throw new UserError(`${label} is too long. Keep it under ${MAX_TEXT.toLocaleString("en-US")} characters.`);
  return v;
}

/**
 * The ticket, by shop. "work" also checks the equipment gate (modules-design.md section 6.3): a ticket of a module that
 * has ended can be finished only while it came in before the end and isn't closed. "close" (closing statuses, payments,
 * returned accessories) is always allowed.
 */
async function ownTicket(shopId: string, ticketId: string, need: "work" | "close" = "work", role?: CurrentUser["role"]) {
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId }, include: { shop: true, machine: { select: { equipment: true, kind: true } } } });
  if (!t) throw new UserError("Ticket not found.");
  if (need === "work") await requireEquipment({ shopId, role }, t.machine.equipment, { ticket: t, closing: true });
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

// Where a check-in can start: in the shop, on the truck, on the bench, or already waiting (a crafted request could
// otherwise start a ticket ready or collected, which skips the ready-notice and never shows in the Sales log).
const NEW_TICKET_STATUSES: TicketStatus[] = ["AT_SHOP_AWAITING_PICKUP", "IN_TRUCK", "ON_BENCH", "WAITING_CUSTOMER_OK", "WAITING_PARTS"];

/**
 * A check-in's typed status must be one a new ticket can start as. Checked first, so a mistake leaves no new customer or
 * machine behind. (A typed paper number is checked in createTicket.)
 */
function checkNewTicket(formData: FormData) {
  const status = str(formData.get("status"));
  if (status != null && !NEW_TICKET_STATUSES.includes(status as TicketStatus)) {
    throw new UserError(`A new ticket can't start as ${STATUS_LABEL[status as TicketStatus] ?? status}.`);
  }
}

/**
 * "How should we tell them" as typed on a check-in: a non-blank valid value, null when the form has none or left it
 * blank (blank means "not asked" for a new customer and "keep as it is" for a picked one). Anything else is refused.
 */
function typedNotifyBy(formData: FormData): string | null {
  const v = str(formData.get("notifyBy"));
  if (v == null) return null;
  if (!isNotifyBy(v)) throw new UserError("Pick how to tell them.");
  return v;
}

const ASK_NOTIFY_BY = "Ask how they'd like to be told (text, email or a call).";

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

  // What is being checked in (the hidden `kind` field; an old form without one means a sewing machine). A picked
  // machine's own kind applies instead. New work in a module needs the module on.
  const kinds = await shopKinds(shopId);
  const kindKey = str(formData.get("kind")) ?? "sewing";
  const asked = kinds.all.find((k) => k.key === kindKey);
  if (!asked) throw new UserError("Pick what you're checking in.");
  let kind = asked;

  // Machine: pick an existing one, or brand + model (+ serial). An existing serial is reused.
  const pickedMachineId = str(formData.get("machineId"));
  const brand = str(formData.get("brand"));
  const model = str(formData.get("model"));
  const serial = str(formData.get("serial"));
  if (pickedMachineId) {
    const picked = await db.machine.findFirst({ where: { id: pickedMachineId, shopId } });
    if (!picked) throw new UserError("Machine not found.");
    kind = await kindOf(shopId, picked);
    await requireEquipment(user, picked.equipment);
  } else {
    if (kind.module) await requireModule(user, kind.module);
    // The module is on but the kind itself was taken off "What you repair".
    if (!kinds.usable.some((k) => k.key === asked.key)) throw new UserError("Pick what you're checking in.");
    if (!brand || !model) throw new UserError(`Enter the ${kind.noun}'s brand and model.`);
  }

  // Customer: pick an existing one or type a new name. With Marketing on and a channel ready, a customer who hasn't been
  // asked how to be told (text, email or a call) must be asked now; a picked customer's answer is applied in the transaction.
  const pickedCustomerId = str(formData.get("customerId"));
  const newCustomer = str(formData.get("customerName"));
  const notifyBy = typedNotifyBy(formData);
  const needNotify = await needNotifyBy(shopId);
  if (pickedCustomerId) {
    const ok = await db.customer.findFirst({ where: { id: pickedCustomerId, shopId }, select: { id: true, notifyBy: true } });
    if (!ok) throw new UserError("Customer not found.");
    if (needNotify && ok.notifyBy === "" && !notifyBy) throw new UserError(ASK_NOTIFY_BY);
  } else if (newCustomer && needNotify && !notifyBy) {
    throw new UserError(ASK_NOTIFY_BY);
  }

  const viaAccountId = str(formData.get("viaAccountId"));
  if (viaAccountId && !(await db.customer.findFirst({ where: { id: viaAccountId, shopId, kind: "TRADE" }, select: { id: true } }))) {
    throw new UserError("Trade account not found.");
  }
  const accessories = formData.getAll("accessories").map(String).filter(Boolean);
  const otherAcc = str(formData.get("accessoriesOther"));
  if (otherAcc) accessories.push(...otherAcc.split(",").map((s) => s.trim()).filter(Boolean));

  // The service picked has to be on this kind's menu (for every kind, or for this one).
  const serviceItemId = str(formData.get("serviceItemId"));
  const serviceItem = serviceItemId
    ? await db.serviceItem.findFirst({ where: { id: serviceItemId, shopId, OR: [{ equipmentKind: null }, { equipmentKind: kind.key }] } })
    : null;
  if (serviceItemId && !serviceItem) throw new UserError(`That service isn't on the ${kind.label} menu.`);
  const serviceRequested = fits(serviceItem?.name ?? str(formData.get("serviceRequested")), "Service requested");
  const problem = fits(str(formData.get("problem")), "Problem reported");

  // The kind's questions: about the unit (kept on the machine) and about this visit (kept on the ticket).
  const details = readAnswers(kind.intakeFields, "machine", formData);
  const intake = readAnswers(kind.intakeFields, "ticket", formData);

  // A paper ticket number typed in (blank takes the next one).
  const typed = typedTicketNumber(str(formData.get("number")));
  const preApprovedCents = amountOf(formData.get("preApproved"), "Pre-approved");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
  const { equipment, key: kindName } = kind;

  const ticket = await db.$transaction(async (tx) => {
    const number = await takeTicketNumber(tx, shopId, typed);

    let customerId: string | null = pickedCustomerId;
    if (customerId) {
      // A picked customer's typed answer (blank keeps what they said before), with its consent record.
      if (notifyBy) await applyNotifyBy(tx, shopId, customerId, formData, user.id, "intake");
    } else if (newCustomer) {
      customerId = (
        await tx.customer.create({
          data: { shopId, name: newCustomer, phone: str(formData.get("customerPhone")), email: str(formData.get("customerEmail")), notifyBy: notifyBy ?? "" },
        })
      ).id;
      if (notifyBy) await recordConsent(tx, { shopId, customerId, channel: "any", event: "notify_pref", source: "intake", detail: notifyBy, byUserId: user.id });
    }

    let machineId = pickedMachineId;
    if (!machineId) {
      // The same serial of the same kind of thing. Never a vacuum that is in stock or off sale: a check-in can't
      // reach into Vac Shop -> For sale (one the shop sold is the customer's now, so that one is reused).
      const existing = serial
        ? await tx.machine.findFirst({
            where: { shopId, equipment, serial: sameText(serial), modelKey: modelKey(model!), OR: [{ stock: { is: null } }, { stock: { is: { status: "SOLD" } } }] },
          })
        : null;
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
            equipment,
            kind: kindName,
            details,
          },
        }))
      ).id;
    }

    return tx.ticket.create({
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
        intake,
        taxRatePct: shop.taxRatePct,
        openedById: user.id,
        techId: user.id,
        lines: serviceItem
          ? { create: { kind: "SERVICE", description: serviceItem.name, qty: 1, unitPriceCents: serviceItem.priceCents } }
          : undefined,
      },
    });
  });

  revalidatePath("/tickets");
  revalidatePath("/");
  redirect(`/tickets/${ticket.id}`);
});

// ---------- status and text ----------

/**
 * A status change. Not `safe()`: it returns data, the line for the staff toast when a notice was queued ("A text goes
 * to Mary Smith at 10:44 am..."). The dates (ready, closed, warranty, the pickup shelf clock) and the notices hook are
 * in changeTicketStatus (src/lib/ticket-status.ts), the one way a direct ticket's status changes.
 */
export async function setStatus(ticketId: string, status: TicketStatus): Promise<{ ok: true; note?: string } | { error: string }> {
  try {
    const user = await requireUser();
    if (!STATUS_ORDER.includes(status)) throw new UserError("Unknown status.");
    // Closing a ticket (collected, returned unrepaired, abandoned) is always allowed, even while the program itself is
    // read-only (hub-accounts-billing-design.md 3.5); any other status is work.
    const closing = CLOSING_STATUSES.includes(status);
    if (!closing) await requireBaseWritable(user);
    const t = await ownTicket(user.shopId, ticketId, closing ? "close" : "work", user.role);
    if (t.jobType === "SITE" && !SITE_STATUS_ORDER.includes(status)) throw new UserError("That status isn't used for installs.");
    if (status === "COLLECTED" && t.status !== "COLLECTED") {
      // A partner sewing shop's machine goes back to them, and they mark it collected when their customer pays and picks
      // it up. Set here, it would send "collected" and take the job off their register's pickup list, unpaid.
      const job = await db.repairJob.findFirst({ where: { shopId: user.shopId, ticketId, side: "repair" }, select: { pickedUpAt: true } });
      if (job && !job.pickedUpAt) throw new UserError("This machine came from a partner shop. They mark it collected when their customer picks it up.");
    }
    // A trade account's commission is kept as it stands when the machine leaves (statusData pins it when the ticket
    // closes), so editing the account later doesn't rewrite what past months owe it. Looked up outside the transaction.
    const account = t.viaAccountId ? await db.customer.findFirst({ where: { id: t.viaAccountId, shopId: user.shopId }, select: { commissionPct: true } }) : null;
    const commissionPct = account ? (account.commissionPct ?? 0) : null;
    // What the notices hook needs, loaded before the transaction so it never opens a second connection inside one.
    const ctx = await hookContext(user.shopId, user.name);
    const r = await db.$transaction((tx) => changeTicketStatus(tx, t, status, new Date(), t.shop.warrantyDays, ctx, commissionPct));
    refresh(ticketId);
    return { ok: true, ...(r.note ? { note: r.note } : {}) };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

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
  const t = await ownTicket(user.shopId, ticketId, "work", user.role);
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
  const t = await ownTicket(user.shopId, ticketId, "work", user.role);
  const list = { ...((t.checklist as Prisma.JsonObject | null) ?? {}) };
  if (done) {
    // The name comes from the browser: only what is on this kind's checklist is stored (not any key, of any size).
    const items = t.jobType === "SITE" ? INSTALL_CHECKLIST : checklistFor(await kindOf(user.shopId, t.machine), t.shop);
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
  await ownTicket(user.shopId, ticketId, "work", user.role);
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
  const t = await ownTicket(user.shopId, ticketId, "work", user.role);
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
  // Ticking what went back is closing work, always allowed; adding items is work, so on a ticket that can't be worked
  // on (its module ended) the "add" box is ignored and only the ticks are saved.
  const t = await ownTicket(user.shopId, ticketId, "close", user.role);
  const added = (await canWorkOn(user.shopId, t.machine.equipment, t)) ? str(formData.get("add")) : null;
  const accessories = [...t.accessories];
  if (added) accessories.push(...added.split(",").map((s) => s.trim()).filter(Boolean));
  const returned = formData.getAll("returned").map(String).filter((a) => accessories.includes(a));
  await db.ticket.update({ where: { id: ticketId }, data: { accessories, accessoriesReturned: returned } });
  refresh(ticketId);
});

export const removeAccessory = safe(async function removeAccessory(ticketId: string, item: string) {
  const user = await requireUser();
  const t = await ownTicket(user.shopId, ticketId, "work", user.role);
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
  const t = await ownTicket(user.shopId, ticketId, "work", user.role);
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

/** The audit entry for a ticket line taken off (design 4.1, Deletes). */
function removedLine(line: { id: string; ticketId: string; description: string; qty: number; unitPriceCents: number; ticket: { number: number } }) {
  return {
    action: "ticketline.remove" as const,
    subjectType: "Ticket",
    subjectId: line.ticketId,
    subjectLabel: `Ticket #${ticketNo(line.ticket.number)}: ${line.description}`,
    amountCents: lineTotal(line),
    changes: { qty: [line.qty, 0] as [unknown, unknown] },
  };
}

export const removeLine = safe(async function removeLine(lineId: string) {
  const user = await requireUser();
  const line = await db.ticketLine.findFirst({
    where: { id: lineId, ticket: { shopId: user.shopId } },
    include: { ticket: { select: { number: true, closedAt: true, intakeAt: true, status: true, machine: { select: { equipment: true } } } } },
  });
  if (!line) throw new UserError("Line not found.");
  // Taking a line off is work on the ticket (the same gate as adding one).
  await requireEquipment(user, line.ticket.machine.equipment, { ticket: line.ticket, closing: true });
  assertBillOpen(line.ticket, user);
  if (line.kind === "PART" && line.partId) {
    const qty = line.qty;
    await db.$transaction(async (tx) => {
      await tx.ticketLine.delete({ where: { id: lineId } });
      await tx.part.update({ where: { id: line.partId! }, data: { qtyOnHand: { increment: qty } } });
      await tx.stockMove.create({
        data: { shopId: user.shopId, partId: line.partId!, qty, reason: "RETURNED", ticketId: line.ticketId, userId: user.id, note: "Removed from ticket" },
      });
      await audit(tx, actorOf(user), removedLine(line));
    });
  } else {
    await db.$transaction(async (tx) => {
      await tx.ticketLine.delete({ where: { id: lineId } });
      await audit(tx, actorOf(user), removedLine(line));
    });
  }
  refresh(line.ticketId);
});

// ---------- payments ----------

export const addPayment = safe.whileLapsed("addPayment")(async function addPayment(ticketId: string, formData: FormData) {
  const user = await requireUser();
  await addPaymentFor(user, ticketId, {
    amountCents: toCents(formData.get("amount")),
    method: (str(formData.get("method")) ?? "CARD") as PaymentMethod,
    note: fits(str(formData.get("note")), "Note"),
  });
  refresh(ticketId);
  revalidatePath("/sales");
});

export const removePayment = safe.whileLapsed("removePayment")(async function removePayment(paymentId: string) {
  // Taking a payment off a ticket is for the owner or an admin (like voiding a register sale).
  const user = await requireAdmin();
  refresh(await removePaymentFor(user, paymentId));
  revalidatePath("/sales");
});

// ---------- a kind's readings and intake answers (bodies in src/lib/equipment/ticket-data.ts) ----------

export const saveReadings = safe(async (ticketId: string, fd: FormData) => saveReadingsFor(await requireUser(), ticketId, fd));
export const saveIntake = safe(async (ticketId: string, fd: FormData) => saveIntakeFor(await requireUser(), ticketId, fd));
