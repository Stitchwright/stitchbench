// Maker-space time (shop-features-round-2-design.md 6.4, package maker-space, Maker Shop): machine names read the same
// way ("laser" is the Laser), what a type needs (its machine, or the longarm for an older certified type), certifying on
// a machine (owner or admin; anything but the longarm needs Maker Shop; the longarm kept in step with
// longarmCertifiedAt, and a customer certified before is still certified), a laser by the hour that only certified
// customers can book, priced by the hour, who is certified, the customer merge, and the tenant section.
//   npm run check scripts/checks/maker-space.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { certNeeded, certificationsOf, certifiedBy, equipmentChoices, equipmentName, isCertified, setCertificationFor } from "@/lib/certifications";
import { bookAs, saveApptTypeAs } from "@/lib/appointment-actions";
import { setCertifiedFor } from "@/lib/longarm";
import { mergeCustomersFor } from "@/lib/merge";
import { ymdOf } from "@/lib/zoned";
import { checkShop, cleanup, switchFeatures, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
const DAY = 86_400_000;

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
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function main() {
  // 1. Names.
  assert.deepEqual([equipmentName("laser"), equipmentName(" LONGARM "), equipmentName("3d printer"), equipmentName("embroidery frame"), equipmentName("  ")], ["Laser", "Longarm", "3D printer", "Embroidery frame", null]);
  assert.deepEqual([certNeeded({ needsCert: true, certFor: null }), certNeeded({ needsCert: true, certFor: "laser" }), certNeeded({ needsCert: false, certFor: null })], ["Longarm", "Laser", null]);
  ok("machine names in any case; an older certified type needs the longarm, a maker type its own machine");

  const a = await checkShop({ retail: true, modules: ["scheduling"] });
  const b = await checkShop({ retail: true, modules: ["scheduling"] });
  try {
    const TZ = "America/New_York";
    const mae = await db.customer.create({ data: { shopId: a.shopId, name: "Mae Maker", phone: "555-0101" } });
    const old = await db.customer.create({ data: { shopId: a.shopId, name: "Olive Older", longarmCertifiedAt: new Date(Date.now() - 300 * DAY) } });

    // 2. Certifying.
    assert.equal(await isCertified(db, a.shopId, old.id, "Longarm"), true, "certified before this (longarmCertifiedAt) still counts");
    await expectError("a tech", () => setCertificationFor(tech(a), mae.id, "Laser", true), /owner or an admin/);
    await expectError("the laser without Maker Shop", () => setCertificationFor(user(a), mae.id, "Laser", true), /Maker Shop module/);
    assert.match(await setCertificationFor(user(a), mae.id, "longarm", true), /certified on the Longarm/);
    assert.ok((await db.customer.findUniqueOrThrow({ where: { id: mae.id } })).longarmCertifiedAt, "kept in step");
    await setCertifiedFor(user(a), mae.id, false);
    assert.deepEqual(await certificationsOf(a.shopId, mae.id), [], "the longarm's own button takes the certification off too");
    await setCertifiedFor(user(a), mae.id, true);
    assert.deepEqual((await certificationsOf(a.shopId, mae.id)).map((c) => c.equipment), ["Longarm"]);
    await switchFeatures(a.shopId, ["maker"]);
    await setCertificationFor(user(a), mae.id, "laser", true);
    await setCertificationFor(user(a), mae.id, "Laser", true);
    assert.deepEqual((await certificationsOf(a.shopId, mae.id)).map((c) => c.equipment), ["Laser", "Longarm"], "once a machine");
    assert.ok((await equipmentChoices(a.shopId)).includes("3D printer"));
    ok("certifying: owner or admin, the laser needs Maker Shop, the longarm kept in step both ways, once a machine; earlier longarm certifications count");

    // 3. A laser by the hour.
    await expectError("B sets up a laser without Maker Shop", () => saveApptTypeAs(user(b), null, fd({ name: "Laser time", minutes: "60", fee: "0", capacity: "1", resource: "Laser", hourly: "30", needsCert: "on", certFor: "Laser" })), /Maker Shop module/);
    const typeId = await saveApptTypeAs(user(a), null, fd({ name: "Laser time", minutes: "60", fee: "0", capacity: "1", resource: "Laser", hourly: "30", needsCert: "on", certFor: "laser" }));
    const type = await db.appointmentType.findUniqueOrThrow({ where: { id: typeId } });
    assert.deepEqual([type.certFor, type.needsCert, type.hourlyCents], ["Laser", true, 3000]);
    const day = ymdOf(new Date(Date.now() + 2 * DAY), TZ);
    await expectError("Olive isn't certified on the laser", () => bookAs(user(a), fd({ typeId, date: day, start: "10:00", end: "11:00", customerId: old.id })), /Olive Older isn't certified on the Laser/);
    const booked = await bookAs(user(a), fd({ typeId, date: day, start: "10:00", end: "12:00", customerId: mae.id }));
    assert.equal((await db.appointment.findUniqueOrThrow({ where: { id: booked.id } })).feeCents, 6000, "two hours at $30");
    const longarmType = await saveApptTypeAs(user(a), null, fd({ name: "Longarm rental", minutes: "60", fee: "0", capacity: "1", resource: "Longarm", hourly: "25", needsCert: "on" }));
    assert.equal((await db.appointmentType.findUniqueOrThrow({ where: { id: longarmType } })).certFor, null, "the longarm stays as before");
    await bookAs(user(a), fd({ typeId: longarmType, date: day, start: "13:00", end: "14:00", customerId: old.id }));
    assert.deepEqual((await certifiedBy(a.shopId)).map((c) => [c.equipment, c.people.map((p) => p.name)]), [["Laser", ["Mae Maker"]], ["Longarm", ["Mae Maker"]]]);
    ok("a laser by the hour: only certified customers, priced by the hour; the longarm type unchanged and earlier certifications still book it");

    // 4. Merge: one certification a machine.
    const dup = await db.customer.create({ data: { shopId: a.shopId, name: "Mae Maker (dup)" } });
    await setCertificationFor(user(a), dup.id, "Laser", true);
    await setCertificationFor(user(a), dup.id, "3D printer", true);
    await mergeCustomersFor(user(a), dup.id, mae.id, "Mae Maker (dup)");
    assert.deepEqual((await certificationsOf(a.shopId, mae.id)).map((c) => c.equipment), ["3D printer", "Laser", "Longarm"]);
    ok("merging: the kept customer's certifications stand, the duplicate's new ones move over");

    // 5. Tenant.
    await expectNotFound("B certifies A's customer", () => setCertificationFor(user(b), mae.id, "Longarm", true));
    assert.equal(await isCertified(db, b.shopId, mae.id, "Laser"), false);
    assert.deepEqual(await certifiedBy(b.shopId), []);
    ok("tenant: B can't certify A's customers nor see who is certified at A");
  } finally {
    await cleanup();
  }
  console.log(`maker-space.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
