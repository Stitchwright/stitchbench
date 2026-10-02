// Central vac installs (modules-design.md 10.d, package central-vac-installs): createSiteJob / createInstallFor make
// a SITE ticket, its TicketSite and the power unit (or the placeholder), quoteFirst starts at Quote sent, the bench
// query leaves installs out, siteJobsBetween answers for the day and nothing for a company without Vac Shop, the SITE
// status list, saveSiteFor / setPowerUnitFor, the lapsed module (an install booked before the end can still be
// changed; a new one is refused), and the tenant section.
//   npm run check scripts/checks/vac-installs.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { OPEN_STATUSES, SITE_STATUS_ORDER } from "@/lib/constants";
import { modelKey } from "@/lib/format";
import { loadModules } from "@/lib/modules";
import type { CurrentUser } from "@/lib/session";
import { createInstallFor, createSiteJob, INSTALL_CHECKLIST, listInstalls, saveSiteFor, setPowerUnitFor, siteJobsBetween, siteOf, UNIT_TBD } from "@/lib/vac/installs";
import { addDays, dayStart, ymdOf } from "@/lib/zoned";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

const NY = "America/New_York";
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
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

const ticketOf = (id: string) => db.ticket.findUniqueOrThrow({ where: { id }, include: { machine: true, site: true, lines: true, customer: true } });

async function main() {
  const a = await checkShop({ retail: true, repair: true, modules: ["vac"] });
  const b = await checkShop({ retail: true, repair: true, modules: ["vac"] });
  const c = await checkShop({ retail: true, repair: true });
  try {
    const today = ymdOf(new Date(), NY);
    const tomorrow = addDays(today, 1);
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Home Owner", phone: "555-0103", address: "4 Maple Ave, Springfield" } });

    // 1. A booked install with no unit yet: the placeholder machine, the site at the customer's address, Booked.
    const r1 = await createInstallFor(user(a), form({ customerId: cust.id, date: tomorrow, start: "09:00", end: "11:00", contactName: "Sam", contactPhone: "555-0104", accessNotes: "dog in the yard" }));
    const t1 = await ticketOf(r1.ticketId);
    assert.equal(t1.jobType, "SITE");
    assert.equal(t1.status, "AT_SHOP_AWAITING_PICKUP");
    assert.equal(t1.number, r1.number);
    assert.equal(t1.serviceRequested, "Central vac install");
    assert.ok(t1.machine.brand === UNIT_TBD.brand && t1.machine.model === UNIT_TBD.model && t1.machine.machineType === "Central" && t1.machine.equipment === "VACUUM" && t1.machine.customerId === cust.id);
    assert.ok(t1.site && t1.site.address === "4 Maple Ave, Springfield" && t1.site.shopId === a.shopId && t1.site.contactName === "Sam" && t1.site.accessNotes === "dog in the yard");
    assert.equal(t1.site!.startsAt?.getTime(), dayStart(tomorrow, NY).getTime() + 9 * 3_600_000);
    assert.equal(t1.lines.length, 0);
    assert.equal(INSTALL_CHECKLIST.length, 10);
    ok("a booked install: SITE ticket, the placeholder power unit, the site at the customer's address, the window in shop time");

    // 2. Quote first, a new customer, a chosen unit and a menu service.
    // The vacuum menu's install, priced (the starter menu is created switched off at $0 when the module is turned on in Settings; a dev key doesn't run that).
    const svc = await db.serviceItem.create({ data: { shopId: a.shopId, name: "Central vac installation", priceCents: 150000, equipmentKind: "vacuum", active: true } });
    const r2 = await createInstallFor(user(a), form({ customerName: "New Build", customerPhone: "555-0105", address: "9 Elm St", quoteFirst: "on", unitBrand: "Beam", unitModel: "SC375", unitSerial: "BM-1", serviceItemId: svc.id, notes: "three inlets" }));
    const t2 = await ticketOf(r2.ticketId);
    assert.equal(t2.status, "WAITING_CUSTOMER_OK");
    assert.ok(t2.customer && t2.customer.name === "New Build" && t2.customer.address === "9 Elm St", "the new customer, with the site as their address");
    assert.ok(t2.machine.brand === "Beam" && t2.machine.model === "SC375" && t2.machine.serial === "BM-1" && t2.machine.customerId === t2.customerId);
    assert.equal(t2.site?.startsAt, null);
    assert.deepEqual(
      t2.lines.map((l) => [l.kind, l.description, l.unitPriceCents]),
      [["SERVICE", svc.name, 150000]],
    );
    assert.equal(t2.notes, "three inlets");
    assert.equal(t2.serviceRequested, svc.name);
    ok("quote first starts at Quote sent; a new customer, the chosen power unit and the menu's install line are made with it");

    // Refusals.
    await expectError("no customer", () => createInstallFor(user(a), form({ address: "1 A St" })), /name and a phone or email/);
    const bare = await db.customer.create({ data: { shopId: a.shopId, name: "No Address" } });
    await expectError("no address anywhere", () => createInstallFor(user(a), form({ customerId: bare.id })), /Enter where the install is/);
    await expectError("half a unit", () => createInstallFor(user(a), form({ customerId: cust.id, unitBrand: "Beam" })), /brand and model/);
    await expectError("a date without times", () => createInstallFor(user(a), form({ customerId: cust.id, date: tomorrow })), /start time/);
    const bOwner = await db.customer.create({ data: { shopId: b.shopId, name: "B Owner" } });
    await expectError("another company's customer", () => createInstallFor(user(a), form({ customerId: bOwner.id, address: "x" })), /Customer not found/);
    ok("refused: no customer, no address, half a power unit, a date with no times, another company's customer");

    // 3. The bench queries leave installs out; the install list has them.
    assert.equal(await db.ticket.count({ where: { shopId: a.shopId, jobType: "BENCH", status: { in: OPEN_STATUSES } } }), 0);
    assert.equal(await db.ticket.count({ where: { shopId: a.shopId, jobType: "SITE" } }), 2);
    let up = await listInstalls(a.shopId, "upcoming");
    assert.deepEqual(
      up.map((j) => j.ticketId),
      [t1.id, t2.id],
      "scheduled first, unscheduled last",
    );
    assert.equal(up[0].unit, null);
    assert.equal(up[1].unit, "Beam SC375 S/N BM-1");
    assert.equal((await listInstalls(a.shopId, "done")).length, 0);
    ok("the dashboard's BENCH query doesn't see installs; the install list does, scheduled first");

    // 4. The calendar's window; nothing for a company without Vac Shop even with a site row.
    const day = await siteJobsBetween(a.shopId, dayStart(tomorrow, NY), dayStart(addDays(tomorrow, 1), NY));
    assert.deepEqual(
      day.map((j) => [j.ticketId, j.address, j.customerName]),
      [[t1.id, "4 Maple Ave, Springfield", "Home Owner"]],
    );
    assert.deepEqual(await siteJobsBetween(a.shopId, dayStart(addDays(tomorrow, 1), NY), dayStart(addDays(tomorrow, 2), NY)), []);
    const cc = await db.customer.create({ data: { shopId: c.shopId, name: "C Owner" } });
    await db.$transaction((tx) => createSiteJob(tx, { shopId: c.shopId, userId: c.user.id, customerId: cc.id, address: "C St", startsAt: dayStart(tomorrow, NY), endsAt: new Date(dayStart(tomorrow, NY).getTime() + 7_200_000), contactName: null, contactPhone: null, accessNotes: null, quoteFirst: false, unit: null, serviceItemId: null, notes: null }));
    assert.equal(await db.ticketSite.count({ where: { shopId: c.shopId } }), 1);
    assert.deepEqual(await siteJobsBetween(c.shopId, dayStart(tomorrow, NY), dayStart(addDays(tomorrow, 1), NY)), [], "Vac Shop off: nothing on the calendar");
    ok("siteJobsBetween answers for the day, and nothing for a company whose Vac Shop is off");

    // 5. The SITE status list (the action's rule: a status outside it is refused for installs).
    assert.deepEqual(SITE_STATUS_ORDER, ["WAITING_CUSTOMER_OK", "AT_SHOP_AWAITING_PICKUP", "WAITING_PARTS", "ON_BENCH", "COLLECTED", "RETURNED_UNREPAIRED"]);
    assert.ok(!SITE_STATUS_ORDER.includes("READY_FOR_PICKUP"));
    ok("the SITE statuses are Quote sent, Booked, Waiting on parts, In progress, Completed, Cancelled (no Ready for pickup)");

    // 6. Change the site; set the power unit.
    await saveSiteFor(user(a), t1.id, form({ address: "12 Oak St", date: addDays(tomorrow, 1), start: "13:00", end: "16:30", contactName: "Sam" }));
    let s1 = await siteOf(a.shopId, t1.id);
    assert.ok(s1 && s1.address === "12 Oak St" && s1.startsAt?.getTime() === dayStart(addDays(tomorrow, 1), NY).getTime() + 13 * 3_600_000 && s1.accessNotes === null);
    await saveSiteFor(user(a), t1.id, form({ address: "" }));
    s1 = await siteOf(a.shopId, t1.id);
    assert.ok(s1 && s1.address === "12 Oak St" && s1.startsAt === null, "a blank address keeps the old one; a blank date means not scheduled");
    await setPowerUnitFor(user(a), t1.id, form({ unitBrand: "NuTone", unitModel: "PP650", unitSerial: "NT-1" }));
    const m1 = await db.machine.findUniqueOrThrow({ where: { id: t1.machineId } });
    assert.ok(m1.brand === "NuTone" && m1.model === "PP650" && m1.serial === "NT-1" && m1.modelKey === modelKey("PP650") && m1.machineType === "Central");
    assert.equal((await siteOf(a.shopId, t1.id))?.unit, "NuTone PP650 S/N NT-1");
    await expectError("power unit without a model", () => setPowerUnitFor(user(a), t1.id, form({ unitBrand: "NuTone" })), /brand and model/);
    const bench = await db.ticket.create({ data: { shopId: a.shopId, number: 9201, machineId: t1.machineId, intake: {} } });
    await expectError("not an install", () => saveSiteFor(user(a), bench.id, form({ address: "x" })), /Install not found/);
    // Done: a Completed install moves to the Done tab.
    await db.ticket.update({ where: { id: t2.id }, data: { status: "COLLECTED", closedAt: new Date() } });
    up = await listInstalls(a.shopId, "upcoming");
    assert.deepEqual(
      up.map((j) => j.ticketId),
      [t1.id],
    );
    assert.deepEqual(
      (await listInstalls(a.shopId, "done")).map((j) => j.ticketId),
      [t2.id],
    );
    assert.equal((await listInstalls(a.shopId, "all")).length, 2);
    ok("saveSiteFor and setPowerUnitFor change the site and the unit; a bench ticket isn't an install; Completed moves to Done");

    // 7. Tenant: B with A's ticket.
    const siteRows = () => db.ticketSite.findMany({ where: { shopId: a.shopId }, orderBy: { ticketId: "asc" } }).then((r) => JSON.stringify(r));
    const [before, sitesBefore] = await Promise.all([snapshot(a.shopId, ["Machine", "Ticket"]), siteRows()]);
    await expectNotFound("saveSiteFor(B, A's install)", () => saveSiteFor(user(b), t1.id, form({ address: "stolen" })));
    await expectNotFound("setPowerUnitFor(B, A's install)", () => setPowerUnitFor(user(b), t1.id, form({ unitBrand: "X", unitModel: "Y" })));
    await expectNotFound("siteOf(B, A's install)", () => siteOf(b.shopId, t1.id));
    assert.deepEqual(await listInstalls(b.shopId, "all"), []);
    assertUnchanged("tenant", before, await snapshot(a.shopId, ["Machine", "Ticket"]));
    assert.equal(await siteRows(), sitesBefore);
    ok("tenant: B's calls with A's install answer 'Install not found.' and A's rows are unchanged");

    // 8. Vac Shop switched off for A: the install booked before can still be changed; a new one is refused.
    await db.moduleGrant.create({ data: { shopId: a.shopId, module: "vac", mode: "off", byEmail: "check@stitchbench.test" } });
    const m = await loadModules(a.shopId);
    assert.equal(m.states.vac.status, "lapsed");
    await saveSiteFor(user(a), t1.id, form({ address: "12 Oak St, rear" }));
    assert.equal((await siteOf(a.shopId, t1.id))?.address, "12 Oak St, rear");
    await expectError("new install after the end", () => createInstallFor(user(a), form({ customerId: cust.id })), /switched off|ended on/);
    assert.equal((await siteJobsBetween(a.shopId, dayStart(today, NY), dayStart(addDays(today, 30), NY))).length, 0, "t1 is unscheduled now; the lapsed company's records would still show");
    ok("after Vac Shop ends: an install booked before can still be changed, a new one is refused");
  } finally {
    await cleanup();
  }
  console.log(`vac-installs.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
