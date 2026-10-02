// Classes (scheduling-messaging-design.md 15.5 acceptance 2): seats under 12 parallel sign-ups, the waiting list, the
// repeat dates across DST, the limits, another company's class, Scheduling off, and the register's sign-up.
//   npm run check scripts/checks/classes.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { enrollIn, meetingDays, seatCounts, syncClassDates } from "@/lib/classes";
import { deleteClassAs, enrollAtRegisterAs, enrollAs, messageClassAs, moveUpAs, openClassSeatsFor, saveClassAs, setClassStatusAs, setEnrollmentFeeAs, cancelEnrollmentAs } from "@/lib/class-actions";
import { zonedTime, wall } from "@/lib/zoned";
import { checkShop, cleanup, clearKick, messagingFor, withMock, withSink, type CheckShop } from "./lib";

const NY = "America/New_York";
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
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

async function customer(shopId: string, name = `Cust ${uniq()}`, o: { phone?: string | null; email?: string | null } = {}) {
  return db.customer.create({ data: { shopId, name, kind: "RETAIL", notifyBy: "sms", phone: o.phone === undefined ? `+1212555${String(1000 + n++).slice(-4)}` : o.phone, email: o.email ?? null }, select: { id: true, name: true } });
}

/** A class with `seats` and meetings on the given days at 18:00-20:00 New York. */
async function makeClass(shopId: string, o: { seats: number; waitlist?: boolean; days?: string[]; status?: string; feeCents?: number }) {
  const c = await db.shopClass.create({ data: { shopId, title: `Class ${uniq()}`, seats: o.seats, waitlist: o.waitlist ?? true, status: o.status ?? "OPEN", feeCents: o.feeCents ?? 4500, location: "The classroom", supplies: "Scissors" } });
  const days = o.days ?? ["2027-03-02", "2027-03-09"];
  await db.classMeeting.createMany({ data: days.map((d) => ({ shopId, classId: c.id, startsAt: zonedTime(d, 18 * 60, NY), endsAt: zonedTime(d, 20 * 60, NY) })) });
  await syncClassDates(db, c.id);
  return db.shopClass.findUniqueOrThrow({ where: { id: c.id } });
}

const signUp = (s: CheckShop, classId: string, c: { id: string; name: string }, o: { attendee?: string | null; skipWaitlist?: boolean } = {}) =>
  db.$transaction((tx) => enrollIn(tx, { shopId: s.shopId, classId, customer: c, attendee: o.attendee ?? null, byUserId: s.user.id, skipWaitlist: o.skipWaitlist ?? false }));

async function main() {
  const t0 = Date.now();
  try {
    await withSink();
    await withMock();
    const a = await checkShop({ retail: true, repair: true, modules: ["scheduling", "marketing"] });
    await messagingFor(a.shopId, { email: true, sms: true });
    const S = a.shopId;

    // ---- 12 at once on 10 seats
    const twelve = await Promise.all(Array.from({ length: 12 }, () => customer(S)));
    const withList = await makeClass(S, { seats: 10 });
    const results = await Promise.allSettled(twelve.map((c) => signUp(a, withList.id, c)));
    assert.ok(results.every((r) => r.status === "fulfilled"), results.map((r) => (r.status === "rejected" ? String(r.reason) : "")).join(" "));
    const counts = (await seatCounts(db, [withList.id])).get(withList.id)!;
    assert.deepEqual(counts, { enrolled: 10, waiting: 2 });
    const noList = await makeClass(S, { seats: 10, waitlist: false });
    const r2 = await Promise.allSettled(twelve.map((c) => signUp(a, noList.id, c)));
    assert.equal(r2.filter((r) => r.status === "fulfilled").length, 10);
    assert.equal(r2.filter((r) => r.status === "rejected" && /^The class is full\.$/.test(String((r.reason as Error).message))).length, 2);
    ok("12 parallel sign-ups on 10 seats: 10 ENROLLED + 2 WAITLIST with a list; 10 + 2 'The class is full.' without");

    // ---- with someone waiting, a new sign-up waits unless skipWaitlist; attendees; duplicates; cancel and again
    const extra = await customer(S, "Extra Person");
    // free a seat: cancel one enrolled person, then a new sign-up still waits behind the two already waiting
    const first = await db.enrollment.findFirstOrThrow({ where: { classId: withList.id, status: "ENROLLED" } });
    await db.enrollment.update({ where: { id: first.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const waits = await signUp(a, withList.id, extra);
    assert.equal(waits.status, "WAITLIST", "someone is waiting: the newcomer waits too");
    const jumper = await customer(S, "Jumper");
    const jumped = await signUp(a, withList.id, jumper, { skipWaitlist: true });
    assert.equal(jumped.status, "ENROLLED", "skipWaitlist takes the free seat");
    const parent = await customer(S, "Pat Parent");
    const kidClass = await makeClass(S, { seats: 5 });
    const k1 = await signUp(a, kidClass.id, parent, { attendee: "Sam" });
    const k2 = await signUp(a, kidClass.id, parent, { attendee: "Alex" });
    assert.ok(k1.id !== k2.id && k1.attendee === "Sam" && k2.attendee === "Alex");
    await expectError("same attendee twice", () => signUp(a, kidClass.id, parent, { attendee: "sam" }), /^Sam is already signed up\.$/);
    const self = await signUp(a, kidClass.id, parent);
    await expectError("same person twice", () => signUp(a, kidClass.id, parent), /^Pat Parent is already signed up\.$/);
    await db.enrollment.update({ where: { id: self.id }, data: { status: "CANCELLED", cancelledAt: new Date(), paidAt: new Date(), paidCents: 4500 } });
    const again = await signUp(a, kidClass.id, parent);
    assert.ok(again.id !== self.id && again.paidAt === null && again.paidCents === null && again.feeCents === 4500, "a new row, nothing paid, the fee snapshotted");
    ok("waiting list order, skipWaitlist, two attendees, duplicates refused, cancel then sign up again -> a fresh row");

    // ---- moveUp into a full class, lowering seats below the count, closed / over classes
    const full = await makeClass(S, { seats: 1 });
    await signUp(a, full.id, await customer(S));
    const waiting = await signUp(a, full.id, await customer(S));
    assert.equal(waiting.status, "WAITLIST");
    await expectError("move up into a full class", () => moveUpAs(user(a), waiting.id, fd({})), /^The class is full\. Add a seat or cancel someone first\.$/);
    await expectError("fewer seats than people", () => saveClassAs(user(a), withList.id, fd({ title: withList.title, seats: "5", fee: "45.00", remind: "every" })), /^10 people are signed up\. Keep at least 10 seats\.$/);
    await saveClassAs(user(a), withList.id, fd({ title: withList.title, seats: "12", fee: "45.00", remind: "every" }));
    assert.equal((await db.shopClass.findUniqueOrThrow({ where: { id: withList.id } })).seats, 12);
    const closed = await makeClass(S, { seats: 5, status: "CLOSED" });
    const late = await customer(S);
    await expectError("closed", () => signUp(a, closed.id, late), /^Sign-ups for this class are closed\.$/);
    const over = await makeClass(S, { seats: 5, days: ["2020-01-07"] });
    await expectError("over", () => signUp(a, over.id, late), /^This class is over\.$/);
    ok("moveUp into a full class refused; seats can't drop below the signed-up count; closed and finished classes refuse sign-ups");

    // ---- meetingDays
    const weekly = meetingDays("2027-03-02", "weekly", 4); // across the US DST change (14 Mar 2027)
    assert.deepEqual(weekly, ["2027-03-02", "2027-03-09", "2027-03-16", "2027-03-23"]);
    for (const d of weekly) assert.equal(wall(zonedTime(d, 18 * 60, NY), NY).hour, 18, `${d} keeps 18:00`);
    assert.deepEqual(meetingDays("2027-03-02", "biweekly", 3), ["2027-03-02", "2027-03-16", "2027-03-30"]);
    assert.deepEqual(meetingDays("2027-01-16", "monthly_weekday", 4), ["2027-01-16", "2027-02-20", "2027-03-20", "2027-04-17"], "the 3rd Saturday");
    assert.deepEqual(meetingDays("2027-01-30", "monthly_date", 4), ["2027-01-30", "2027-03-30", "2027-04-30", "2027-05-30"], "Feb 30 skipped");
    assert.deepEqual(meetingDays("2027-03-02", "once", 9), ["2027-03-02"]);
    ok("meetingDays: weekly keeps 18:00 across DST, biweekly, the 3rd Saturday each month, monthly date skips Feb 30");

    // ---- deleteClass with sign-ups, messageClass without the tick, price for this person, cancel enrollment
    await expectError("delete with sign-ups", () => deleteClassAs(user(a), withList.id), /^People signed up for this class\. Cancel it instead; the record stays\.$/);
    await expectError("message without the tick", () => messageClassAs(user(a), withList.id, fd({ body: "Bring your machine." })), /^Tick the box to confirm it's only about this class\. Promotions go in Campaigns\.$/);
    await messageClassAs(user(a), kidClass.id, fd({ body: "Bring your machine.", onlyAboutClass: "on", subject: "About Saturday" }));
    clearKick();
    const notes = await db.outMessage.findMany({ where: { shopId: S, kind: "class_notice", refId: kidClass.id } });
    assert.equal(notes.length, 1, "one per person: Pat is signed up three times (Sam, Alex, Pat) and gets one note");
    assert.ok(notes.every((m) => m.byUserId === a.user.id && m.purpose === "notice"));
    await setEnrollmentFeeAs(user(a), again.id, fd({ fee: "20" }));
    assert.equal((await db.enrollment.findUniqueOrThrow({ where: { id: again.id } })).feeCents, 2000);
    await db.enrollment.update({ where: { id: again.id }, data: { paidAt: new Date(), paidCents: 2000 } });
    await expectError("price a paid one", () => setEnrollmentFeeAs(user(a), again.id, fd({ fee: "10" })), /^It's already paid\. Refund and ring it up again\.$/);
    await expectError("tech prices", () => setEnrollmentFeeAs(tech(a), k1.id, fd({ fee: "10" })), /^Only an owner or admin can do that\.$/);
    await cancelEnrollmentAs(tech(a), k1.id, fd({ note: "Can't make it" }));
    assert.equal((await db.enrollment.findUniqueOrThrow({ where: { id: k1.id } })).status, "CANCELLED", "anyone at the counter can cancel a sign-up");
    const empty = await makeClass(S, { seats: 3 });
    await deleteClassAs(user(a), empty.id);
    assert.equal(await db.shopClass.count({ where: { id: empty.id } }), 0);
    ok("deleteClass with any sign-up refused (an empty one goes); messageClass needs the tick and reaches everyone signed up; price for this person; a tech can cancel but not price");

    // ---- the form path: a new class with 4 weekly meetings, enroll from the form with tell
    const id = await saveClassAs(user(a), null, fd({ title: "Beginning Quilting", teacher: "Jo", fee: "45.00", seats: "2", remind: "first", date: "2027-03-02", start: "18:00", end: "20:00", repeat: "weekly", count: "4", supplies: "Rotary cutter" }));
    const made = await db.shopClass.findUniqueOrThrow({ where: { id }, include: { meetings: true } });
    assert.equal(made.meetings.length, 4);
    assert.equal(+made.firstAt!, +zonedTime("2027-03-02", 18 * 60, NY));
    assert.equal(+made.lastAt!, +zonedTime("2027-03-23", 20 * 60, NY));
    const em = await customer(S, "Ella Mail", { phone: null, email: `ella-${uniq()}@a.test` });
    await db.customer.update({ where: { id: em.id }, data: { notifyBy: "email" } });
    await enrollAs(user(a), id, fd({ customerId: em.id, tell: "on" }));
    clearKick();
    const signup = await db.outMessage.findFirst({ where: { shopId: S, kind: "class_notice", refType: "enrollment" } });
    assert.ok(signup && /You're signed up for Beginning Quilting, starting Tue, Mar 2 at 6:00 pm\./.test(signup.body), signup?.body);
    assert.match(signup!.body, /Fee: \$45\.00, paid at the counter\./);
    assert.match(signup!.body, /\n\nBring: Rotary cutter/);
    await setClassStatusAs(user(a), id, "CANCELLED", fd({}));
    const after = await db.shopClass.findUniqueOrThrow({ where: { id }, include: { meetings: true } });
    assert.equal(after.status, "CANCELLED");
    assert.ok(after.meetings.every((m) => m.cancelled), "future meetings cancelled with the class");
    ok("saveClass makes 4 weekly meetings with firstAt/lastAt; enroll with tell sends the class_signup wording; cancelling the class cancels its meetings");

    // ---- the register
    const reg = await makeClass(S, { seats: 2, feeCents: 3000 });
    const seats = await openClassSeatsFor(S);
    assert.ok(seats.some((c) => c.id === reg.id && c.seatsLeft === 2 && c.feeCents === 3000));
    assert.ok(!seats.some((c) => c.id === closed.id || c.id === over.id || c.id === id), "closed, finished and cancelled classes aren't offered");
    const due = await enrollAtRegisterAs(user(a), reg.id, fd({ customerName: "Walk In", customerPhone: "(212) 555-0190" }));
    assert.equal(due.kind, "enrollment");
    assert.equal(due.dueCents, 3000);
    assert.equal(due.customerName, "Walk In");
    assert.match(due.description, /^Class: Class .*, Tue, Mar 2 at 6:00 pm$/);
    await enrollAtRegisterAs(user(a), reg.id, fd({ customerName: "Walk Two", customerPhone: "(212) 555-0191" }));
    await expectError("register never waitlists", () => enrollAtRegisterAs(user(a), reg.id, fd({ customerName: "Walk Three", customerPhone: "(212) 555-0192" })), /^The class is full\.$/);
    assert.equal(await db.enrollment.count({ where: { classId: reg.id, status: "WAITLIST" } }), 0);
    ok("the register lists open classes with seats and signs people up as a BookingDue with the snapshot fee; a full class refuses (no waiting list from the register)");

    // ---- another company; Scheduling off
    const b = await checkShop({ retail: true, modules: ["scheduling"] });
    await expectError("their class", () => enrollAs(user(b), withList.id, fd({ customerName: "X", customerPhone: "(212) 555-0199" })), /^Class not found\.$/);
    await expectError("their enrollment", () => moveUpAs(user(b), waiting.id, fd({})), /^Sign-up not found\.$/);
    await expectError("their class (save)", () => saveClassAs(user(b), withList.id, fd({ title: "x", seats: "20", fee: "0", remind: "every" })), /^Class not found\.$/);
    const off = await checkShop({ retail: true, modules: [] });
    const offClass = await makeClass(off.shopId, { seats: 5 });
    for (const [label, fn] of [
      ["save", () => saveClassAs(user(off), null, fd({ title: "x", seats: "5", fee: "0", remind: "every", date: "2027-03-02", start: "18:00", end: "20:00" }))],
      ["enroll", () => enrollAs(user(off), offClass.id, fd({ customerName: "X", customerPhone: "(212) 555-0198" }))],
      ["status", () => setClassStatusAs(user(off), offClass.id, "CLOSED", fd({}))],
      ["register", () => enrollAtRegisterAs(user(off), offClass.id, fd({ customerName: "X", customerPhone: "(212) 555-0197" }))],
    ] as const) {
      await expectError(`Scheduling off: ${label}`, fn, /./);
    }
    assert.deepEqual(await openClassSeatsFor(off.shopId), []);
    ok("another company's class and sign-up are not found; with Scheduling off every action refuses and openClassSeats is empty");

    console.log(`classes.check: ${steps} groups passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
