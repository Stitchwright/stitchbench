// Class seats and appointments at the register (scheduling-messaging-design.md 15.7 acceptance 2), through
// completeSaleAs / voidSaleAs / bookingsDueFor as a check user.
//   npm run check scripts/checks/register-bookings.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { bookingsDueFor, completeSaleAs, voidSaleAs, type SaleInput } from "@/lib/register-sale";
import { zonedTime } from "@/lib/zoned";
import { checkShop, cleanup, type CheckShop } from "./lib";

const NY = "America/New_York";
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

async function expectError(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

/** A sale of these lines paid in cash for exactly its total (the server works the total out again). */
function cash(lines: SaleInput["lines"], totalCents: number, extra: Partial<SaleInput> = {}): SaleInput {
  return { lines, tenders: [{ method: "CASH", amountCents: totalCents }], clientKey: crypto.randomBytes(12).toString("hex"), ...extra };
}

async function customer(shopId: string, name = `Cust ${uniq()}`) {
  return db.customer.create({ data: { shopId, name, kind: "RETAIL", notifyBy: "" }, select: { id: true, name: true } });
}
async function classWithSeat(shopId: string, customerId: string, o: { feeCents?: number; taxable?: boolean; status?: string; attendee?: string | null } = {}) {
  const c = await db.shopClass.create({ data: { shopId, title: `Quilting ${uniq()}`, seats: 8, feeCents: o.feeCents ?? 4500, taxable: o.taxable ?? false, status: o.status ?? "OPEN", firstAt: zonedTime("2027-03-02", 18 * 60, NY), lastAt: zonedTime("2027-03-02", 20 * 60, NY) } });
  const e = await db.enrollment.create({ data: { shopId, classId: c.id, customerId, name: "x", attendee: o.attendee ?? null, status: "ENROLLED", feeCents: o.feeCents ?? 4500, taxable: o.taxable ?? false } });
  return { c, e };
}
async function appointment(shopId: string, customerId: string, o: { feeCents?: number; taxable?: boolean; status?: string } = {}) {
  return db.appointment.create({ data: { shopId, customerId, name: "x", title: "Longarm rental", startsAt: zonedTime("2027-03-03", 10 * 60, NY), endsAt: zonedTime("2027-03-03", 12 * 60, NY), status: o.status ?? "BOOKED", feeCents: o.feeCents ?? 4000, taxable: o.taxable ?? false } });
}

async function main() {
  const t0 = Date.now();
  try {
    const a = await checkShop({ retail: true, repair: true, modules: ["scheduling"] });
    const S = a.shopId;
    await db.shop.update({ where: { id: S }, data: { taxRatePct: 8 } });
    const cust = await customer(S, "Pat Payer");

    // ---- pay a seat: paidCents = the fee, paidLineId set; again -> already paid; a client price is ignored
    const { c, e } = await classWithSeat(S, cust.id, { attendee: "Sam" });
    const due = await bookingsDueFor(S, NY, cust.id);
    assert.equal(due.length, 1);
    assert.match(due[0].description, /^Class: Quilting .*, Tue, Mar 2 at 6:00 pm for Sam$/);
    assert.equal(due[0].dueCents, 4500);
    const line = (price = 4500) => [{ enrollmentId: e.id, description: "whatever the browser said", qty: 1, unitPriceCents: price, taxable: true }];
    const s1 = await completeSaleAs(user(a), cash(line(1), 4500));
    const paid = await db.enrollment.findUniqueOrThrow({ where: { id: e.id } });
    assert.equal(paid.paidCents, 4500, "the fee, not the browser's $0.01");
    assert.ok(paid.paidAt && paid.paidLineId);
    const sale1 = await db.sale.findUniqueOrThrow({ where: { id: s1.saleId }, include: { lines: true } });
    assert.equal(sale1.customerId, cust.id, "a sale with no customer takes the booking's");
    assert.equal(sale1.lines[0].description, due[0].description, "the words come from the booking");
    assert.equal(sale1.lines[0].enrollmentId, e.id);
    assert.equal(sale1.taxCents, 0, "a non-taxable fee adds no tax");
    assert.equal(sale1.totalCents, 4500);
    await expectError("paid twice", () => completeSaleAs(user(a), cash(line(), 4500)), /is already paid\.$/);
    assert.deepEqual(await bookingsDueFor(S, NY, cust.id), []);
    ok("paying a seat: the fee (a client price is ignored), paidLineId, the booking's words and customer; paying again refused; no tax on a non-taxable fee");

    // ---- a taxable fee adds tax; the whole-sale discount never reduces a booking line; qty 2 and a line discount refused
    const taxed = await classWithSeat(S, cust.id, { feeCents: 10000, taxable: true });
    const s2 = await completeSaleAs(user(a), cash([{ enrollmentId: taxed.e.id, description: "", qty: 1, unitPriceCents: 0, taxable: false }], 10800, { orderDiscountCents: 2000 }));
    const sale2 = await db.sale.findUniqueOrThrow({ where: { id: s2.saleId } });
    assert.equal(sale2.taxCents, 800, "8% on $100");
    assert.equal(sale2.discountCents, 0, "the whole-sale discount has nothing to come off: the booking isn't discountable");
    assert.equal(sale2.totalCents, 10800);
    const two = await classWithSeat(S, cust.id);
    await expectError("qty 2", () => completeSaleAs(user(a), cash([{ enrollmentId: two.e.id, description: "", qty: 2, unitPriceCents: 4500, taxable: false }], 9000)), /^A class or appointment is one at a time\.$/);
    await expectError("line discount", () => completeSaleAs(user(a), cash([{ enrollmentId: two.e.id, description: "", qty: 1, unitPriceCents: 4500, discountCents: 500, taxable: false }], 4000)), /^Change the price for this person on the class instead\.$/);
    ok("a taxable fee adds tax; the whole-sale discount never touches a booking; qty 2 and a line discount are refused");

    // ---- a cancelled class, a waitlisted seat, a free seat, an appointment that was cancelled, both an enrollment and a part
    const gone = await classWithSeat(S, cust.id, { status: "CANCELLED" });
    await expectError("cancelled class", () => completeSaleAs(user(a), cash([{ enrollmentId: gone.e.id, description: "", qty: 1, unitPriceCents: 4500, taxable: false }], 4500)), /was cancelled\. Nothing to pay\.$/);
    const waiting = await classWithSeat(S, cust.id);
    await db.enrollment.update({ where: { id: waiting.e.id }, data: { status: "WAITLIST" } });
    await expectError("waitlisted", () => completeSaleAs(user(a), cash([{ enrollmentId: waiting.e.id, description: "", qty: 1, unitPriceCents: 4500, taxable: false }], 4500)), /is on the waiting list or cancelled\. Sign them up first\.$/);
    const free = await classWithSeat(S, cust.id, { feeCents: 0 });
    await expectError("free", () => completeSaleAs(user(a), cash([{ enrollmentId: free.e.id, description: "", qty: 1, unitPriceCents: 0, taxable: false }], 0)), /^Nothing to pay for /);
    const cancelledAppt = await appointment(S, cust.id, { status: "CANCELLED" });
    await expectError("cancelled appointment", () => completeSaleAs(user(a), cash([{ appointmentId: cancelledAppt.id, description: "", qty: 1, unitPriceCents: 4000, taxable: false }], 4000)), /^That appointment was cancelled\.$/);
    const part = await db.part.create({ data: { shopId: S, partNumber: `CHK-${uniq()}`, description: "Bobbin", priceCents: 500, qtyOnHand: 5 } });
    await expectError("two things", () => completeSaleAs(user(a), cash([{ enrollmentId: two.e.id, partId: part.id, description: "", qty: 1, unitPriceCents: 4500, taxable: false }], 4500)), /^A line can only be one thing\.$/);
    const theirs = await checkShop({ retail: true, modules: ["scheduling"] });
    await expectError("another company's seat", () => completeSaleAs(user(theirs), cash([{ enrollmentId: two.e.id, description: "", qty: 1, unitPriceCents: 4500, taxable: false }], 4500)), /^That class sign-up isn't in this shop\.$/);
    ok("a cancelled class, a waitlisted or free seat, a cancelled appointment, a line that is two things, and another company's seat are refused");

    // ---- an appointment paid, then refunded; an admin may lower the refund, a tech can't; the refund is written
    const appt = await appointment(S, cust.id, { feeCents: 4000 });
    assert.equal((await bookingsDueFor(S, NY, null)).some((d) => d.kind === "appointment" && d.id === appt.id), true, "listed as owed");
    const s3 = await completeSaleAs(user(a), cash([{ appointmentId: appt.id, description: "", qty: 1, unitPriceCents: 1, taxable: false }], 4000));
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id: appt.id } })).paidCents, 4000);
    const refundable = await bookingsDueFor(S, NY, cust.id, true);
    assert.ok(refundable.some((d) => d.kind === "appointment" && d.id === appt.id && d.dueCents === 4000), "listed as refundable");
    await expectError("tech lowers", () => completeSaleAs(tech(a), cash([{ appointmentId: appt.id, description: "", qty: -1, unitPriceCents: 3000, taxable: false }], -3000)), /./);
    await expectError("more than paid", () => completeSaleAs(user(a), cash([{ appointmentId: appt.id, description: "", qty: -1, unitPriceCents: 5000, taxable: false }], -5000)), /^You can refund at most \$40\.00\.$/);
    const s4 = await completeSaleAs(user(a), cash([{ appointmentId: appt.id, description: "", qty: -1, unitPriceCents: 3000, taxable: false }], -3000));
    const refunded = await db.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    assert.equal(refunded.refundedCents, 3000, "an admin kept a $10 cancellation fee");
    assert.ok(refunded.refundedAt && refunded.refundLineId);
    assert.equal((await db.sale.findUniqueOrThrow({ where: { id: s4.saleId } })).totalCents, -3000);
    await expectError("refund twice", () => completeSaleAs(user(a), cash([{ appointmentId: appt.id, description: "", qty: -1, unitPriceCents: 1000, taxable: false }], -1000)), /hasn't been paid here, or was refunded\.$/);
    // A tech refunds exactly what was paid (on another booking).
    const appt2 = await appointment(S, cust.id, { feeCents: 2500 });
    await completeSaleAs(tech(a), cash([{ appointmentId: appt2.id, description: "", qty: 1, unitPriceCents: 0, taxable: false }], 2500));
    await completeSaleAs(tech(a), cash([{ appointmentId: appt2.id, description: "", qty: -1, unitPriceCents: 1, taxable: false }], -2500));
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id: appt2.id } })).refundedCents, 2500, "a tech's refund is what was paid, whatever the browser sent");
    ok("an appointment paid then refunded: an admin may keep part of it, never give more; a tech refunds what was paid; a second refund is refused");

    // ---- voids: the payment sale after a refund -> void the refund first; then both clear
    await expectError("void payment after refund", () => voidSaleAs(user(a), s3.saleId, "oops"), /was refunded since this sale; void that refund first\.$/);
    await voidSaleAs(user(a), s4.saleId, "wrong");
    let st = await db.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    assert.ok(st.refundedAt === null && st.refundedCents === null && st.refundLineId === null && st.paidAt, "the refund is undone, the payment stands");
    await voidSaleAs(user(a), s3.saleId, "wrong too");
    st = await db.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    assert.ok(st.paidAt === null && st.paidCents === null && st.paidLineId === null, "the payment is undone too");
    assert.ok((await bookingsDueFor(S, NY, cust.id)).some((d) => d.id === appt.id), "owed again");
    await expectError("void twice", () => voidSaleAs(user(a), s3.saleId, "again"), /^That sale is already void\.$/);
    ok("voiding the payment after a refund is refused; void the refund then the payment, and both are cleared");

    // ---- the first sale's class: voided payment makes the seat owed again; the seat's words name the class and attendee
    await voidSaleAs(user(a), s1.saleId, "paid twice by mistake");
    const again = await bookingsDueFor(S, NY, cust.id);
    assert.ok(again.some((d) => d.id === e.id && d.dueCents === 4500));
    assert.equal((await db.shopClass.findUniqueOrThrow({ where: { id: c.id } })).status, "OPEN");
    ok("voiding a seat's payment makes it owed again");

    console.log(`register-bookings.check: ${steps} groups passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
