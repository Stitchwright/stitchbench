// Appointments (scheduling-messaging-design.md 15.6 acceptance 2): hours round trip and edges, a shared resource under
// parallel bookings, a block holding it, a busy staff member, rescheduling past itself, freeWeek, DST, calendarItems,
// another company's type.
//   npm run check scripts/checks/appointments.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { freeSlots, freeWeek, hoursFromForm, hoursOf, hoursText, poolKey, withinHours } from "@/lib/appointments";
import { bookAs, rescheduleApptAs, saveApptTypeAs, setApptStatusAs } from "@/lib/appointment-actions";
import { calendarItems } from "@/lib/calendar";
import { dayStart, wall, zonedTime } from "@/lib/zoned";
import { checkShop, cleanup, type CheckShop } from "./lib";

const NY = "America/New_York";
const NOW = new Date("2027-03-01T15:00:00Z");
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
/** Tue-Sat 10:00-17:00 as the type form posts it. */
const tueSat = () => Object.fromEntries([2, 3, 4, 5, 6].flatMap((d) => [[`day${d}`, "on"], [`from${d}`, "10:00"], [`to${d}`, "17:00"]]));

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

async function customer(shopId: string, name = `Cust ${uniq()}`) {
  return db.customer.create({ data: { shopId, name, kind: "RETAIL", phone: `+1212555${String(1000 + n++).slice(-4)}`, notifyBy: "sms" }, select: { id: true } });
}

async function main() {
  const t0 = Date.now();
  try {
    const a = await checkShop({ retail: true, repair: true, modules: ["scheduling"] });
    const S = a.shopId;

    // ---- hours
    const h = hoursFromForm(fd(tueSat()));
    assert.equal(h.length, 5);
    assert.equal(hoursText(h), "Tue-Sat 10:00-17:00");
    assert.equal(hoursText(hoursOf(JSON.parse(JSON.stringify(h)))), "Tue-Sat 10:00-17:00", "round trip through JSON");
    assert.equal(hoursText([]), "any time");
    assert.equal(hoursText([{ day: 1, from: "09:00", to: "12:00" }, { day: 3, from: "09:00", to: "12:00" }, { day: 6, from: "10:00", to: "14:00" }]), "Mon, Wed 09:00-12:00, Sat 10:00-14:00");
    assert.throws(() => hoursFromForm(fd({ day2: "on", from2: "17:00", to2: "10:00" })), (e: unknown) => isUserError(e) && /^Tuesday: the closing time must be after the opening time\.$/.test((e as Error).message));
    // 2027-03-02 is a Tuesday
    const at = (ymd: string, hm: number) => zonedTime(ymd, hm, NY);
    assert.equal(withinHours(h, at("2027-03-02", 600), at("2027-03-02", 720), NY), true, "10:00-12:00 Tuesday");
    assert.equal(withinHours(h, at("2027-03-02", 900), at("2027-03-02", 1020), NY), true, "ends exactly at closing");
    assert.equal(withinHours(h, at("2027-03-02", 960), at("2027-03-02", 1080), NY), false, "runs past closing");
    assert.equal(withinHours(h, at("2027-03-02", 540), at("2027-03-02", 660), NY), false, "starts before opening");
    assert.equal(withinHours(h, at("2027-03-01", 600), at("2027-03-01", 720), NY), false, "Monday is closed");
    assert.equal(withinHours([], at("2027-03-01", 60), at("2027-03-01", 120), NY), true, "no hours = any time");
    ok("hoursFromForm / hoursText round trip, the closing-time error, withinHours at the edges and on a closed day");

    // ---- types: a rental and a lesson share the Longarm (capacity 1); a mismatch is refused
    const rental = await saveApptTypeAs(user(a), null, fd({ name: "Longarm rental", minutes: "120", fee: "40.00", capacity: "1", resource: "Longarm", ...tueSat() }));
    const lesson = await saveApptTypeAs(user(a), null, fd({ name: "Longarm lesson", minutes: "60", fee: "25.00", capacity: "1", resource: "longarm", ...tueSat() }));
    await expectError("capacity mismatch", () => saveApptTypeAs(user(a), null, fd({ name: "Longarm party", minutes: "60", fee: "0", capacity: "2", resource: "Longarm" })), /^Other types using Longarm allow 1 at once\. Use the same number\.$/);
    const dropoff = await saveApptTypeAs(user(a), null, fd({ name: "Machine drop-off", minutes: "15", fee: "0", capacity: "3" }));
    const rentalType = await db.appointmentType.findUniqueOrThrow({ where: { id: rental } });
    assert.equal(poolKey(S, rentalType), `res:${S}:longarm`);
    assert.equal(poolKey(S, { id: dropoff, resource: null }), `appt-type:${dropoff}`);
    await expectError("tech can't add types", () => saveApptTypeAs({ ...user(a), role: "TECH" }, null, fd({ name: "x", minutes: "30", fee: "0", capacity: "1" })), /^Only an owner or admin can do that\.$/);
    ok("types: a rental and a lesson share the Longarm; another capacity for it is refused; the pool key; techs can't add types");

    // ---- parallel bookings of both at 10:00 Tuesday: one booked, one refused
    const [c1, c2] = await Promise.all([customer(S, "Rita Rents"), customer(S, "Lee Learns")]);
    const r = await Promise.allSettled([
      bookAs(user(a), fd({ typeId: rental, date: "2027-03-02", start: "10:00", customerId: c1.id }), NOW),
      bookAs(user(a), fd({ typeId: lesson, date: "2027-03-02", start: "10:00", customerId: c2.id }), NOW),
    ]);
    const won = r.filter((x) => x.status === "fulfilled");
    const lost = r.filter((x) => x.status === "rejected");
    assert.equal(won.length, 1, r.map((x) => (x.status === "rejected" ? String((x.reason as Error).message) : "ok")).join(" | "));
    assert.equal(lost.length, 1);
    assert.match(String((lost[0] as PromiseRejectedResult).reason.message), /^Longarm is already booked then \(1 of 1\)\. Pick another time\.$/);
    const booked = await db.appointment.findMany({ where: { shopId: S, status: "BOOKED" } });
    assert.equal(booked.length, 1);
    assert.equal(booked[0].resource, "Longarm", "the resource is snapshotted as the type spells it");
    assert.ok(booked[0].feeCents === 4000 || booked[0].feeCents === 2500);
    // A free-standing type (no resource, capacity 3) isn't affected, and holds three at once.
    const drops = await Promise.all([1, 2, 3].map(async () => bookAs(user(a), fd({ typeId: dropoff, date: "2027-03-02", start: "10:00", customerId: (await customer(S)).id }), NOW)));
    assert.equal(drops.length, 3);
    await expectError("4th drop-off", async () => bookAs(user(a), fd({ typeId: dropoff, date: "2027-03-02", start: "10:00", customerId: (await customer(S)).id }), NOW), /^Machine drop-off is already booked then \(3 of 3\)\./);
    ok("parallel rental + lesson at 10:00: one booked, one 'Longarm is already booked then (1 of 1)'; a 3-at-once type holds three");

    // ---- a block holds the resource; hours; the past; a tech can't block
    const block = await bookAs(user(a), fd({ typeId: rental, date: "2027-03-03", start: "10:00", end: "17:00", block: "on", title: "Longarm maintenance" }), NOW);
    await expectError("blocked", async () => bookAs(user(a), fd({ typeId: lesson, date: "2027-03-03", start: "14:00", customerId: (await customer(S)).id }), NOW), /^Longarm is already booked then \(1 of 1\)\./);
    await expectError("block needs a reason", () => bookAs(user(a), fd({ typeId: rental, date: "2027-03-04", start: "10:00", block: "on" }), NOW), /^Say why, like 'Longarm maintenance'\.$/);
    await expectError("tech can't block", () => bookAs({ ...user(a), role: "TECH" }, fd({ typeId: rental, date: "2027-03-04", start: "10:00", block: "on", title: "x" }), NOW), /^Only an owner or admin can block time\.$/);
    await expectError("outside hours", async () => bookAs(user(a), fd({ typeId: rental, date: "2027-03-01", start: "10:00", customerId: (await customer(S)).id }), NOW), /^Longarm rental can be booked Tue-Sat 10:00-17:00\. Pick another time\.$/);
    const monday = await bookAs(user(a), fd({ typeId: rental, date: "2027-03-01", start: "10:00", customerId: (await customer(S)).id, outsideHours: "on" }), NOW);
    assert.ok(monday.id, "an admin may book outside the hours");
    await expectError("the past", async () => bookAs(user(a), fd({ typeId: rental, date: "2027-02-20", start: "10:00", customerId: (await customer(S)).id }), NOW), /^That time has passed\.$/);
    await expectError("no customer", () => bookAs(user(a), fd({ typeId: rental, date: "2027-03-05", start: "10:00" }), NOW), /^Pick or add the customer\.$/);
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id: block.id } })).blocked, true);
    ok("a block holds the resource and needs a reason; techs can't block; hours are enforced unless an admin ticks outside; the past and a missing customer refuse");

    // ---- the same staff member on two types; rescheduling excludes itself
    const sue = await db.user.create({ data: { shopId: S, email: `sue-${uniq()}@stitchbench.test`, name: "Sue Staff", role: "TECH", passwordHash: "x" }, select: { id: true } });
    const first = await bookAs(user(a), fd({ typeId: dropoff, date: "2027-03-04", start: "11:00", customerId: (await customer(S)).id, staffId: sue.id }), NOW);
    await expectError("Sue is busy", async () => bookAs(user(a), fd({ typeId: rental, date: "2027-03-04", start: "10:30", customerId: (await customer(S)).id, staffId: sue.id }), NOW), /^Sue Staff already has an appointment then\.$/);
    const moved = await rescheduleApptAs(user(a), first.id, fd({ date: "2027-03-04", start: "11:15" }), NOW);
    assert.equal(moved.ymd, "2027-03-04");
    const after = await db.appointment.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(wall(after.startsAt, NY).minute, 15, "moved by a quarter hour over its own old time");
    assert.equal(after.staffId, sue.id, "the staff member stays when the form has no staffId");
    await expectError("move into Sue's other time", async () => {
      const other = await bookAs(user(a), fd({ typeId: dropoff, date: "2027-03-04", start: "14:00", customerId: (await customer(S)).id, staffId: sue.id }), NOW);
      await rescheduleApptAs(user(a), other.id, fd({ date: "2027-03-04", start: "11:20" }), NOW);
    }, /^Sue Staff already has an appointment then\.$/);
    ok("one staff member can't be in two places; rescheduling checks room without counting itself and keeps the staff member");

    // ---- status
    await setApptStatusAs(user(a), first.id, "DONE", fd({}));
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id: first.id } })).status, "DONE");
    await expectError("move a done one", () => rescheduleApptAs(user(a), first.id, fd({ date: "2027-03-04", start: "12:00" }), NOW), /^Only booked appointments can move\.$/);
    await setApptStatusAs(user(a), first.id, "BOOKED", fd({}));
    await setApptStatusAs(user(a), first.id, "CANCELLED", fd({}));
    await expectError("cancelled is final", () => setApptStatusAs(user(a), first.id, "BOOKED", fd({})), /^Book it again instead\.$/);
    ok("BOOKED -> DONE -> BOOKED (a mistake) -> CANCELLED (final)");

    // ---- freeWeek: 7 days, booked times left out; freeSlots respects the window and the length
    const week = await freeWeek(db, S, rentalType, "2027-03-02", NY);
    assert.equal(week.length, 7);
    assert.deepEqual(week.map((d) => d.ymd), ["2027-03-02", "2027-03-03", "2027-03-04", "2027-03-05", "2027-03-06", "2027-03-07", "2027-03-08"]);
    const tue = week[0].starts.map((s) => `${wall(s.start, NY).hour}:${String(wall(s.start, NY).minute).padStart(2, "0")}`);
    assert.ok(!tue.includes("10:00") && !tue.includes("11:30") && !tue.includes("8:30"), `10:00-12:00 is taken: ${tue.join(" ")}`);
    assert.ok(tue.includes("12:00") && tue.includes("15:00") && !tue.includes("15:30"), `a 2-hour rental fits until 15:00: ${tue.join(" ")}`);
    assert.equal(week[1].starts.length, 0, "Wednesday is blocked all day");
    assert.equal(week[5].starts.length, 0, "Sunday is closed");
    assert.equal(week[6].starts.length, 0, "Monday is closed");
    const open = freeSlots({ minutes: 30, capacity: 2, hours: [] }, "2027-03-02", NY, [{ startsAt: at("2027-03-02", 540), endsAt: at("2027-03-02", 600) }]);
    assert.equal(open[0].free, 1, "9:00 has one of two left");
    assert.equal(wall(open[0].start, NY).hour, 9, "no hours: 9:00-18:00");
    assert.equal(wall(open[open.length - 1].start, NY).hour, 17);
    ok("freeWeek lists 7 days and leaves out booked, blocked and closed times; freeSlots counts capacity and the length");

    // ---- DST: a 10:00 booking on 14 Mar 2027 (clocks forward) is 10:00 shop time
    const dst = await bookAs(user(a), fd({ typeId: dropoff, date: "2027-03-14", start: "10:00", customerId: (await customer(S)).id, outsideHours: "on" }), NOW);
    const d = await db.appointment.findUniqueOrThrow({ where: { id: dst.id } });
    assert.equal(wall(d.startsAt, NY).hour, 10);
    assert.equal(d.startsAt.toISOString(), "2027-03-14T14:00:00.000Z", "10:00 EDT");
    ok("a booking on the DST change day is 10:00 shop time");

    // ---- calendarItems: appointments, a class meeting, a run, and shifts when asked
    const cls = await db.shopClass.create({ data: { shopId: S, title: "Quilting", seats: 8, feeCents: 0 } });
    await db.classMeeting.create({ data: { shopId: S, classId: cls.id, startsAt: at("2027-03-02", 18 * 60), endsAt: at("2027-03-02", 20 * 60) } });
    const link = await db.partnerLink.create({ data: { id: `chklink${crypto.randomBytes(8).toString("hex")}`, shopId: S, side: "retail", partnerName: "Fix-It" } });
    await db.partnerRun.create({ data: { id: `chkrun${crypto.randomBytes(8).toString("hex")}`, shopId: S, linkId: link.id, ownerSide: "retail", startsAt: at("2027-03-02", 13 * 60), collect: ["a"], deliver: [] } });
    await db.shift.create({ data: { shopId: S, userId: sue.id, name: "Sue Staff", startsAt: at("2027-03-02", 9 * 60), endsAt: at("2027-03-02", 17 * 60), role: "Counter" } });
    const day = await calendarItems(S, dayStart("2027-03-02", NY), dayStart("2027-03-03", NY), { shifts: true });
    const kinds = day.map((i) => i.kind);
    assert.ok(kinds.includes("appointment") && kinds.includes("class") && kinds.includes("run") && kinds.includes("shift"), kinds.join(","));
    assert.equal(day.filter((i) => i.kind === "appointment").length, 4, "the rental (or the lesson) and three drop-offs");
    assert.ok(day.every((i, idx) => idx === 0 || day[idx - 1].start <= i.start), "sorted by start");
    const noShifts = await calendarItems(S, dayStart("2027-03-02", NY), dayStart("2027-03-03", NY), { shifts: false });
    assert.ok(!noShifts.some((i) => i.kind === "shift"));
    assert.ok(day.find((i) => i.kind === "run")!.href.startsWith(`/partners/${link.id}/runs/`));
    ok("calendarItems: appointments, the class meeting, the pickup run and (when asked) the shift, sorted");

    // ---- another company's type; Scheduling off
    const b = await checkShop({ retail: true, modules: ["scheduling"] });
    await expectError("their type", async () => bookAs(user(b), fd({ typeId: rental, date: "2027-03-05", start: "10:00", customerId: (await customer(b.shopId)).id }), NOW), /^Pick what they're booking\.$/);
    await expectError("their appointment", () => setApptStatusAs(user(b), monday.id, "DONE", fd({})), /^Appointment not found\.$/);
    const off = await checkShop({ retail: true, modules: [] });
    await expectError("Scheduling off", () => saveApptTypeAs(user(off), null, fd({ name: "x", minutes: "30", fee: "0", capacity: "1" })), /./);
    ok("another company's type and appointment are not found; Scheduling off refuses");

    console.log(`appointments.check: ${steps} groups passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
