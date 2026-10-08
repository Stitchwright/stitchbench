// Longarm quilting (fabric-smarts-design.md section 4a, package F7): the pricing math (size x rate to the cent, flat, extras,
// rental by the hour), work orders (validation, numbers, the status flow, editing while open), collecting (billed as a
// register sale with tax, voiding it puts the quilt back on the shelf), the calendar's due dates, the customer's history and
// deletion, longarm rental (an hourly appointment type for certified customers: refused without the flag, the fee by the
// hour, billed at the register, not offered online) and the tenant section.
//   npm run check scripts/checks/longarm.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { calendarItems } from "@/lib/calendar";
import { collectFor, createOrderFor, deletePhotoFor, ordersFor, ordersOfCustomer, orderView, saveOrderFor, setCertifiedFor, setStatusFor } from "@/lib/longarm";
import { MAX_INCHES, MOVES, orderCents, quiltCents, rateText, rateTenthFrom, rentalFeeCents } from "@/lib/longarm-math";
import { bookAs, rescheduleApptAs, saveApptTypeAs } from "@/lib/appointment-actions";
import { publicTypes } from "@/lib/online-booking";
import { bookingsDueFor, completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { registerTakenCents } from "@/lib/register-day";
import { deleteCustomerFor } from "@/lib/merge";
import { ymdOf, zonedTime } from "@/lib/zoned";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

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

const TZ = "America/New_York";
const DAY = 86_400_000;

async function main() {
  // 1. The math.
  assert.equal(quiltCents({ pricing: "PER_SQIN", widthIn: 60, lengthIn: 80, rateTenthCents: 25, flatCents: 0 }), 12_000, "60 x 80 at 2.5 cents");
  assert.equal(quiltCents({ pricing: "PER_SQIN", widthIn: 33, lengthIn: 47, rateTenthCents: 25, flatCents: 0 }), 3878, "1551 sq in x 2.5 cents = 3877.5, to the cent");
  assert.equal(quiltCents({ pricing: "PER_SQIN", widthIn: 36, lengthIn: 36, rateTenthCents: 30, flatCents: 999 }), 3888, "flat is ignored when priced by the inch");
  assert.equal(quiltCents({ pricing: "FLAT", widthIn: 60, lengthIn: 80, rateTenthCents: 25, flatCents: 7500 }), 7500, "flat: size is ignored");
  assert.deepEqual(orderCents({ pricing: "PER_SQIN", widthIn: 60, lengthIn: 80, rateTenthCents: 25, flatCents: 0, threadCents: 1200, battingCents: 2400, extraCents: 1500 }), { quiltCents: 12_000, totalCents: 17_100 });
  assert.deepEqual(["2.5", "3", "0.5", "$2.5", "2.5c", " 4 "].map(rateTenthFrom), [25, 30, 5, 25, 25, 40]);
  assert.deepEqual(["2.55", "abc", "", "101", "-1", "2,5"].map(rateTenthFrom), [null, null, null, null, null, null]);
  assert.deepEqual([rateText(25), rateText(30), rateText(5)], ["2.5", "3", "0.5"]);
  assert.deepEqual([rentalFeeCents(2500, 90), rentalFeeCents(2500, 120), rentalFeeCents(1999, 45), rentalFeeCents(2500, 0)], [3750, 5000, 1499, 0], "hourly rental: rate x time to the cent");
  ok("math: size x rate to the cent, flat ignores size, extras add, rates read with one decimal, rental fee by the minute");

  const a = await checkShop({ retail: true, modules: ["scheduling"] });
  const b = await checkShop({ retail: true, modules: ["scheduling"] });
  const repairOnly = await checkShop({ repair: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 8 } });
    const mk = (shopId: string, name: string) => db.customer.create({ data: { shopId, name, phone: "555-0101", email: `${name.toLowerCase().replace(/\W+/g, "")}@quilt.example` } });
    const c1 = await mk(a.shopId, "Quinn Quilter");
    const cB = await mk(b.shopId, "Bea Other");
    const due = ymdOf(new Date(Date.now() + 5 * DAY), TZ);
    const base = { customerId: c1.id, widthIn: "60", lengthIn: "80", pricing: "PER_SQIN", rate: "2.5", design: "PANTOGRAPH", designName: "Baptist fan", thread: "Glide ivory", threadPrice: "12", batting: "Warm and Natural queen", battingPrice: "24", extra: "15", extraNote: "binding", due };

    // 2. Taking a quilt in.
    await expectError("repair-only shop", () => createOrderFor(user(repairOnly), fd(base)), /sewing-shop counter/);
    await expectError("no customer", () => createOrderFor(user(a), fd({ ...base, customerId: "" })), /name and a phone/);
    await expectError("zero width", () => createOrderFor(user(a), fd({ ...base, widthIn: "0" })), /width: whole inches/);
    await expectError("too long", () => createOrderFor(user(a), fd({ ...base, lengthIn: String(MAX_INCHES + 1) })), /length: whole inches/);
    await expectError("fraction", () => createOrderFor(user(a), fd({ ...base, widthIn: "60.5" })), /width: whole inches/);
    await expectError("no rate", () => createOrderFor(user(a), fd({ ...base, rate: "" })), /cents per square inch/);
    await expectError("zero rate", () => createOrderFor(user(a), fd({ ...base, rate: "0" })), /cents per square inch/);
    await expectError("negative thread", () => createOrderFor(user(a), fd({ ...base, threadPrice: "-3" })), /thread price/);
    await expectError("bad design", () => createOrderFor(user(a), fd({ ...base, design: "WILD" })), /pantograph or custom/);
    await expectError("bad date", () => createOrderFor(user(a), fd({ ...base, due: "soon" })), /due date/);
    await expectError("another company's customer", () => createOrderFor(user(b), fd(base)), /Customer not found/);
    assert.equal(await db.longarmOrder.count({ where: { shopId: { in: [a.shopId, b.shopId] } } }), 0, "refusals made nothing");
    const o1 = await createOrderFor(tech(a), fd(base));
    assert.equal(o1.number, 1);
    const r1 = await db.longarmOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.deepEqual([r1.shopId, r1.customerId, r1.name, r1.status, r1.quiltCents, r1.totalCents, r1.rateTenthCents, r1.taxable], [a.shopId, c1.id, "Quinn Quilter", "RECEIVED", 12_000, 17_100, 25, true]);
    assert.deepEqual([r1.threadCents, r1.battingCents, r1.extraCents, r1.designName, r1.thread, r1.extraNote], [1200, 2400, 1500, "Baptist fan", "Glide ivory", "binding"]);
    assert.equal(ymdOf(r1.dueAt!, TZ), due, "due at midday on the shop's date");
    // A new customer typed in, a flat price, not taxable, no due date.
    const o2 = await createOrderFor(user(a), fd({ widthIn: "40", lengthIn: "50", pricing: "FLAT", flat: "75", design: "CUSTOM", taxable: "off", customerName: "Walk In", customerPhone: "555-0199" }));
    assert.equal(o2.number, 2);
    const r2 = await db.longarmOrder.findUniqueOrThrow({ where: { id: o2.id } });
    assert.deepEqual([r2.pricing, r2.flatCents, r2.quiltCents, r2.totalCents, r2.taxable, r2.design, r2.dueAt, r2.name], ["FLAT", 7500, 7500, 7500, false, "CUSTOM", null, "Walk In"]);
    assert.ok(r2.customerId, "the new customer was made");
    ok("work orders: size, rate, money and date fields checked with nothing made on a refusal; numbers count up per company; price stored (size x rate + thread + batting + extras, or flat); a typed-in customer is made");

    // 3. The status flow.
    await expectError("received -> ready", () => setStatusFor(user(a), o1.id, "READY"), /can't go to ready/);
    await expectError("to collected by hand", () => setStatusFor(user(a), o1.id, "COLLECTED"), /Collect it/);
    await expectError("collect while received", () => collectFor(user(a), o1.id, null), /Only a ready work order/);
    assert.match(await setStatusFor(user(a), o1.id, "ON_FRAME"), /#1 is on the frame/);
    let s1 = await db.longarmOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.ok(s1.onFrameAt && !s1.readyAt);
    await setStatusFor(user(a), o1.id, "READY");
    s1 = await db.longarmOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.ok(s1.onFrameAt && s1.readyAt);
    await setStatusFor(user(a), o1.id, "ON_FRAME");
    assert.equal((await db.longarmOrder.findUniqueOrThrow({ where: { id: o1.id } })).readyAt, null, "a step back clears the later time");
    await expectError("same status twice", () => setStatusFor(user(a), o1.id, "ON_FRAME"), /can't go to on the frame/);
    await setStatusFor(user(a), o1.id, "CANCELLED");
    await expectError("edit a cancelled order", () => saveOrderFor(user(a), o1.id, fd(base)), /cancelled work order can't be changed/);
    await setStatusFor(user(a), o1.id, "RECEIVED");
    assert.deepEqual(MOVES.COLLECTED, [], "collected is final");
    // Editing while open recomputes the price.
    assert.match(await saveOrderFor(user(a), o1.id, fd({ ...base, widthIn: "50", lengthIn: "70", rate: "3" })), /Saved: 156\.00/);
    const e1 = await db.longarmOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.deepEqual([e1.widthIn, e1.lengthIn, e1.rateTenthCents, e1.quiltCents, e1.totalCents, e1.customerId], [50, 70, 30, 10_500, 15_600, c1.id]);
    await expectError("edit with a bad size", () => saveOrderFor(user(a), o1.id, fd({ ...base, widthIn: "x" })), /width/);
    assert.equal((await db.longarmOrder.findUniqueOrThrow({ where: { id: o1.id } })).widthIn, 50, "a refused edit changes nothing");
    ok("status flow: forward one step, back one step (later times cleared), cancel and reopen, collected only by collecting; open orders edit and re-price, closed ones don't");

    // 4. Collecting bills a register sale.
    const taken0 = await registerTakenCents(a.shopId, new Date(Date.now() - DAY), new Date(Date.now() + DAY));
    await setStatusFor(user(a), o1.id, "ON_FRAME");
    await setStatusFor(user(a), o1.id, "READY");
    assert.match(await collectFor(user(a), o1.id, fd({ method: "CARD" })), /#1 is collected: sale #\d+ in the register/);
    const c1o = await db.longarmOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.equal(c1o.status, "COLLECTED");
    assert.ok(c1o.saleId && c1o.collectedAt);
    const sale = await db.sale.findUniqueOrThrow({ where: { id: c1o.saleId! }, include: { lines: true } });
    // 15600 taxed at 8% = 1248.
    assert.deepEqual([sale.subtotalCents, sale.taxCents, sale.totalCents, sale.customerId, sale.status, sale.shopId], [15_600, 1248, 16_848, c1.id, "COMPLETED", a.shopId]);
    assert.deepEqual(sale.tenders, [{ method: "CARD", amountCents: 16_848, note: null }]);
    assert.deepEqual(sale.lines.map((l) => [l.unitPriceCents, l.taxable]).sort(), [[10_500, true], [1200, true], [1500, true], [2400, true]].sort());
    assert.ok(sale.lines.some((l) => /^Quilting #1: 50 x 70 in, pantograph \(Baptist fan\)/.test(l.description)));
    assert.ok(sale.lines.some((l) => l.description === "Thread: Glide ivory") && sale.lines.some((l) => l.description === "Batting: Warm and Natural queen") && sale.lines.some((l) => l.description === "Quilting extras: binding"));
    assert.equal((await registerTakenCents(a.shopId, new Date(Date.now() - DAY), new Date(Date.now() + DAY))) - taken0, 16_848, "taken today includes it");
    await expectError("collect twice", () => collectFor(user(a), o1.id, null), /Only a ready work order/);
    await expectError("edit collected", () => saveOrderFor(user(a), o1.id, fd(base)), /collected work order can't be changed/);
    // Voiding the sale puts the quilt back on the shelf; collecting again bills a new sale.
    await voidSaleAs(user(a), c1o.saleId!, "mistake");
    const back = await db.longarmOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.deepEqual([back.status, back.saleId, back.collectedAt], ["READY", null, null]);
    assert.equal((await registerTakenCents(a.shopId, new Date(Date.now() - DAY), new Date(Date.now() + DAY))) - taken0, 0);
    await collectFor(user(a), o1.id, fd({ method: "BOGUS" }));
    const again = await db.longarmOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.notEqual(again.saleId, c1o.saleId);
    assert.deepEqual((await db.sale.findUniqueOrThrow({ where: { id: again.saleId! } })).tenders, [{ method: "CASH", amountCents: 16_848, note: null }], "an unknown tender is cash");
    // Not taxable: no tax. Zero total: collected with no sale.
    await setStatusFor(user(a), o2.id, "ON_FRAME");
    await setStatusFor(user(a), o2.id, "READY");
    await collectFor(tech(a), o2.id, fd({ method: "CHECK" }));
    const s2 = await db.sale.findUniqueOrThrow({ where: { id: (await db.longarmOrder.findUniqueOrThrow({ where: { id: o2.id } })).saleId! } });
    assert.deepEqual([s2.subtotalCents, s2.taxCents, s2.totalCents], [7500, 0, 7500]);
    const o3 = await createOrderFor(user(a), fd({ customerId: c1.id, widthIn: "10", lengthIn: "10", pricing: "FLAT", flat: "0" }));
    await setStatusFor(user(a), o3.id, "ON_FRAME");
    await setStatusFor(user(a), o3.id, "READY");
    const salesBefore = await db.sale.count({ where: { shopId: a.shopId } });
    assert.match(await collectFor(user(a), o3.id, null), /no charge/);
    assert.equal(await db.sale.count({ where: { shopId: a.shopId } }), salesBefore);
    assert.equal((await db.longarmOrder.findUniqueOrThrow({ where: { id: o3.id } })).status, "COLLECTED");
    ok("collecting: a ready quilt is billed as a register sale (quilting, thread, batting, extras; 8% on taxable ones; the tender chosen, cash if unknown), in taken today; twice refused; voiding the sale puts it back ready; not taxable adds none; free ones make no sale");

    // 5. The calendar's due dates and the customer's history.
    const o4 = await createOrderFor(user(a), fd({ ...base, due }));
    const dayStart = zonedTime(due, 0, TZ);
    let items = await calendarItems(a.shopId, dayStart, new Date(dayStart.getTime() + DAY), { shifts: false });
    const dueItems = items.filter((i) => i.kind === "longarm");
    assert.deepEqual(dueItems.map((i) => i.id), [o4.id], "only the open order due that day (the collected one is no longer due)");
    assert.match(dueItems[0].title, /Quilt due: Quinn Quilter/);
    assert.equal(dueItems[0].href, `/longarm/${o4.id}`);
    assert.equal((await calendarItems(b.shopId, dayStart, new Date(dayStart.getTime() + DAY), { shifts: false })).filter((i) => i.kind === "longarm").length, 0);
    await setStatusFor(user(a), o4.id, "CANCELLED");
    items = await calendarItems(a.shopId, dayStart, new Date(dayStart.getTime() + DAY), { shifts: false });
    assert.equal(items.filter((i) => i.kind === "longarm").length, 0, "a cancelled order isn't due");
    assert.deepEqual((await ordersOfCustomer(a.shopId, c1.id)).map((o) => [o.number, o.status]), [[4, "CANCELLED"], [3, "COLLECTED"], [1, "COLLECTED"]], "history, newest first");
    ok("calendar and history: an open order shows on its due day, collected and cancelled ones don't; the customer's page lists theirs newest first");

    // 6. Deleting a customer with quilts.
    const open = await createOrderFor(user(a), fd({ ...base, customerId: c1.id }));
    await expectError("delete with an open work order", () => deleteCustomerFor(user(a), c1.id, "Quinn Quilter"), /isn't collected yet/);
    await setStatusFor(user(a), open.id, "CANCELLED");
    await deleteCustomerFor(user(a), c1.id, "Quinn Quilter");
    const kept = await db.longarmOrder.findUniqueOrThrow({ where: { id: o1.id } });
    assert.deepEqual([kept.customerId, kept.name, kept.totalCents], [null, "Deleted customer", 15_600], "the order stays in the books without the person");
    ok("deleting a customer: refused while a work order is open; then the orders stay as 'Deleted customer'");

    // 7. Longarm rental: an hourly type for certified customers, billed at the register.
    await expectError("tech sets the type", () => saveApptTypeAs(tech(a), null, fd({ name: "x" })), /owner or admin/);
    await expectError("bad hourly", () => saveApptTypeAs(user(a), null, fd({ name: "Longarm rental", minutes: "60", fee: "0", capacity: "1", hourly: "free" })), /hourly rate/);
    const typeId = await saveApptTypeAs(user(a), null, fd({ name: "Longarm rental", minutes: "60", fee: "0", capacity: "1", resource: "Longarm", hourly: "25", needsCert: "on", taxable: "on" }));
    const type = await db.appointmentType.findUniqueOrThrow({ where: { id: typeId } });
    assert.deepEqual([type.hourlyCents, type.needsCert, type.taxable, type.shopId], [2500, true, true, a.shopId]);
    const renter = await mk(a.shopId, "Rae Renter");
    const day = ymdOf(new Date(Date.now() + 2 * DAY), TZ);
    const book = (customerId: string, start: string, end: string) => bookAs(user(a), fd({ typeId, date: day, start, end, customerId }));
    await expectError("not certified", () => book(renter.id, "10:00", "11:30"), /Rae Renter isn't certified on the Longarm/);
    assert.equal(await db.appointment.count({ where: { shopId: a.shopId, typeId } }), 0, "nothing booked");
    await expectError("tech certifies", () => setCertifiedFor(tech(a), renter.id, true), /owner or an admin/);
    assert.match(await setCertifiedFor(user(a), renter.id, true), /certified to rent/);
    assert.ok((await db.customer.findUniqueOrThrow({ where: { id: renter.id } })).longarmCertifiedAt);
    const booked = await book(renter.id, "10:00", "11:30");
    const ap = await db.appointment.findUniqueOrThrow({ where: { id: booked.id } });
    assert.deepEqual([ap.feeCents, ap.taxable, ap.resource, ap.customerId, ap.status], [3750, true, "Longarm", renter.id, "BOOKED"], "an hour and a half at $25 an hour");
    await expectError("the machine is taken", () => book(renter.id, "11:00", "12:00"), /Longarm is already booked then/);
    const two = await book(renter.id, "13:00", "15:00");
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id: two.id } })).feeCents, 5000, "two hours");
    await rescheduleApptAs(user(a), two.id, fd({ date: day, start: "13:00", end: "14:00" }));
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id: two.id } })).feeCents, 2500, "moved to one hour: priced again");
    const items2 = await calendarItems(a.shopId, zonedTime(day, 0, TZ), zonedTime(day, 24 * 60, TZ), { shifts: false });
    assert.equal(items2.filter((i) => i.kind === "appointment" && i.title === "Longarm rental").length, 2, "on the calendar");
    // Billed at the register.
    const due1 = (await bookingsDueFor(a.shopId, TZ, renter.id)).filter((d) => d.kind === "appointment");
    assert.deepEqual(due1.map((d) => d.dueCents).sort((x, y) => x - y), [2500, 3750]);
    const rental = due1.find((d) => d.dueCents === 3750)!;
    const paid = await completeSaleAs(user(a), { customerId: renter.id, lines: [{ appointmentId: rental.id, qty: 1, unitPriceCents: 3750, description: rental.description, taxable: true }], tenders: [{ method: "CASH", amountCents: 4050, note: null }] });
    const rs = await db.sale.findUniqueOrThrow({ where: { id: paid.saleId } });
    assert.deepEqual([rs.subtotalCents, rs.taxCents, rs.totalCents], [3750, 300, 4050]);
    const pa = await db.appointment.findUniqueOrThrow({ where: { id: rental.id } });
    assert.deepEqual([pa.paidCents, pa.paidAt !== null], [3750, true]);
    await rescheduleApptAs(user(a), rental.id, fd({ date: day, start: "10:00", end: "10:30" }));
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id: rental.id } })).feeCents, 3750, "paid: the fee is not priced again");
    // Take the certification away: no more bookings. A certified-only type is never offered online.
    assert.match(await setCertifiedFor(user(a), renter.id, false), /no longer certified/);
    await expectError("certification taken away", () => book(renter.id, "16:00", "17:00"), /isn't certified/);
    await db.appointmentType.update({ where: { id: typeId }, data: { online: true } });
    assert.deepEqual((await publicTypes(a.shopId)).map((t) => t.id), [], "certified-only: not online");
    await db.appointmentType.update({ where: { id: typeId }, data: { needsCert: false } });
    assert.deepEqual((await publicTypes(a.shopId)).map((t) => t.id), [typeId], "an hourly type without the flag is offered");
    ok("rental: an hourly type for certified customers; refused without the flag (nothing booked), by the hour to the cent, the machine can't be double booked, moving re-prices an unpaid booking, billed at the register with tax, taking the flag away refuses again, never offered online");

    // 8. Tenant: B with A's ids.
    const photo = await db.longarmPhoto.create({ data: { shopId: a.shopId, orderId: o2.id, mime: "image/jpeg", data: Buffer.from("x") } });
    const tables = ["LongarmOrder", "LongarmPhoto", "Customer", "Sale", "Appointment", "AppointmentType", "Shop"];
    const snap = await snapshot(a.shopId, tables);
    assert.equal(await orderView(b.shopId, o2.id), null);
    assert.deepEqual(await ordersFor(b.shopId), []);
    assert.deepEqual(await ordersFor(b.shopId, { closed: true }), []);
    assert.deepEqual(await ordersOfCustomer(b.shopId, renter.id), []);
    await expectNotFound("saveOrderFor(B)", () => saveOrderFor(user(b), o4.id, fd(base)));
    await expectNotFound("setStatusFor(B)", () => setStatusFor(user(b), o4.id, "RECEIVED"));
    await expectNotFound("collectFor(B)", () => collectFor(user(b), o2.id, null));
    await expectNotFound("deletePhotoFor(B)", () => deletePhotoFor(user(b), photo.id));
    await expectNotFound("setCertifiedFor(B, A's customer)", () => setCertifiedFor(user(b), renter.id, true));
    await expectNotFound("createOrderFor(B, A's customer)", () => createOrderFor(user(b), fd({ ...base, customerId: renter.id })));
    await expectError("book A's type as B", () => bookAs(user(b), fd({ typeId, date: day, start: "10:00", end: "11:00", customerId: cB.id })), /Pick what they're booking/);
    assert.equal(await db.longarmPhoto.count({ where: { id: photo.id } }), 1);
    assertUnchanged("tenant", snap, await snapshot(a.shopId, tables));
    assert.equal(await db.longarmOrder.count({ where: { shopId: b.shopId } }), 0);
    ok("tenant: B can't read, list, change, move, collect, photograph, certify or book anything of A's; A's rows are unchanged");
  } finally {
    await cleanup();
  }
  console.log(`longarm.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
