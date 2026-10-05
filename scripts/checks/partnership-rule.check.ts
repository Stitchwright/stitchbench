// The real-partnership rule, program side (owner decided 5 Oct 2026; the hub decides, see its README): a quilt shop's
// waiver in its 30-day grace arrives as standing "waived" with a last day (the grace's end) and the hub's friendly words.
//   1. a waiver that holds (no last day) shows no notice; the grace shows the hub's words and the end date
//   2. the notice is words only: the company stays writable through the grace, with the waived key the hub signed
//   3. back to waived with no last day (a repair passed, the partner subscribed): the notice goes
//   4. after the grace the hub's standing is lapsed: no notice, and the lapsed key makes the program read-only as before
//   5. other standings (trial, active) never show it
//   npm run check scripts/checks/partnership-rule.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end).
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { baseWritable } from "@/lib/base-gate";
import { addDaysYmd } from "@/lib/license";
import { applyStanding, partnershipNotice } from "@/lib/hub-standing";
import { devLicenseKey } from "../license/dev";
import { checkShop, cleanup } from "./lib";

let steps = 0;
const ok = (what: string) => console.log(`  ok  ${++steps}. ${what}`);
const today = () => new Date().toISOString().slice(0, 10);
const NOTE = (until: string) => `Your free StitchShop comes with your repair partnership with Check Repair. Subscribe to keep going after ${until}; nothing is locked or lost.`;
const read = async (shopId: string) => db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { hubStanding: true, hubStandingUntil: true, hubStandingNote: true } });

async function main() {
  const s = await checkShop({ retail: true });
  const waivedKey = (until: string) => devLicenseKey({ shopId: s.shopId, modules: ["base"], plan: "w", from: addDaysYmd(today(), -1), until, grace: 14, loginPlan: "shop" });

  // 1. A waiver that holds: no last day, no notice.
  await applyStanding(s.shopId, { standing: "waived", lastDay: null, message: "Free while you're partnered with Check Repair.", key: waivedKey(addDaysYmd(today(), 34)) });
  assert.equal(partnershipNotice(await read(s.shopId)), null);
  ok("a waiver that holds shows no notice");

  // 2. The grace: still waived, the end date and the words; the company stays writable.
  const end = addDaysYmd(today(), 30);
  await applyStanding(s.shopId, { standing: "waived", lastDay: end, message: NOTE(end), key: waivedKey(end) });
  assert.deepEqual(partnershipNotice(await read(s.shopId)), { until: end, note: NOTE(end) });
  assert.equal(await baseWritable(s.shopId), true, "nothing is locked in the grace");
  ok("the grace shows the hub's words and the end date, and nothing is locked");

  // 3. The rule holds again: the notice goes.
  await applyStanding(s.shopId, { standing: "waived", lastDay: null, message: "Free while you're partnered with Check Repair.", key: waivedKey(addDaysYmd(today(), 34)) });
  assert.equal(partnershipNotice(await read(s.shopId)), null);
  ok("activity resumes in the grace: the notice goes");

  // 4. After the grace: lapsed, no notice, read-only from the lapsed key (never deleted).
  const before = await db.ticket.count({ where: { shopId: s.shopId } });
  await applyStanding(s.shopId, {
    standing: "lapsed",
    lastDay: addDaysYmd(today(), -20),
    message: "The free trial ended.",
    key: devLicenseKey({ shopId: s.shopId, modules: ["base"], plan: "w", from: addDaysYmd(today(), -60), until: addDaysYmd(today(), -40), grace: 14, loginPlan: "shop" }),
  });
  assert.equal(partnershipNotice(await read(s.shopId)), null);
  assert.equal(await baseWritable(s.shopId), false, "after the grace the normal lapse rules apply");
  assert.equal(await db.ticket.count({ where: { shopId: s.shopId } }), before, "nothing is deleted");
  ok("after the grace: lapsed, no notice, read-only as the lapse rules say, nothing deleted");

  // 5. Other standings never show it, even with a last day and a note.
  for (const standing of ["trial", "active", "past_due", "comped"]) {
    await applyStanding(s.shopId, { standing, lastDay: end, message: NOTE(end) });
    assert.equal(partnershipNotice(await read(s.shopId)), null, standing);
  }
  ok("trial, active, past_due and comped never show the partnership notice");

  console.log(`partnership rule: ${steps} checks passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await db.$disconnect();
  });
