// The stages of an uncollected-machine notice (scheduling-messaging-design.md 9.1, notices acceptance item 2). Pure: no
// database, no server.
//   npm run check scripts/checks/abandon.check.ts
import assert from "node:assert/strict";
import { abandonDate, abandonStages, currentStage, parseStageKey, sendable, stageKey } from "@/lib/notices/abandon";
import { addDays, wall, ymdOf, zonedTime } from "@/lib/zoned";

const NY = "America/New_York";
const DAY = 86_400_000;
let steps = 0;
const ok = (label: string) => {
  steps += 1;
  console.log(`  ok  ${label}`);
};

const ready = zonedTime("2026-09-01", 15 * 60 + 30, NY); // 3:30 pm on Tue Sep 1

// days [7, 30], abandon after 60, final 7: day 7, 30, 53
{
  const s = abandonStages(ready, [7, 30], 60, 7, 10, NY);
  assert.deepEqual(
    s.map((x) => [x.key, x.day, x.final]),
    [
      ["first", 7, false],
      ["second", 30, false],
      ["final", 53, true],
    ],
  );
  assert.equal(ymdOf(s[0].due, NY), "2026-09-08");
  assert.equal(ymdOf(s[1].due, NY), "2026-10-01");
  assert.equal(ymdOf(s[2].due, NY), "2026-10-24");
  for (const x of s) assert.equal(wall(x.due, NY).hour, 10, "due at reminderHour");
  assert.equal(ymdOf(abandonDate(ready, 60, NY), NY), "2026-10-31");
  assert.equal(+abandonDate(ready, 60, NY), +zonedTime("2026-10-31", 0, NY), "the start of that shop day");
  ok("days [7, 30], abandon after 60, final 7 -> stages on day 7, 30, 53; abandon date is the start of day 60");
}

// [7, 58] with final 7: the 58 stage is dropped (it is on or after the final day 53)
{
  const s = abandonStages(ready, [7, 58], 60, 7, 10, NY);
  assert.deepEqual(
    s.map((x) => [x.key, x.day]),
    [
      ["first", 7],
      ["final", 53],
    ],
  );
  const t = abandonStages(ready, [7, 53, 54], 60, 7, 10, NY);
  assert.deepEqual(t.map((x) => x.day), [7, 53], "a regular stage ON the final day is dropped too");
  // No final when the window is too short for one: the regular stages all stay.
  const u = abandonStages(ready, [7, 30], 5, 7, 10, NY);
  assert.deepEqual(u.map((x) => [x.key, x.final]), [["first", false], ["second", false]]);
  // At most four regular stages.
  assert.equal(abandonStages(ready, [1, 2, 3, 4, 5, 6], 100, 7, 10, NY).filter((x) => !x.final).length, 4);
  ok("[7, 58] with final 7 -> the 58 stage dropped; no final when abandon-after is not more than the final window");
}

// sendable: the latest due stage, within 7 days of its due date, before the abandon date
{
  const s = abandonStages(ready, [7, 30], 60, 7, 10, NY);
  const abandonAt = abandonDate(ready, 60, NY);
  const [first, second, final] = s;
  assert.equal(sendable(s, new Date(first.due.getTime() - 1), abandonAt), null, "nothing before the first stage");
  assert.equal(sendable(s, first.due, abandonAt)?.key, "first", "at the due time");
  assert.equal(sendable(s, new Date(first.due.getTime() + 6 * DAY), abandonAt)?.key, "first", "6 days late still goes");
  assert.equal(sendable(s, new Date(first.due.getTime() + 7 * DAY), abandonAt), null, "7 days after its due date is too late");
  assert.equal(sendable(s, new Date(first.due.getTime() + 10 * DAY), abandonAt), null, "nothing between the windows");
  assert.equal(sendable(s, new Date(second.due.getTime() + 1000), abandonAt)?.key, "second", "only the latest due stage, not the first as well");
  assert.equal(sendable(s, new Date(final.due.getTime() + 1000), abandonAt)?.key, "final");
  // The final is due on day 53; day 53 + 7 = day 60 = the abandon date: not at or after it.
  assert.equal(sendable(s, new Date(abandonAt.getTime() - 1), abandonAt)?.key, "final", "just before the abandon date");
  assert.equal(sendable(s, abandonAt, abandonAt), null, "nothing once the abandon date has come");
  assert.equal(sendable(s, new Date(abandonAt.getTime() + 20 * DAY), abandonAt), null, "and never after it");
  // A late-ready window: abandon date 3 days after the final's due date cuts the 7 days short.
  const tight = abandonStages(ready, [], 60, 7, 10, NY);
  assert.equal(sendable(tight, new Date(tight[0].due.getTime() + 2 * DAY), new Date(tight[0].due.getTime() + 3 * DAY))?.key, "final");
  assert.equal(sendable(tight, new Date(tight[0].due.getTime() + 4 * DAY), new Date(tight[0].due.getTime() + 3 * DAY)), null, "cut short by the abandon date");
  assert.equal(sendable([], new Date(), abandonAt), null);
  ok("sendable: only the latest due stage, nothing more than 7 days after its due date, nothing once the abandon date has passed");
}

// currentStage (the by-hand "send the current notice")
{
  const s = abandonStages(ready, [7, 30], 60, 7, 10, NY);
  assert.equal(currentStage(s, ready)?.key, "first", "before any stage fell due: the first coming");
  assert.equal(currentStage(s, new Date(s[1].due.getTime() + 20 * DAY))?.key, "second", "after its window: still the latest due one");
  assert.equal(currentStage([], ready), null);
  ok("currentStage: the latest due stage, else the first coming");
}

// Due times at reminderHour on DST days
{
  // DST ends Sun Nov 1 2026 (25-hour day) and begins Sun Mar 8 2026 (23-hour day).
  const autumn = zonedTime("2026-10-25", 9 * 60, NY);
  const a = abandonStages(autumn, [7], 100, 7, 10, NY)[0];
  assert.equal(ymdOf(a.due, NY), "2026-11-01");
  assert.equal(wall(a.due, NY).hour, 10);
  assert.equal(wall(a.due, NY).minute, 0);
  assert.equal(+a.due, Date.UTC(2026, 10, 1, 15, 0), "10:00 EST is 15:00 UTC");
  const spring = zonedTime("2026-03-01", 9 * 60, NY);
  const b = abandonStages(spring, [7], 100, 7, 10, NY)[0];
  assert.equal(ymdOf(b.due, NY), "2026-03-08");
  assert.equal(wall(b.due, NY).hour, 10);
  assert.equal(+b.due, Date.UTC(2026, 2, 8, 14, 0), "10:00 EDT is 14:00 UTC");
  // The hour that doesn't exist (2:00 on the spring-forward day) moves forward, on the same day.
  const c = abandonStages(spring, [7], 100, 7, 2, NY)[0];
  assert.equal(ymdOf(c.due, NY), "2026-03-08");
  assert.ok(wall(c.due, NY).hour >= 2 && wall(c.due, NY).hour <= 3);
  // Days count in the shop's zone: 11 pm in Los Angeles is already the next UTC day.
  const LA = "America/Los_Angeles";
  const late = zonedTime("2026-09-01", 23 * 60, LA);
  assert.equal(ymdOf(abandonStages(late, [7], 100, 7, 10, LA)[0].due, LA), "2026-09-08");
  assert.equal(ymdOf(abandonDate(late, 60, LA), LA), addDays("2026-09-01", 60));
  ok("due times are at reminderHour on DST days (EDT and EST), and days count in the shop's zone");
}

// stageKey differs for a new pickupReadyAt (and parses back)
{
  const s = abandonStages(ready, [7, 30], 60, 7, 10, NY);
  const again = new Date(ready.getTime() + 8 * DAY);
  assert.notEqual(stageKey(ready, s[0]), stageKey(again, s[0]));
  assert.notEqual(stageKey(ready, s[0]), stageKey(ready, s[1]));
  assert.equal(stageKey(ready, s[0]), `${ready.getTime()}:first`);
  assert.deepEqual(parseStageKey(stageKey(ready, s[2])), { start: ready.getTime(), key: "final" });
  assert.equal(parseStageKey("nonsense"), null);
  assert.equal(parseStageKey(null), null);
  ok("stageKey differs for a new pickupReadyAt and for each stage; parseStageKey reads it back");
}

console.log(`abandon.check: ${steps} groups passed`);
