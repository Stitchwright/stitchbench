// Staff shifts (scheduling-messaging-design.md 15.8 acceptance 2): a shift for a login and for a typed name; overlaps
// for the same login or the same name (any case) refused; copyWeek across the DST week keeps wall times; a non-empty
// target needs "replace"; weekly totals group by name; another company's user id refused.
//   npm run check scripts/checks/shifts.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { copyWeekAs, deleteShiftAs, hoursText, minutesByName, saveShiftAs, weekShifts } from "@/lib/shifts";
import { wall } from "@/lib/zoned";
import { checkShop, cleanup, type CheckShop } from "./lib";

const NY = "America/New_York";
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

async function main() {
  const t0 = Date.now();
  try {
    const a = await checkShop({ retail: true, repair: true, modules: ["scheduling"] });
    const S = a.shopId;
    const sue = await db.user.create({ data: { shopId: S, email: `sue-${uniq()}@stitchbench.test`, name: "Sue Staff", role: "TECH", passwordHash: "x" }, select: { id: true } });

    // 2027-03-07 is a Sunday; the US clocks go forward on 14 Mar 2027 (the next week).
    const w1 = "2027-03-07";
    const s1 = await saveShiftAs(user(a), null, fd({ userId: sue.id, date: "2027-03-09", start: "09:00", end: "13:00", role: "Counter" }));
    assert.equal(s1.week, w1);
    const s2 = await saveShiftAs(user(a), null, fd({ name: "Ann (Saturdays)", date: "2027-03-13", start: "10:00", end: "16:30" }));
    const rows = await weekShifts(S, w1, NY);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, "Sue Staff", "a login's shift carries their name");
    assert.equal(rows[0].userId, sue.id);
    assert.equal(rows[1].name, "Ann (Saturdays)");
    assert.equal(rows[1].userId, null);
    ok("a shift for a login (named after them) and one for a typed name without a login");

    await expectError("same login overlaps", () => saveShiftAs(user(a), null, fd({ userId: sue.id, date: "2027-03-09", start: "12:00", end: "17:00" })), /^Sue Staff already works Tue, Mar 9, 9:00 am-1:00 pm then\.$/);
    await expectError("same name any case", () => saveShiftAs(user(a), null, fd({ name: "ann (saturdays)", date: "2027-03-13", start: "15:00", end: "18:00" })), /^Ann \(Saturdays\) already works .* then\.$/);
    await expectError("same login by typed name", () => saveShiftAs(user(a), null, fd({ name: "sue staff", date: "2027-03-09", start: "08:00", end: "10:00" })), /^Sue Staff already works/);
    const after = await saveShiftAs(user(a), null, fd({ userId: sue.id, date: "2027-03-09", start: "13:00", end: "17:00", role: "Classroom" }));
    assert.ok(after.id, "back to back is fine");
    await saveShiftAs(user(a), s1.id, fd({ userId: sue.id, date: "2027-03-09", start: "08:30", end: "13:00" }));
    assert.equal(wall((await db.shift.findUniqueOrThrow({ where: { id: s1.id } })).startsAt, NY).minute, 30, "a shift may be changed over its own old time");
    await expectError("overnight", () => saveShiftAs(user(a), null, fd({ userId: sue.id, date: "2027-03-10", start: "20:00", end: "02:00" })), /^The end time must be after the start\.$/);
    await expectError("nobody", () => saveShiftAs(user(a), null, fd({ date: "2027-03-10", start: "09:00", end: "12:00" })), /^Pick someone or type a name\.$/);
    ok("overlaps for the same login or the same name (any case) are refused; back to back and changing a shift over itself are fine; no overnight shifts");

    const totals = minutesByName(await weekShifts(S, w1, NY));
    assert.deepEqual(totals, [
      { name: "Ann (Saturdays)", minutes: 390 },
      { name: "Sue Staff", minutes: 270 + 240 },
    ]);
    assert.equal(hoursText(390), "6h 30m");
    ok("weekly totals group by name");

    // copy to the DST week: the same weekdays and wall times
    const w2 = "2027-03-14";
    const copied = await copyWeekAs(user(a), fd({ from: w1, to: w2 }));
    assert.deepEqual(copied, { to: w2, copied: 3 });
    const next = await weekShifts(S, w2, NY);
    assert.equal(next.length, 3);
    const tue = next.find((s) => s.name === "Sue Staff" && wall(s.startsAt, NY).hour === 8)!;
    assert.equal(wall(tue.startsAt, NY).weekday, 2, "Tuesday again");
    assert.equal(wall(tue.startsAt, NY).day, 16);
    assert.equal(`${wall(tue.startsAt, NY).hour}:${wall(tue.startsAt, NY).minute}`, "8:30", "8:30 am after the clocks went forward");
    assert.equal(wall(tue.endsAt, NY).hour, 13);
    assert.equal(tue.startsAt.toISOString(), "2027-03-16T12:30:00.000Z", "EDT now");
    await expectError("target not empty", () => copyWeekAs(user(a), fd({ from: w1, to: w2 })), /^That week already has shifts\. Tick 'Replace them' to copy over them\.$/);
    await deleteShiftAs(user(a), s2.id);
    const replaced = await copyWeekAs(user(a), fd({ from: w1, to: w2, replace: "on" }));
    assert.equal(replaced.copied, 2);
    assert.equal((await weekShifts(S, w2, NY)).length, 2, "the old three went, the two came");
    await expectError("same week", () => copyWeekAs(user(a), fd({ from: w1, to: w1 })), /^That's the same week\.$/);
    await expectError("empty source", () => copyWeekAs(user(a), fd({ from: "2027-01-03", to: "2027-01-10" })), /^That week has no shifts to copy\.$/);
    ok("copyWeek across the DST change keeps the weekdays and wall times; a non-empty target needs 'Replace them'; a deleted shift is gone");

    const b = await checkShop({ retail: true, modules: ["scheduling"] });
    await expectError("their user", () => saveShiftAs(user(b), null, fd({ userId: sue.id, date: "2027-03-10", start: "09:00", end: "12:00" })), /^Pick someone or type a name\.$/);
    await expectError("their shift", () => deleteShiftAs(user(b), s1.id), /^Shift not found\.$/);
    await expectError("tech", () => saveShiftAs({ ...user(a), role: "TECH" }, null, fd({ name: "x", date: "2027-03-10", start: "09:00", end: "12:00" })), /^Only an owner or admin can do that\.$/);
    const off = await checkShop({ retail: true, modules: [] });
    await expectError("Scheduling off", () => saveShiftAs(user(off), null, fd({ name: "x", date: "2027-03-10", start: "09:00", end: "12:00" })), /./);
    ok("another company's user id or shift, a tech, and Scheduling off are refused");

    console.log(`shifts.check: ${steps} groups passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
