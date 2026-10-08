import "server-only";
// Pay links sent by staff (shop-features-round-2-design.md 1.3). The shop fills in the lines (stock items, an amount
// for anything else, a special order's deposit or balance, a rental's rent), the program makes a web order with
// source "staff" and texts or emails the link; the customer opens it, presses Pay, and Stripe's page is made then
// (and again if she comes back after it ran out). Paid, it lands as the existing web order: the sale is written with
// tender "Paid online" (src/lib/shop/online-shop.ts finishStaffPaid). The link lasts 14 days unless the shop chooses.
// Every query by shopId; bodies take the user so the check script can drive them.
import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { money } from "@/lib/format";
import { noticesOn } from "@/lib/module-gate";
import { queueToCustomer } from "@/lib/messaging/queue";
import { seal, unseal } from "@/lib/messaging/secrets";
import { messagingView, publicBaseUrl } from "@/lib/messaging/settings";
import { plainText, renderKind } from "@/lib/messaging/templates";
import { customerVars } from "@/lib/messaging/customer-vars";
import { qtyText, saleTotals } from "@/lib/register-math";
import { exemptCertificate } from "@/lib/tax-exempt";
import { actorOf, audit } from "@/lib/audit";
import { ymdOf } from "@/lib/zoned";
import { fmtYmdLong } from "@/lib/units/units";
import { applyPayment, ORDER_INCLUDE, orderUrl, sha256, stripeKeyFor, TOKEN_RE, type OrderItem } from "@/lib/shop/online-shop";
import { createCheckoutSession, expireSession, retrieveSession } from "@/lib/shop/stripe";
import { currentStore, storeDetails } from "@/lib/stores";

const MAX_MONEY = 10_000_000;
export const PAY_LINK_DAYS = 14;
const MAX_LINES = 30;

/** One line the shop puts on a pay link. */
export type PayLine = {
  partId?: string | null;
  description?: string | null;
  qty?: number;
  unitPriceCents: number;
  taxable?: boolean;
  /** Money toward a special order (held for the customer, untaxed). */
  specialOrderId?: string | null;
  /** Rent on a machine out on rental. */
  loanId?: string | null;
};

export type PayLinkInput = {
  customerId: string | null;
  lines: PayLine[];
  note?: string | null;
  /** "usual": the customer's own way (text or email); "none": the shop copies the link and sends it itself. */
  send?: "usual" | "none";
  days?: number | null;
};

/** Special orders and rentals a link pays toward: open, this shop's and this customer's (filled in by their packages). */
async function checkRefs(shopId: string, customerId: string, lines: PayLine[]): Promise<void> {
  const soIds = [...new Set(lines.map((l) => l.specialOrderId).filter((x): x is string => !!x))];
  if (soIds.length && (await db.specialOrder.count({ where: { shopId, id: { in: soIds }, customerId, status: { in: ["WAITING", "ORDERED", "HERE"] } } })) !== soIds.length) {
    throw new UserError("That special order isn't open (or isn't hers).");
  }
  const loanIds = [...new Set(lines.map((l) => l.loanId).filter((x): x is string => !!x))];
  if (loanIds.length && (await db.unitLoan.count({ where: { shopId, id: { in: loanIds }, customerId, kind: "RENTAL", backAt: null } })) !== loanIds.length) throw new UserError("That rental isn't open (or isn't hers).");
  if (lines.some((l) => l.partId && (l.specialOrderId || l.loanId))) throw new UserError("A line can only be one thing.");
}

/** Why this shop can't send pay links yet, in words, or null when it can. */
export async function payLinkProblem(shopId: string): Promise<string | null> {
  if (!publicBaseUrl()) return "Pay links need the program's web address (the hosted program has one).";
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { id: true, shopPayVia: true, stripeKeySealed: true } });
  try {
    stripeKeyFor(shop);
  } catch {
    return "Pay links need card payments set up: Settings, Online shop (the Stripe key).";
  }
  return null;
}

/**
 * Makes the link and (by the customer's usual way, Marketing on) sends it. `trusted`: the lines come from the program
 * (a special order, a rental), so their prices stand for a tech too. Returns the link for the shop to copy.
 */
export async function makePayLinkFor(user: CurrentUser, input: PayLinkInput, o: { trusted?: boolean; now?: Date } = {}): Promise<{ orderId: string; number: number; link: string; told: string }> {
  const shopId = user.shopId;
  const now = o.now ?? new Date();
  await requireBaseWritable(user);
  const problem = await payLinkProblem(shopId);
  if (problem) throw new UserError(problem);
  const customer = input.customerId ? await db.customer.findFirst({ where: { id: input.customerId, shopId } }) : null;
  if (!customer) throw new UserError(input.customerId ? "Customer not found." : "Pick the customer first: the link goes to her.");
  const raw = Array.isArray(input.lines) ? input.lines.filter((l) => l && (Number(l.unitPriceCents) || l.partId)) : [];
  if (!raw.length) throw new UserError("Add what she's paying for.");
  if (raw.length > MAX_LINES) throw new UserError(`A pay link holds up to ${MAX_LINES} lines.`);
  const partIds = [...new Set(raw.map((l) => l.partId).filter((x): x is string => !!x))];
  const parts = new Map((partIds.length ? await db.part.findMany({ where: { shopId, id: { in: partIds } } }) : []).map((p) => [p.id, p]));
  if (parts.size !== partIds.length) throw new UserError("An item on the link isn't in your inventory any more.");
  const soIds = [...new Set(raw.map((l) => l.specialOrderId).filter((x): x is string => !!x))];
  if (soIds.length || raw.some((l) => l.loanId)) await checkRefs(shopId, customer.id, raw);
  const items: OrderItem[] = raw.map((l) => {
    const part = l.partId ? parts.get(l.partId)! : null;
    const qty = Number(l.qty ?? 1);
    const price = Math.round(Number(l.unitPriceCents));
    if (part?.kind === "MACHINE") throw new UserError(`${part.partNumber} is a machine model to order, not something to sell.`);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 999 || (part && part.unit !== "yd" && !Number.isInteger(qty))) throw new UserError(`Check how many of ${part?.partNumber ?? (l.description || "that line")}.`);
    if (!Number.isFinite(price) || price < 0 || price > MAX_MONEY) throw new UserError("Check the amounts.");
    if (user.role === "TECH" && !o.trusted) {
      if (!part) throw new UserError("Only an owner or admin can type an amount on a pay link.");
      if (part.priceCents == null || price !== part.priceCents) throw new UserError(`Only an owner or admin can change the price of ${part.partNumber}.`);
    }
    const description = (l.description?.trim() || part?.description || "").slice(0, 200);
    if (!description) throw new UserError("Say what each amount is for.");
    // Money toward a special order is held for her (untaxed); rent is a rental of goods (taxed).
    const money = l.specialOrderId;
    return {
      partId: part?.id ?? null,
      partNumber: part?.partNumber ?? null,
      description,
      qty,
      unit: part?.unit ?? null,
      unitPriceCents: price,
      taxable: money ? false : part || l.loanId ? true : l.taxable !== false,
      ...(l.specialOrderId ? { specialOrderId: l.specialOrderId } : {}),
      ...(l.loanId ? { loanId: l.loanId } : {}),
    };
  });
  // Made at this store (7.1): its tax rate, and the sale is its when she pays.
  const here = await currentStore(user);
  const shop = storeDetails(await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true, shopPayVia: true, timeZone: true, name: true, phone: true } }), here);
  const exempt = exemptCertificate(customer);
  const t = saleTotals(
    items.map((i) => ({ qty: i.qty, unitPriceCents: i.unitPriceCents, taxable: !!i.taxable })),
    0,
    exempt ? 0 : shop.taxRatePct,
  );
  if (t.total < 50) throw new UserError("The smallest card payment is $0.50.");
  if (t.total > MAX_MONEY) throw new UserError("A pay link can't be more than $100,000.");
  const days = Number.isInteger(Number(input.days)) && Number(input.days) >= 1 && Number(input.days) <= 60 ? Number(input.days) : PAY_LINK_DAYS;
  const token = crypto.randomBytes(32).toString("base64url");
  const orderId = crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 25)
    .replace(/^[0-9]/, "c");
  const link = orderUrl(token);
  const expiresAt = new Date(now.getTime() + days * 86_400_000);
  const order = await db.$transaction(async (tx) => {
    const sh = await tx.shop.update({ where: { id: shopId }, data: { nextWebOrderNumber: { increment: 1 } }, select: { nextWebOrderNumber: true } });
    return tx.webOrder.create({
      data: {
        id: orderId,
        shopId,
        number: sh.nextWebOrderNumber - 1,
        status: "PENDING",
        source: "staff",
        locationId: here?.id ?? null,
        customerId: customer.id,
        name: customer.name.slice(0, 120),
        phone: customer.phone,
        email: customer.email,
        notify: customer.notifyBy,
        fulfil: "pickup",
        items: items as unknown as Prisma.InputJsonValue,
        subtotalCents: t.subtotal,
        shipCents: 0,
        taxCents: t.tax,
        totalCents: t.total,
        payVia: shop.shopPayVia === "platform" ? "platform" : "own",
        taxVia: "rate",
        tokenHash: sha256(token),
        linkSealed: seal(link, shopId, `orderLink:${orderId}`),
        note: input.note?.trim().slice(0, 500) || null,
        specialOrderIds: soIds,
        createdById: user.id,
        expiresAt,
        createdAt: now,
      },
      select: { id: true, number: true },
    });
  });
  await audit(db, actorOf(user), { action: "paylink.make", subjectType: "WebOrder", subjectId: order.id, subjectLabel: `Pay link #${order.number}`, amountCents: t.total });
  const told = input.send === "none" ? "Copy the link and send it to her yourself." : await sendPayLink(user, order.id, now);
  return { orderId: order.id, number: order.number, link, told };
}

/** Texts or emails the link the customer's usual way. Returns what happened, in words. */
async function sendPayLink(user: CurrentUser, orderId: string, now: Date): Promise<string> {
  const o = await db.webOrder.findFirst({ where: { id: orderId, shopId: user.shopId, source: "staff" }, include: ORDER_INCLUDE });
  if (!o || !o.customerId) throw new UserError("Pay link not found.");
  // In the base since 7 Oct 2026 (transactional, like the ready notice): email or texts switched on is enough.
  if (!(await noticesOn(o.shopId))) return "Messages are off (no email or texts set up): copy the link and send it to her yourself.";
  const ms = await messagingView(o.shopId);
  const link = unseal(o.linkSealed, o.shopId, `orderLink:${o.id}`)?.plain ?? "";
  const items = o.items as unknown as OrderItem[];
  // Her name and first name too (customerVars), so "Hi {first_name}," never goes out as "Hi ,".
  const vars: Record<string, string> = {
    ...customerVars(o.name, o.shop),
    items: items.map((i) => `${i.description}${i.qty !== 1 ? ` x ${qtyText(i.qty, i.unit)}` : ""}  ${money(Math.round(i.qty * i.unitPriceCents))}`).join("\n"),
    total: money(o.totalCents),
    order_link: link,
    until: o.expiresAt ? fmtYmdLong(ymdOf(o.expiresAt, o.shop.timeZone)) : "",
    note_line: o.note ? ` ${o.note}` : "",
  };
  const q = await queueToCustomer(db, {
    shopId: o.shopId,
    customerId: o.customerId,
    kind: "pay_link",
    channels: "preferred",
    dedupeKey: `web:${o.id}:paylink:${now.getTime()}`,
    refType: "web_order",
    refId: o.id,
    sendAfter: now,
    byUserId: user.id,
    staffCap: false,
    ms,
    content: (ch) => {
      const c = renderKind(ms, "pay_link", ch, vars);
      return { subject: c.subject, body: ch === "email" ? c.body : plainText(c.body).text };
    },
  });
  if (q.queued.length) return `Sent to her by ${q.queued.map((x) => (x.channel === "sms" ? "text" : "email")).join(" and ")}.`;
  return "She has no email or mobile number we may use: copy the link and send it to her yourself, or call her.";
}

async function ownLink(user: CurrentUser, id: string) {
  const o = typeof id === "string" ? await db.webOrder.findFirst({ where: { id, shopId: user.shopId, source: "staff" } }) : null;
  if (!o) throw new UserError("Pay link not found.");
  return o;
}

/** "Send it again": a link not paid yet goes out again (a new day to pay from today if it had run out). */
export async function resendPayLinkFor(user: CurrentUser, id: string, now = new Date()): Promise<string> {
  await requireBaseWritable(user);
  const o = await ownLink(user, id);
  if (o.status !== "PENDING") throw new UserError("That link is paid or cancelled already.");
  if (o.expiresAt && o.expiresAt < new Date(now.getTime() + 3 * 86_400_000)) await db.webOrder.updateMany({ where: { id: o.id, shopId: user.shopId }, data: { expiresAt: new Date(now.getTime() + PAY_LINK_DAYS * 86_400_000) } });
  return sendPayLink(user, o.id, now);
}

/** Takes a link back before it is paid (a payment that arrives after is refunded by the online shop's own rule). */
export async function cancelPayLinkFor(user: CurrentUser, id: string, now = new Date()): Promise<void> {
  const o = await ownLink(user, id);
  if (o.status !== "PENDING") throw new UserError(o.status === "CANCELLED" ? "That link is cancelled already." : "That link is paid: cancel the order on the Online orders page instead (that refunds her).");
  const r = await db.webOrder.updateMany({ where: { id: o.id, shopId: user.shopId, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: now, staffNote: `Pay link taken back by ${user.name}.` } });
  if (!r.count) throw new UserError("That link was just paid. Look again.");
  await audit(db, actorOf(user), { action: "paylink.cancel", subjectType: "WebOrder", subjectId: o.id, subjectLabel: `Pay link #${o.number}`, amountCents: o.totalCents });
}

/**
 * Pending pay links toward a special order or a rental that can't take money any more (picked up, cancelled, ended):
 * taken back, and a payment page still open closed (a payment that slips through anyway is refunded by the online
 * shop's own rule for a cancelled order). Never throws: the step that ended the order already happened.
 */
export async function cancelLinksFor(shopId: string, ref: { specialOrderId?: string; loanId?: string }, why: string, now = new Date()): Promise<number> {
  try {
    const rows = ref.specialOrderId
      ? await db.webOrder.findMany({ where: { shopId, source: "staff", status: "PENDING", specialOrderIds: { has: ref.specialOrderId } }, select: { id: true } })
      : ref.loanId
        ? await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "WebOrder" WHERE "shopId" = ${shopId} AND "source" = 'staff' AND "status" = 'PENDING' AND "items"::jsonb @> ${JSON.stringify([{ loanId: ref.loanId }])}::jsonb`
        : [];
    let n = 0;
    for (const { id } of rows) {
      const r = await db.webOrder.updateMany({ where: { id, shopId, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: now, staffNote: `Pay link taken back: ${why}.` } });
      n += r.count;
      const o = r.count ? await db.webOrder.findUnique({ where: { id }, include: ORDER_INCLUDE }) : null;
      if (o?.stripeSessionId) {
        const key = stripeKeyFor({ id: o.shopId, shopPayVia: o.shop.shopPayVia, stripeKeySealed: o.shop.stripeKeySealed });
        await expireSession(key, o.stripeSessionId).catch(() => undefined);
      }
    }
    return n;
  } catch (e) {
    console.error("pay links:", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** Why a pending link can't be paid any more (its special order or rental closed, an item gone), or null. */
async function linkProblem(o: { shopId: string; customerId: string | null; items: unknown }): Promise<string | null> {
  const items = (o.items ?? []) as unknown as OrderItem[];
  try {
    if (o.customerId) await checkRefs(o.shopId, o.customerId, items as unknown as PayLine[]);
    else if (items.some((i) => i.specialOrderId || i.loanId)) return "its customer is gone";
  } catch (e) {
    return e instanceof Error ? e.message.replace(/[.]$/, "").toLowerCase() : "it can't be paid";
  }
  const ids = [...new Set(items.map((i) => i.partId).filter((x): x is string => !!x))];
  if (ids.length && (await db.part.count({ where: { shopId: o.shopId, id: { in: ids } } })) !== ids.length) return "an item on it isn't in the inventory any more";
  return null;
}

export type PayLinkRow = {
  id: string;
  number: number;
  status: string;
  customer: { id: string; name: string } | null;
  totalCents: number;
  items: OrderItem[];
  createdAt: Date;
  expiresAt: Date | null;
  paidAt: Date | null;
  link: string | null;
  note: string | null;
  staffNote: string | null;
};

/** The shop's pay links: waiting first, then the recent paid and cancelled ones; `customerId` narrows to one customer. */
export async function payLinksFor(shopId: string, o: { customerId?: string | null; specialOrderId?: string | null; take?: number } = {}): Promise<PayLinkRow[]> {
  const rows = await db.webOrder.findMany({
    where: { shopId, source: "staff", ...(o.customerId ? { customerId: o.customerId } : {}), ...(o.specialOrderId ? { specialOrderIds: { has: o.specialOrderId } } : {}) },
    orderBy: [{ createdAt: "desc" }],
    take: o.take ?? 100,
  });
  const ids = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))];
  const cust = new Map((ids.length ? await db.customer.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c]));
  const order = (s: string) => (s === "PENDING" ? 0 : 1);
  return rows
    .map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      customer: r.customerId ? (cust.get(r.customerId) ?? null) : null,
      totalCents: r.totalCents,
      items: r.items as unknown as OrderItem[],
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      paidAt: r.paidAt,
      link: r.status === "PENDING" ? (unseal(r.linkSealed, shopId, `orderLink:${r.id}`)?.plain ?? null) : null,
      note: r.note,
      staffNote: r.staffNote,
    }))
    .sort((a, b) => order(a.status) - order(b.status));
}

/** "Waiting for her to pay", "Paid 7 Oct", "Ran out unpaid", "Taken back". */
export function payLinkWords(r: Pick<PayLinkRow, "status" | "staffNote">): string {
  if (r.status === "PENDING") return "Waiting for her to pay";
  if (r.status === "CANCELLED") return r.staffNote?.startsWith("The pay link ran out") ? "Ran out unpaid" : "Taken back";
  return "Paid";
}

/**
 * The customer pressed Pay on the link's page (public, by the token): the open Stripe page if there is one, else a new
 * one. A link paid, cancelled or past its day says so.
 */
export async function openPayLink(token: string, now = new Date()): Promise<string> {
  if (!TOKEN_RE.test(token)) throw new UserError("There's no pay link at this address.");
  const o = await db.webOrder.findUnique({ where: { tokenHash: sha256(token) }, include: ORDER_INCLUDE });
  if (!o || o.source !== "staff") throw new UserError("There's no pay link at this address.");
  if (o.status !== "PENDING") throw new UserError(o.status === "CANCELLED" ? "This link was cancelled. Please call the shop." : "This is paid already. Thank you!");
  if (o.expiresAt && o.expiresAt < now) throw new UserError("This link has run out. Please call the shop for a new one.");
  // Checked again before she pays: the special order or rental may have closed since the link was sent.
  const problem = await linkProblem(o);
  if (problem) {
    await db.webOrder.updateMany({ where: { id: o.id, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: now, staffNote: `Pay link taken back: ${problem}.` } });
    if (o.stripeSessionId) await expireSession(stripeKeyFor({ id: o.shopId, shopPayVia: o.shop.shopPayVia, stripeKeySealed: o.shop.stripeKeySealed }), o.stripeSessionId).catch(() => undefined);
    throw new UserError("This link can't be paid any more. Please call the shop.");
  }
  const key = stripeKeyFor({ id: o.shopId, shopPayVia: o.shop.shopPayVia, stripeKeySealed: o.shop.stripeKeySealed });
  if (o.stripeSessionId) {
    const s = await retrieveSession(key, o.stripeSessionId);
    if (s.payment_status === "paid" || s.payment_status === "no_payment_required") {
      await applyPayment(o.id, { sessionId: s.id, intent: s.payment_intent }, now);
      throw new UserError("This is paid already. Thank you!");
    }
    if (s.status === "open" && s.url) return s.url;
  }
  const items = o.items as unknown as OrderItem[];
  const lines = [
    ...items.map((i) => ({ name: `${i.description}${i.qty !== 1 ? ` x ${qtyText(i.qty, i.unit)}` : ""}`, description: i.partNumber, unitCents: Math.round(i.qty * i.unitPriceCents), qty: 1 })),
    ...(o.taxCents > 0 ? [{ name: "Sales tax", unitCents: o.taxCents, qty: 1 }] : []),
  ].filter((l) => l.unitCents > 0);
  const session = await createCheckoutSession(key, {
    lines,
    successUrl: `${orderUrl(token)}?paid=1`,
    cancelUrl: orderUrl(token),
    email: o.email,
    metadata: { shopId: o.shopId, orderId: o.id, orderNumber: String(o.number), endpoint: o.payVia === "platform" ? "platform" : o.shopId },
    reference: o.id,
    // One page per earlier page: two presses at once get the same page back.
    idempotencyKey: `pay-link:${o.id}:${o.stripeSessionId ?? "first"}`,
    expiresInMinutes: 24 * 60,
  });
  if (!session.url) throw new UserError("The card processor gave no payment page. Please try again.");
  const r = await db.webOrder.updateMany({ where: { id: o.id, status: "PENDING", stripeSessionId: o.stripeSessionId }, data: { stripeSessionId: session.id } });
  if (!r.count) {
    const fresh = await db.webOrder.findUnique({ where: { id: o.id }, select: { stripeSessionId: true } });
    if (fresh?.stripeSessionId !== session.id) throw new UserError("Someone just opened this payment page. Please press Pay again.");
  }
  return session.url;
}

/** The day a link is good until, in words ("Oct 21"), in the shop's zone. */
export function untilWords(expiresAt: Date | null, tz: string): string {
  return expiresAt ? fmtYmdLong(ymdOf(expiresAt, tz)) : "";
}
