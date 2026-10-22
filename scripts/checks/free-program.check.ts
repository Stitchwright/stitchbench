// The free program (src/lib/free-program.ts, 15 Oct 2026): with it on, a company whose program key ended long ago is still
// writable, every add-on is on with no key at all, the Assistant (it costs money per question) keeps its key rule, a Solo
// key limits no logins, and the read-only gate lets writes through; with PROGRAM_FREE=off the old rules are back: the
// ended key is lapsed and read-only, the add-on is off.
//   npm run check scripts/checks/free-program.check.ts
// Shares the dev database: a throwaway company "Check <run>" (removed at the end).
import "dotenv/config";
import assert from "node:assert/strict";
import { baseWritable, requireBaseWritable } from "@/lib/base-gate";
import { addDaysYmd } from "@/lib/license";
import { loadModules } from "@/lib/modules";
import { companyPlan } from "@/lib/plan";
import { grantDevLicense } from "../license/dev";
import { checkShop, cleanup } from "./lib";

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  const shop = await checkShop();
  // A program key that ended 60 days ago with its grace over, and a Solo login plan, as a shop that stopped paying has.
  await grantDevLicense(shop.shopId, ["base"], { from: addDaysYmd(today(), -200), until: addDaysYmd(today(), -60), grace: 14, plan: "m", loginPlan: "solo", issuedAt: new Date(Date.now() - 200 * DAY) });

  // ----- free (the default) -----
  delete process.env.PROGRAM_FREE;
  let m = await loadModules(shop.shopId);
  assert.equal(m.states.base.status, "on", "the ended key does not lapse a free program");
  assert.equal(m.states.base.active, true);
  for (const id of ["vac", "appliance", "scheduling", "marketing", "maker", "decorating"] as const) assert.equal(m.states[id].status, "on", `${id} is on with no key`);
  assert.equal(m.states.assistant.status, "off", "the Assistant keeps its own key rule");
  assert.equal(await baseWritable(shop.shopId), true);
  await requireBaseWritable(shop.shopId); // does not throw
  assert.equal(await companyPlan(shop.shopId), null, "no plan, so no limit on logins");
  console.log("  ok  free: nothing lapses, every add-on is on, no login limit");

  // ----- PROGRAM_FREE=off: the key rules -----
  process.env.PROGRAM_FREE = "off";
  m = await loadModules(shop.shopId);
  assert.equal(m.states.base.status, "lapsed", "the ended key lapses the program again");
  assert.equal(m.states.vac.status, "off", "an add-on with no key is off");
  assert.equal(await baseWritable(shop.shopId), false);
  await assert.rejects(() => requireBaseWritable(shop.shopId), /read-only|ended|lapsed/i);
  assert.equal((await companyPlan(shop.shopId))?.plan, "solo", "the key's Solo plan counts again");
  console.log("  ok  PROGRAM_FREE=off: the key rules are back");
}

main()
  .then(() => console.log("free-program: all ok"))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    process.exit();
  });
