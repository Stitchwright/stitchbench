// Online booking (online-and-parts-design.md section 2, package online-booking): the settings (slug, on, lead time,
// how far ahead, the types and classes offered), the public shop by slug (off, module off), free times that honour
// lead time, how far ahead, hours and capacity, a booking that matches the customer by mobile or email and records
// how to tell them, the confirmation with its manage link, the last-slot race, the manage link (view, move, cancel,
// too close, expired), a class sign-up with the waiting list, and the tenant section.
//   npm run check scripts/checks/online-booking.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { bookingSettings, bookOnline, cancelByToken, freeTimesForMove, manageByToken, moveByToken, publicClasses, publicFreeTimes, publicShop, publicTypes, saveBookingSettingsFor, signUpOnline, slugOf, SLUG_RE } from "@/lib/online-booking";
import { addDays, ymdOf, zonedTime } from "@/lib/zoned";
import { checkShop, cleanup, clearKick, messagingFor, withSink } from "./lib";
import { RUN } from "./tenant";

const NY = "America/New_York";
const DAY = 86_400_000;
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

function form(entries: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

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

const cust = (name: string, phone: string | null, email: string | null, notify = "email") => ({ name, phone, email, notify });

async function main() {
  await withSink();
  const a = await checkShop({ retail: true, repair: true, modules: ["scheduling", "marketing"] });
  const b = await checkShop({ retail: true, modules: ["scheduling"] });
  const off = await checkShop({ retail: true }); // no Scheduling
  const slugA = `check-${RUN}-a`;
  const slugB = `check-${RUN}-b`;
  try {
    await messagingFor(a.shopId, { email: true });
    const now = new Date();
    const today = ymdOf(now, NY);
    // A type bookable every day 9:00-17:00, 60 minutes, one at a time; another not online.
    const everyDay = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: "09:00", to: "17:00" }));
    const fitting = await db.appointmentType.create({ data: { shopId: a.shopId, name: "Machine fitting", minutes: 60, capacity: 1, feeCents: 2500, hours: everyDay, online: false } });
    const privateType = await db.appointmentType.create({ data: { shopId: a.shopId, name: "Staff only", minutes: 30, capacity: 1, hours: [] } });
    const classDay = addDays(today, 10);
    const cls = await db.shopClass.create({ data: { shopId: a.shopId, title: `Serger Basics ${RUN}`, seats: 1, feeCents: 3000, waitlist: true, firstAt: zonedTime(classDay, 18 * 60, NY), lastAt: zonedTime(classDay, 20 * 60, NY), meetings: { create: { shopId: a.shopId, startsAt: zonedTime(classDay, 18 * 60, NY), endsAt: zonedTime(classDay, 20 * 60, NY) } } } });

    // 1. Settings.
    assert.equal(slugOf("Sew & Vac Center"), "sew-and-vac-center");
    assert.ok(SLUG_RE.test(slugA) && !SLUG_RE.test("Bad Slug") && !SLUG_RE.test("ab"));
    await expectError("on without a slug", () => saveBookingSettingsFor(a.user, form({ slug: "", on: "on" })), /address first/);
    await expectError("bad lead", () => saveBookingSettingsFor(a.user, form({ slug: slugA, leadHours: "-1" })), /Lead time/);
    await saveBookingSettingsFor(a.user, form({ slug: slugA, on: "on", leadHours: "24", daysAhead: "30", welcome: "Welcome!", type: [fitting.id], class: [cls.id] }));
    let s = await bookingSettings(a.shopId);
    assert.ok(s.slug === slugA && s.on && s.leadHours === 24 && s.daysAhead === 30 && s.welcome === "Welcome!");
    assert.deepEqual(s.types.filter((t) => t.online).map((t) => t.id), [fitting.id]);
    assert.deepEqual(s.classes.filter((c) => c.online).map((c) => c.id), [cls.id]);
    await expectError("B takes A's slug", () => saveBookingSettingsFor(b.user, form({ slug: slugA, on: "on" })), /is taken/);
    await expectError("a tech", () => saveBookingSettingsFor({ ...a.user, role: "TECH" }, form({ slug: slugA })), /owner or admin/);
    await expectError("no Scheduling", () => saveBookingSettingsFor(off.user, form({ slug: `check-${RUN}-off`, on: "on" })), /Scheduling/);
    ok("settings: the slug, on, lead time, how far ahead, welcome, the types and classes offered; a taken slug, a tech and a shop without Scheduling are refused");

    // 2. The public shop by slug; switched off; the module off.
    const shop = await publicShop(slugA);
    assert.ok(shop && shop.open && shop.id === a.shopId && shop.leadHours === 24 && shop.daysAhead === 30);
    assert.equal(await publicShop("no-such-shop"), null);
    assert.equal(await publicShop("Bad Slug"), null);
    await saveBookingSettingsFor(a.user, form({ slug: slugA, leadHours: "24", daysAhead: "30", type: [fitting.id], class: [cls.id] })); // off
    assert.equal((await publicShop(slugA))?.open, false);
    await saveBookingSettingsFor(a.user, form({ slug: slugA, on: "on", leadHours: "24", daysAhead: "30", type: [fitting.id], class: [cls.id] }));
    const types = await publicTypes(a.shopId);
    assert.deepEqual(
      types.map((t) => t.id),
      [fitting.id],
      "the staff-only type isn't offered",
    );
    void privateType;
    const classes = await publicClasses(a.shopId, now);
    assert.deepEqual(
      classes.map((c) => [c.id, c.seatsLeft, c.waitlist]),
      [[cls.id, 1, true]],
    );
    ok("publicShop by slug: open only when switched on; the offered type and class are listed");

    // 3. Free times honour the lead time, how far ahead, hours and capacity.
    const free = await publicFreeTimes(shop!, types[0], null, now);
    assert.equal(free.length, 14);
    const all = free.flatMap((d) => d.starts);
    assert.ok(all.length > 0);
    assert.ok(all.every((t) => t.getTime() >= now.getTime() + 24 * 3_600_000), "nothing inside the lead time");
    assert.ok(all.every((t) => t.getTime() <= now.getTime() + 30 * DAY));
    const far = await publicFreeTimes(shop!, types[0], addDays(today, 40), now);
    assert.equal(far.flatMap((d) => d.starts).length, 0, "beyond how far ahead: nothing");
    const slot = all.find((t) => ymdOf(t, NY) === addDays(today, 3))!;
    assert.ok(slot, "a free time three days out");
    ok("free times: 14 days, none inside the lead time or past how far ahead");

    // 4. Booking: the customer is made with how to tell them, the appointment is online, the confirmation carries the manage link.
    const r1 = await bookOnline({ slug: slugA, typeId: fitting.id, startsAt: slot, customer: cust("Olivia Online", "(212) 555-0199", "olivia@example.test"), note: "First time here" }, now);
    const a1 = await db.appointment.findUniqueOrThrow({ where: { id: r1.appointmentId }, include: { customer: true } });
    assert.ok(a1.source === "online" && a1.status === "BOOKED" && a1.typeId === fitting.id && a1.feeCents === 2500 && a1.note === "First time here");
    assert.ok(a1.customer && a1.customer.phone === "+12125550199" && a1.customer.email === "olivia@example.test" && a1.customer.notifyBy === "email" && a1.customer.kind === "RETAIL");
    const consent = await db.consentEvent.findMany({ where: { shopId: a.shopId, customerId: a1.customerId! } });
    assert.ok(consent.some((c) => c.event === "notify_pref" && c.source === "online booking"));
    const msgs = await db.outMessage.findMany({ where: { shopId: a.shopId, refType: "appointment", refId: a1.id } });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].kind, "booking_notice");
    assert.match(msgs[0].body, /Machine fitting/);
    assert.match(msgs[0].body, new RegExp(`/book/m/${r1.token}`));
    // The same person again (by email only this time): matched, not duplicated.
    const slot2 = all.find((t) => ymdOf(t, NY) === addDays(today, 4))!;
    const r2 = await bookOnline({ slug: slugA, typeId: fitting.id, startsAt: slot2, customer: cust("O. Online", null, "OLIVIA@example.test", "none"), note: null }, now);
    const a2 = await db.appointment.findUniqueOrThrow({ where: { id: r2.appointmentId } });
    assert.equal(a2.customerId, a1.customerId, "matched by email, any case");
    assert.equal(await db.customer.count({ where: { shopId: a.shopId, email: { equals: "olivia@example.test", mode: "insensitive" } } }), 1);
    assert.equal((await db.customer.findUniqueOrThrow({ where: { id: a1.customerId! } })).notifyBy, "email", "a later form's choice doesn't change the record");
    // A type rented by the hour: the appointment and its confirmation carry the hourly fee (90 minutes at $20 = $30), not the ignored flat fee.
    const rental = await db.appointmentType.create({ data: { shopId: a.shopId, name: "Longarm rental", minutes: 90, capacity: 1, feeCents: 0, hourlyCents: 2000, hours: everyDay, online: true } });
    const rr = await bookOnline({ slug: slugA, typeId: rental.id, startsAt: slot2, customer: cust("Rita Rental", null, "rita@example.test"), note: null }, now);
    const ra = await db.appointment.findUniqueOrThrow({ where: { id: rr.appointmentId } });
    assert.equal(ra.feeCents, 3000);
    const rm = await db.outMessage.findFirstOrThrow({ where: { shopId: a.shopId, refType: "appointment", refId: ra.id } });
    assert.match(rm.body, /Fee: \$30\.00, paid at the counter/, "the confirmation quotes the hourly fee");
    await db.appointment.delete({ where: { id: ra.id } });
    await db.appointmentType.update({ where: { id: rental.id }, data: { online: false } });
    // Refusals.
    await expectError("inside the lead time", () => bookOnline({ slug: slugA, typeId: fitting.id, startsAt: new Date(now.getTime() + 3_600_000), customer: cust("Xavier Example", "2125550100", null), note: null }, now), /earliest time/);
    await expectError("too far ahead", () => bookOnline({ slug: slugA, typeId: fitting.id, startsAt: zonedTime(addDays(today, 45), 10 * 60, NY), customer: cust("Xavier Example", "2125550100", null), note: null }, now), /days ahead/);
    await expectError("outside hours", () => bookOnline({ slug: slugA, typeId: fitting.id, startsAt: zonedTime(addDays(today, 5), 7 * 60, NY), customer: cust("Xavier Example", "2125550100", null), note: null }, now), /can be booked/);
    await expectError("not online", () => bookOnline({ slug: slugA, typeId: privateType.id, startsAt: slot, customer: cust("Xavier Example", "2125550100", null), note: null }, now), /isn't offered online/);
    await expectError("no way to reach them", () => bookOnline({ slug: slugA, typeId: fitting.id, startsAt: slot2, customer: cust("Xavier Example", null, null), note: null }, now), /mobile number or an email/);
    await expectError("text without a mobile", () => bookOnline({ slug: slugA, typeId: fitting.id, startsAt: slot2, customer: cust("Xavier Example", null, "x@example.test", "sms"), note: null }, now), /Texts need a mobile/);
    const trade = await db.customer.create({ data: { shopId: a.shopId, name: "Trade Co", kind: "TRADE", email: "trade@example.test" } });
    await expectError("a trade account", () => bookOnline({ slug: slugA, typeId: fitting.id, startsAt: slot2, customer: cust("Trade Co", null, trade.email, "email"), note: null }, now), /trade account/);
    ok("booking: the customer is made (or matched by mobile or email) with how to tell them and its consent record; the confirmation carries the manage link; the refusals");

    // 4b. A public form proves nothing about who is typing: someone who knows a customer's number books with it, their own
    // email and "tell me by email". The booking still links to that customer for staff, but the customer's contact and
    // way to tell them stay as they were, the stored name isn't shown back, and staff get a note of what the form gave.
    const victim = await db.customer.create({ data: { shopId: a.shopId, kind: "RETAIL", name: "Victoria Vance", phone: "+12125550177", notifyBy: "sms" } });
    const consentBefore = await db.consentEvent.count({ where: { shopId: a.shopId, customerId: victim.id } });
    const slotV = all.find((t) => ymdOf(t, NY) === addDays(today, 7))!;
    const rv = await bookOnline({ slug: slugA, typeId: fitting.id, startsAt: slotV, customer: cust("Anyone Atall", "(212) 555-0177", "taker@example.test", "email"), note: "hi" }, now);
    const av = await db.appointment.findUniqueOrThrow({ where: { id: rv.appointmentId } });
    assert.equal(av.customerId, victim.id, "a returning customer's booking still links to their record");
    const vAfter = await db.customer.findUniqueOrThrow({ where: { id: victim.id } });
    assert.equal(vAfter.email, null, "the form's email isn't added to an existing customer");
    assert.equal(vAfter.notifyBy, "sms", "the form doesn't change how an existing customer is told");
    assert.equal(vAfter.phone, "+12125550177");
    assert.equal(await db.consentEvent.count({ where: { shopId: a.shopId, customerId: victim.id } }), consentBefore, "no preference recorded for them");
    assert.equal(av.name, "Anyone Atall", "the booking carries the name the form gave");
    const mv = await manageByToken(rv.token, now);
    assert.ok(mv && mv.view.firstName === "Anyone", `the manage page doesn't reveal the stored name (got ${mv?.view.firstName})`);
    assert.ok(av.note?.startsWith("hi\n") && /email taker@example\.test/.test(av.note) && /tell by email/.test(av.note) && /name "Anyone Atall"/.test(av.note), `staff see what the form gave: ${av.note}`);
    const vm = await db.outMessage.findMany({ where: { shopId: a.shopId, refType: "appointment", refId: av.id } });
    assert.ok(vm.every((m) => m.address !== "taker@example.test"), "nothing about the customer goes to the address the form typed");
    // The same customer typed exactly as on record: no note for staff.
    const slotW = all.find((t) => ymdOf(t, NY) === addDays(today, 8))!;
    const rw = await bookOnline({ slug: slugA, typeId: fitting.id, startsAt: slotW, customer: cust("victoria vance", "2125550177", null, "sms"), note: null }, now);
    const aw = await db.appointment.findUniqueOrThrow({ where: { id: rw.appointmentId } });
    assert.ok(aw.customerId === victim.id && aw.note === null, `nothing new, no note: ${aw.note}`);
    // A class sign-up is the same: the roster keeps the name the form gave; the customer is untouched.
    const ev = await signUpOnline({ slug: slugA, classId: cls.id, customer: cust("Anyone Atall", "2125550177", "taker@example.test", "email"), attendee: null, note: null }, now);
    const env = await db.enrollment.findUniqueOrThrow({ where: { id: ev.enrollmentId } });
    assert.ok(env.customerId === victim.id && env.name === "Anyone Atall" && /email taker@example\.test/.test(env.note ?? ""), `enrollment: ${env.name} / ${env.note}`);
    assert.equal((await db.customer.findUniqueOrThrow({ where: { id: victim.id } })).email, null);
    await db.enrollment.delete({ where: { id: env.id } });
    await db.appointment.deleteMany({ where: { id: { in: [av.id, aw.id] } } });
    ok("a public form never changes an existing customer's contact or way to tell them, nor shows their stored name; staff get a note of what it gave");

    // 5. The last slot: two customers at once, one gets it.
    const slot3 = all.find((t) => ymdOf(t, NY) === addDays(today, 5))!;
    const results = await Promise.allSettled([
      bookOnline({ slug: slugA, typeId: fitting.id, startsAt: slot3, customer: cust("Race One", "2125550101", null, "none"), note: null }, now),
      bookOnline({ slug: slugA, typeId: fitting.id, startsAt: slot3, customer: cust("Race Two", "2125550102", null, "none"), note: null }, now),
    ]);
    const won = results.filter((r) => r.status === "fulfilled").length;
    const lost = results.filter((r) => r.status === "rejected" && isUserError(r.reason) && /just taken/.test(r.reason.message)).length;
    assert.equal(won, 1);
    assert.equal(lost, 1);
    assert.equal(await db.appointment.count({ where: { shopId: a.shopId, startsAt: slot3, status: "BOOKED" } }), 1);
    const freeAfter = await publicFreeTimes(shop!, types[0], null, now);
    assert.ok(!freeAfter.flatMap((d) => d.starts).some((t) => t.getTime() === slot3.getTime()), "the taken time is no longer offered");
    ok("the last slot: of two bookings at once, one wins and the other hears it was just taken; the time leaves the list");

    // 6. The manage link: view, move, cancel; too close; expired.
    const m1 = await manageByToken(r1.token, now);
    assert.ok(m1 && m1.view.kind === "appointment" && m1.view.what === "Machine fitting" && m1.view.canCancel && m1.view.canMove && m1.view.firstName === "Olivia" && m1.view.feeCents === 2500);
    assert.equal(await manageByToken("not-a-token", now), null);
    const slot4 = freeAfter.flatMap((d) => d.starts).find((t) => ymdOf(t, NY) === addDays(today, 6))!;
    await moveByToken(r1.token, slot4, now);
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id: a1.id } })).startsAt.getTime(), slot4.getTime());
    await expectError("move onto a taken time", () => moveByToken(r1.token, slot3, now), /just taken/);
    // A type the shop no longer offers online (off the booking page, switched off, or now needing a certification) can't be moved into new times.
    const slot5 = freeAfter.flatMap((d) => d.starts).find((t) => ymdOf(t, NY) === addDays(today, 7))!;
    for (const off of [{ online: false }, { active: false }, { needsCert: true }]) {
      await db.appointmentType.update({ where: { id: fitting.id }, data: off });
      await expectError(`move a type no longer offered (${Object.keys(off)[0]})`, () => moveByToken(r1.token, slot5, now), /call the shop/);
      assert.deepEqual(await freeTimesForMove(m1, null, now), [], "no times are offered for a type no longer offered online");
      await db.appointmentType.update({ where: { id: fitting.id }, data: { online: true, active: true, needsCert: false } });
    }
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id: a1.id } })).startsAt.getTime(), slot4.getTime(), "the booking stayed where it was");
    await cancelByToken(r1.token, now);
    const c1 = await db.appointment.findUniqueOrThrow({ where: { id: a1.id } });
    assert.ok(c1.status === "CANCELLED" && c1.cancelledAt);
    assert.equal((await db.outMessage.findFirst({ where: { refType: "appointment", refId: a1.id } }))?.status, "CANCELLED", "the queued confirmation is cancelled");
    await expectError("cancel twice", () => cancelByToken(r1.token, now), /too close|expired/);
    // Too close: a booking 30 hours out, looked at 10 hours before it.
    const m2 = await manageByToken(r2.token, new Date(slot2.getTime() - 10 * 3_600_000));
    assert.ok(m2 && !m2.view.canCancel && !m2.view.canMove);
    await expectError("too close to cancel", () => cancelByToken(r2.token, new Date(slot2.getTime() - 10 * 3_600_000)), /too close/);
    assert.equal(await manageByToken(r2.token, new Date(slot2.getTime() + 3 * DAY)), null, "expired a day after the appointment");
    ok("the manage link shows the booking, moves it (not onto a taken time), cancels it and its queued messages; too close to the time or expired, it does nothing");

    // 7. A class: the first sign-up takes the seat and is confirmed; the second goes on the waiting list without a confirmation.
    const e1 = await signUpOnline({ slug: slugA, classId: cls.id, customer: cust("Sue Student", "2125550103", "sue@example.test"), attendee: null, note: null }, now);
    assert.equal(e1.status, "ENROLLED");
    const en1 = await db.enrollment.findUniqueOrThrow({ where: { id: e1.enrollmentId } });
    assert.ok(en1.source === "online" && en1.feeCents === 3000);
    const cm = await db.outMessage.findMany({ where: { shopId: a.shopId, refType: "enrollment", refId: en1.id } });
    assert.equal(cm.length, 1);
    assert.match(cm[0].body, /Serger Basics/);
    const e2 = await signUpOnline({ slug: slugA, classId: cls.id, customer: cust("Wendy Waits", "2125550104", null, "none"), attendee: "Her daughter", note: null }, now);
    assert.equal(e2.status, "WAITLIST");
    assert.equal(await db.outMessage.count({ where: { shopId: a.shopId, refType: "enrollment", refId: e2.enrollmentId } }), 0);
    const mw = await manageByToken(e2.token, now);
    assert.ok(mw && mw.view.kind === "enrollment" && mw.view.status === "WAITLIST" && mw.view.what === "Serger Basics " + RUN + " for Her daughter" && mw.view.canCancel && !mw.view.canMove);
    await cancelByToken(e2.token, now);
    assert.equal((await db.enrollment.findUniqueOrThrow({ where: { id: e2.enrollmentId } })).status, "CANCELLED");
    assert.deepEqual(
      (await publicClasses(a.shopId, now)).map((c) => [c.seatsLeft]),
      [[0]],
      "full, still listed for its waiting list",
    );
    await expectError("the same person twice", () => signUpOnline({ slug: slugA, classId: cls.id, customer: cust("Sue Student", "2125550103", null, "none"), attendee: null, note: null }, now), /already/);
    ok("a class: the seat, the confirmation, the waiting list without one, the attendee in the words, cancel from the link");

    // 8. Tenant: B's slug never shows A's types or classes; A's token works only on A's booking; the slug is per shop.
    await saveBookingSettingsFor(b.user, form({ slug: slugB, on: "on", leadHours: "0", daysAhead: "30" }));
    const sb = await publicShop(slugB);
    assert.ok(sb && sb.id === b.shopId);
    assert.deepEqual(await publicTypes(b.shopId), []);
    assert.deepEqual(await publicClasses(b.shopId, now), []);
    await expectError("A's type through B's slug", () => bookOnline({ slug: slugB, typeId: fitting.id, startsAt: slot2, customer: cust("Xavier Example", "2125550100", null, "none"), note: null }, now), /isn't offered online/);
    await expectError("A's class through B's slug", () => signUpOnline({ slug: slugB, classId: cls.id, customer: cust("Xavier Example", "2125550100", null, "none"), attendee: null, note: null }, now), /isn't offered online/);
    assert.equal(await db.customer.count({ where: { shopId: b.shopId } }), 0, "nothing of A's reached B");
    s = await bookingSettings(b.shopId);
    assert.equal(s.slug, slugB);
    ok("tenant: another company's slug offers only its own types and classes, and makes none of the other's customers");
  } finally {
    clearKick();
    await cleanup();
  }
  console.log(`online-booking.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
