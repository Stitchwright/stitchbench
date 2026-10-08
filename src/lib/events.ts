import "server-only";
// Retreats, trunk shows and other ticketed events (shop-features-round-2-design.md 4.5), on classes: a class gains a kind,
// an early-bird price, a deposit and a balance due day, choices with prices, and a door price (src/lib/classes.ts prices
// each sign-up). Here: who's coming with what they chose, paid and owing; a payment taken at the counter (a register
// sale with the event's line, so it is income when paid, as class fees are) or asked for by a pay link (1.3: paid, it is
// an online order and a sale); a ticket sold at the door; the check-in list; the door prize drawing; and the "balance
// due" reminders (14 days before the due day and on it). Every query by shopId; bodies take the user so the check script
// can drive them.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { isUserError, UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireOn, moduleOn } from "@/lib/module-gate";
import { customerFromForm } from "@/lib/customer-input";
import { enrollIn } from "@/lib/classes";
import { completeSaleAs } from "@/lib/register-sale";
import { TENDER_METHODS, type TenderMethod } from "@/lib/register-math";
import { exemptCertificate } from "@/lib/tax-exempt";
import { makePayLinkFor, payLinkProblem } from "@/lib/pay-links";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView } from "@/lib/messaging/settings";
import { plainText, renderKind } from "@/lib/messaging/templates";
import { customerVars } from "@/lib/messaging/customer-vars";
import { money } from "@/lib/format";
import { addDays, ymdOf } from "@/lib/zoned";
import { fmtYmdLong } from "@/lib/units/units";
import { balanceDueYmd, choicesOf, nextAsk, paidSoFar, paymentWords, type EventChoices } from "@/lib/events-math";

type PayKind = "DEPOSIT" | "BALANCE" | "PAYMENT" | "TICKET";

async function ownEnrollment(user: CurrentUser, id: string) {
  const e = typeof id === "string" ? await db.enrollment.findFirst({ where: { id, shopId: user.shopId }, include: { shopClass: true, eventPayments: true, customer: true } }) : null;
  if (!e) throw new UserError("Sign-up not found.");
  if (e.shopClass.kind === "CLASS") throw new UserError("That's a class: ring it up at the register.");
  return e;
}

async function ownEvent(user: CurrentUser, id: string) {
  const c = typeof id === "string" ? await db.shopClass.findFirst({ where: { id, shopId: user.shopId } }) : null;
  if (!c || c.kind === "CLASS") throw new UserError("Event not found.");
  return c;
}

/** Pay-link payments that were paid (or taken back / ran out) since they were asked for. */
export async function syncEventPayments(shopId: string, classId?: string): Promise<void> {
  const open = await db.eventPayment.findMany({ where: { shopId, paidAt: null, cancelledAt: null, webOrderId: { not: null }, ...(classId ? { enrollment: { classId } } : {}) }, select: { id: true, webOrderId: true } });
  if (!open.length) return;
  const orders = new Map((await db.webOrder.findMany({ where: { shopId, id: { in: open.map((p) => p.webOrderId!) } }, select: { id: true, status: true, paidAt: true, saleId: true } })).map((o) => [o.id, o]));
  for (const p of open) {
    const o = orders.get(p.webOrderId!);
    if (!o) continue;
    if (["PAID", "READY", "DONE"].includes(o.status)) await db.eventPayment.updateMany({ where: { id: p.id, shopId, paidAt: null }, data: { paidAt: o.paidAt ?? new Date(), saleId: o.saleId } });
    else if (o.status === "CANCELLED") await db.eventPayment.updateMany({ where: { id: p.id, shopId, paidAt: null }, data: { cancelledAt: new Date() } });
  }
}

export type EventPerson = {
  id: string;
  name: string;
  attendee: string | null;
  customerId: string | null;
  status: string;
  choices: Record<string, string>;
  priceCents: number;
  paidCents: number;
  owingCents: number;
  /** A pay link sent and not paid yet. */
  askedCents: number;
  next: { kind: "DEPOSIT" | "BALANCE"; cents: number } | null;
  checkedIn: boolean;
  payments: { id: string; kind: string; amountCents: number; paidAt: Date | null; saleId: string | null; webOrderId: string | null }[];
};

export type EventView = {
  id: string;
  title: string;
  kind: string;
  depositCents: number | null;
  depositRefundable: boolean;
  dueYmd: string | null;
  doorCents: number | null;
  choices: EventChoices;
  people: EventPerson[];
  draws: { id: string; name: string; prize: string; drawnAt: Date; present: boolean }[];
  totals: { priceCents: number; paidCents: number; owingCents: number; checkedIn: number };
};

/** Who's coming (signed up, not the waiting list) with what they chose, paid, owing and checked in; the draws. */
export async function eventView(shopId: string, classId: string): Promise<EventView | null> {
  await syncEventPayments(shopId, classId);
  const c = await db.shopClass.findFirst({ where: { id: classId, shopId }, include: { draws: { orderBy: { drawnAt: "asc" } } } });
  if (!c || c.kind === "CLASS") return null;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } });
  const rows = await db.enrollment.findMany({ where: { shopId, classId, status: "ENROLLED" }, orderBy: { createdAt: "asc" }, include: { eventPayments: { orderBy: { createdAt: "asc" } } } });
  const people: EventPerson[] = rows.map((e) => {
    const paid = paidSoFar(e, e.eventPayments);
    const asked = e.eventPayments.filter((p) => !p.paidAt && !p.cancelledAt).reduce((a, p) => a + p.amountCents, 0);
    const ch = e.choices && typeof e.choices === "object" && !Array.isArray(e.choices) ? (e.choices as Record<string, string>) : {};
    return {
      id: e.id,
      name: e.name,
      attendee: e.attendee,
      customerId: e.customerId,
      status: e.status,
      choices: ch,
      priceCents: e.feeCents,
      paidCents: paid,
      owingCents: Math.max(0, e.feeCents - paid),
      askedCents: asked,
      next: e.creditUnitId ? null : nextAsk({ priceCents: e.feeCents, paidCents: paid, depositCents: c.depositCents }),
      checkedIn: !!e.checkedInAt,
      payments: e.eventPayments.filter((p) => !p.cancelledAt).map((p) => ({ id: p.id, kind: p.kind, amountCents: p.amountCents, paidAt: p.paidAt, saleId: p.saleId, webOrderId: p.webOrderId })),
    };
  });
  return {
    id: c.id,
    title: c.title,
    kind: c.kind,
    depositCents: c.depositCents,
    depositRefundable: c.depositRefundable,
    dueYmd: c.firstAt && c.depositCents ? balanceDueYmd(ymdOf(c.firstAt, shop.timeZone), c.balanceDays) : null,
    doorCents: c.doorCents,
    choices: choicesOf(c.choices),
    people,
    draws: c.draws.map((d) => ({ id: d.id, name: d.name, prize: d.prize, drawnAt: d.drawnAt, present: d.present })),
    totals: {
      priceCents: people.reduce((a, p) => a + p.priceCents, 0),
      paidCents: people.reduce((a, p) => a + p.paidCents, 0),
      owingCents: people.reduce((a, p) => a + p.owingCents, 0),
      checkedIn: people.filter((p) => p.checkedIn).length,
    },
  };
}

/** The amount asked: what was typed (an owner or admin), else the deposit or the rest; never more than is owed. */
function amountFor(user: CurrentUser, e: Awaited<ReturnType<typeof ownEnrollment>>, typed: number | null): { kind: PayKind; cents: number } {
  const paid = paidSoFar(e, e.eventPayments);
  const owing = Math.max(0, e.feeCents - paid);
  if (owing <= 0) throw new UserError(`${e.attendee ?? e.name} has paid in full.`);
  if (typed != null) {
    if (user.role === "TECH") throw new UserError("Only an owner or admin can type the amount. Leave it empty for the deposit or the balance.");
    if (!Number.isInteger(typed) || typed <= 0) throw new UserError("Type the amount, like 150 or $150.00.");
    if (typed > owing) throw new UserError(`She owes ${money(owing)}: that's the most to take.`);
    return { kind: paid === 0 && e.shopClass.depositCents === typed ? "DEPOSIT" : typed === owing ? "BALANCE" : "PAYMENT", cents: typed };
  }
  const n = nextAsk({ priceCents: e.feeCents, paidCents: paid, depositCents: e.shopClass.depositCents })!;
  return n;
}

/** The register sale for event money taken at the counter: one line, the tender for the whole (tax as the event is taxed). */
async function counterSale(user: CurrentUser, a: { customerId: string | null; exempt: boolean; description: string; cents: number; taxable: boolean; method: TenderMethod; clientKey: string }): Promise<string> {
  if (!TENDER_METHODS.includes(a.method) || a.method === "GIFT" || a.method === "CREDIT") throw new UserError("Pick how she paid: cash, card, check or other.");
  const line = { description: a.description, qty: 1, unitPriceCents: a.cents, taxable: a.taxable };
  // One payment for exactly what the sale comes to (the store's rate, a tax holiday, her exemption: worked out there).
  const r = await completeSaleAs(user, { customerId: a.customerId, lines: [line], tenders: [], note: a.description, clientKey: a.clientKey }, { tenderExact: { method: a.method, amountCents: 0 } });
  return r.saleId;
}

/** "Take a payment" at the counter: the deposit, the balance, or an amount an owner types. Returns the sale's id. */
export async function takeEventPaymentFor(user: CurrentUser, enrollmentId: string, a: { cents?: number | null; method: string }, now = new Date()): Promise<{ saleId: string; cents: number }> {
  await requireOn(user, "scheduling");
  const e = await ownEnrollment(user, enrollmentId);
  if (e.status !== "ENROLLED") throw new UserError("Sign her up first (she's on the waiting list or cancelled).");
  const amt = amountFor(user, e, a.cents ?? null);
  const who = e.attendee ?? e.name;
  const description = paymentWords(amt.kind, e.shopClass.title, who, e.shopClass.depositRefundable);
  const key = `evt-${crypto.randomBytes(9).toString("base64url")}`;
  const saleId = await counterSale(user, { customerId: e.customerId, exempt: !!exemptCertificate(e.customer), description, cents: amt.cents, taxable: e.taxable, method: a.method as TenderMethod, clientKey: key });
  await db.eventPayment.create({ data: { shopId: user.shopId, enrollmentId: e.id, kind: amt.kind, amountCents: amt.cents, saleId, paidAt: now, createdById: user.id } });
  return { saleId, cents: amt.cents };
}

/** "Send a pay link": the deposit or the balance (or a typed amount) as a pay link (1.3), her usual way. */
export async function sendEventLinkFor(user: CurrentUser, enrollmentId: string, a: { cents?: number | null; send?: "usual" | "none" } = {}, now = new Date()): Promise<string> {
  await requireOn(user, "scheduling");
  const e = await ownEnrollment(user, enrollmentId);
  if (e.status !== "ENROLLED") throw new UserError("Sign her up first (she's on the waiting list or cancelled).");
  if (!e.customerId) throw new UserError("She has no customer record to send a link to.");
  if (e.eventPayments.some((p) => !p.paidAt && !p.cancelledAt)) throw new UserError("A pay link is already waiting for her: send that one again from Register, Pay links.");
  const amt = amountFor(user, e, a.cents ?? null);
  const r = await makePayLinkFor(
    user,
    { customerId: e.customerId, lines: [{ description: paymentWords(amt.kind, e.shopClass.title, e.attendee ?? e.name, e.shopClass.depositRefundable), qty: 1, unitPriceCents: amt.cents, taxable: e.taxable }], send: a.send ?? "usual" },
    { trusted: true, now },
  );
  await db.eventPayment.create({ data: { shopId: user.shopId, enrollmentId: e.id, kind: amt.kind, amountCents: amt.cents, webOrderId: r.orderId, createdById: user.id } });
  return `Pay link for ${money(amt.cents)} made. ${r.told}`;
}

/** "Ask for the balances": a pay link to everyone who owes and has none waiting. Returns words. */
export async function sendBalanceLinksFor(user: CurrentUser, classId: string, now = new Date()): Promise<string> {
  await requireOn(user, "scheduling");
  const c = await ownEvent(user, classId);
  const problem = await payLinkProblem(user.shopId);
  if (problem) throw new UserError(problem);
  const v = (await eventView(user.shopId, c.id))!;
  let n = 0;
  const not: string[] = [];
  for (const p of v.people) {
    if (!p.owingCents || p.askedCents || !p.customerId || !p.next) continue;
    try {
      await sendEventLinkFor(user, p.id, {}, now);
      n += 1;
    } catch (err) {
      if (!isUserError(err)) throw err;
      not.push(`${p.attendee ?? p.name}: ${err.message}`);
    }
  }
  if (!n && !not.length) throw new UserError("Nobody owes anything without a link waiting.");
  return `${n} pay link${n === 1 ? "" : "s"} made.${not.length ? ` Not sent: ${not.join("; ")}` : ""}`;
}

/** Takes a payment off the list (it was refunded at the register, or a pay link taken back). Owners and admins. */
export async function removeEventPaymentFor(user: CurrentUser, paymentId: string, now = new Date()): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can take a payment off.");
  const r = await db.eventPayment.updateMany({ where: { id: paymentId, shopId: user.shopId, cancelledAt: null }, data: { cancelledAt: now } });
  if (!r.count) throw new UserError("Payment not found.");
}

/** "Sell a ticket" at the door: signs her up at the door price, checked in, paid at the counter. */
export async function sellDoorTicketFor(user: CurrentUser, classId: string, fd: FormData, now = new Date()): Promise<string> {
  await requireOn(user, "scheduling");
  const c = await ownEvent(user, classId);
  if (c.doorCents == null) throw new UserError("Give the event a door price first (Edit, More choices).");
  const method = String(fd.get("method") ?? "CASH") as TenderMethod;
  const e = await db.$transaction(async (tx) => {
    const customer = await customerFromForm(tx, user.shopId, fd, user.id, "counter");
    return enrollIn(tx, { shopId: user.shopId, classId: c.id, customer, attendee: null, byUserId: user.id, skipWaitlist: false, door: true, now });
  });
  if (e.status !== "ENROLLED") {
    await db.enrollment.updateMany({ where: { id: e.id, shopId: user.shopId }, data: { status: "CANCELLED", cancelledAt: now } });
    throw new UserError("The event is full.");
  }
  if (e.feeCents > 0) {
    const cust = e.customerId ? await db.customer.findFirst({ where: { id: e.customerId, shopId: user.shopId } }) : null;
    try {
      const saleId = await counterSale(user, { customerId: e.customerId, exempt: !!exemptCertificate(cust), description: paymentWords("TICKET", c.title, e.name, true), cents: e.feeCents, taxable: e.taxable, method, clientKey: `evt-${crypto.randomBytes(9).toString("base64url")}` });
      await db.eventPayment.create({ data: { shopId: user.shopId, enrollmentId: e.id, kind: "TICKET", amountCents: e.feeCents, saleId, paidAt: now, createdById: user.id } });
    } catch (err) {
      await db.enrollment.updateMany({ where: { id: e.id, shopId: user.shopId }, data: { status: "CANCELLED", cancelledAt: now } });
      throw err;
    }
  }
  return e.name;
}

/** Check-in at the door (and taking it back). */
export async function checkInFor(user: CurrentUser, enrollmentId: string, on: boolean, now = new Date()): Promise<void> {
  await requireOn(user, "scheduling");
  const e = await ownEnrollment(user, enrollmentId);
  if (e.status !== "ENROLLED") throw new UserError("She isn't signed up.");
  await db.enrollment.updateMany({ where: { id: e.id, shopId: user.shopId }, data: { checkedInAt: on ? now : null } });
}

/**
 * "Draw a name": from those checked in (or everyone signed up when nobody is), leaving out anyone who has won a prize
 * and was there, and anyone drawn for this prize already. Returns the name.
 */
export async function drawFor(user: CurrentUser, classId: string, prize: string, now = new Date()): Promise<{ id: string; name: string }> {
  await requireOn(user, "scheduling");
  const c = await ownEvent(user, classId);
  const what = prize.trim().slice(0, 120) || "Door prize";
  const rows = await db.enrollment.findMany({ where: { shopId: user.shopId, classId: c.id, status: "ENROLLED" }, select: { id: true, name: true, attendee: true, checkedInAt: true } });
  const draws = await db.eventDraw.findMany({ where: { shopId: user.shopId, classId: c.id } });
  const won = new Set(draws.filter((d) => d.present).map((d) => d.enrollmentId));
  const forThis = new Set(draws.filter((d) => d.prize.toLowerCase() === what.toLowerCase()).map((d) => d.enrollmentId));
  const pool0 = rows.some((r) => r.checkedInAt) ? rows.filter((r) => r.checkedInAt) : rows;
  const pool = pool0.filter((r) => !won.has(r.id) && !forThis.has(r.id));
  if (!pool.length) throw new UserError(rows.length ? "Everyone has been drawn already." : "Nobody is signed up yet.");
  const pick = pool[crypto.randomInt(pool.length)];
  const name = pick.attendee ?? pick.name;
  const d = await db.eventDraw.create({ data: { shopId: user.shopId, classId: c.id, enrollmentId: pick.id, name, prize: what, drawnAt: now } });
  return { id: d.id, name };
}

/** "She's not here": the draw is kept, marked not present, so Draw again picks someone else for the same prize. */
export async function notPresentFor(user: CurrentUser, drawId: string): Promise<string> {
  const r = await db.eventDraw.findFirst({ where: { id: drawId, shopId: user.shopId } });
  if (!r) throw new UserError("Draw not found.");
  await db.eventDraw.updateMany({ where: { id: r.id, shopId: user.shopId }, data: { present: false } });
  return r.prize;
}

/**
 * The "balance due" reminders (a timer, every hour): for each event sign-up that owes and has paid something (or the
 * event takes a deposit), once 14 days before the due day and once on it, her usual way (Marketing on). Never twice.
 */
export async function runEventReminders(now = new Date()): Promise<number> {
  const events = await db.shopClass.findMany({ where: { kind: { not: "CLASS" }, depositCents: { not: null }, status: { not: "CANCELLED" }, firstAt: { gt: now } }, select: { id: true, shopId: true } });
  let queued = 0;
  const shops = new Map<string, boolean>();
  for (const ev of events) {
    if (!shops.has(ev.shopId)) shops.set(ev.shopId, await moduleOn(ev.shopId, "marketing"));
    if (!shops.get(ev.shopId)) continue;
    queued += await remindFor(ev.shopId, ev.id, now);
  }
  return queued;
}

async function remindFor(shopId: string, classId: string, now: Date): Promise<number> {
  const v = await eventView(shopId, classId);
  if (!v || !v.dueYmd) return 0;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true, timeZone: true } });
  const today = ymdOf(now, shop.timeZone);
  const stage = today >= v.dueYmd ? "due" : today >= addDays(v.dueYmd, -14) ? "14" : null;
  if (!stage) return 0;
  const ms = await messagingView(shopId);
  let n = 0;
  for (const p of v.people) {
    if (!p.customerId || p.owingCents <= 0 || p.paidCents <= 0) continue;
    const vars = { ...customerVars(p.name, shop), what: v.title, total: money(p.owingCents), until: fmtYmdLong(v.dueYmd) };
    const q = await queueToCustomer(db, {
      shopId,
      customerId: p.customerId,
      kind: "class_notice",
      channels: "preferred",
      dedupeKey: `event:${p.id}:balance:${stage}`,
      refType: "event_balance",
      refId: p.id,
      sendAfter: now,
      ms,
      content: (ch) => {
        const c = renderKind(ms, "event_balance", ch, vars);
        return { subject: c.subject, body: ch === "email" ? c.body : plainText(c.body).text };
      },
    });
    n += q.queued.length;
  }
  return n;
}
