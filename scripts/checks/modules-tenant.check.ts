// Tenant section of the modules foundation (modules-design.md section 13.1 and acceptance item 6): companies A and B
// both have Vac Shop and Small Appliance Repair switched on (Settings → Features); B calls the foundation's lib bodies,
// gates and stubs with A's ids and gets "not found", false, null or [], B's own switches leave A's alone, and A's rows
// don't change.
//   npx tsx --conditions=react-server scripts/checks/modules-tenant.check.ts
// Throwaway companies "Check <run> A" / " B", removed at the end. Exit code non-zero on the first failing assertion.
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { convertMachineKindFor } from "@/lib/equipment/convert";
import { machineWorkable, ticketWorkable } from "@/lib/equipment/gate";
import { saveIntakeFor, saveReadingsFor } from "@/lib/equipment/ticket-data";
import { modelKey } from "@/lib/format";
import { loadModules } from "@/lib/modules";
import { listInstalls } from "@/lib/vac/installs";
import { listUnits, unitDetail } from "@/lib/units/units";
import { switchFeatures } from "./lib";
import { assertUnchanged, expectNotFound, makeCompany, removeCompany, RUN, snapshot } from "./tenant";

const TABLES = ["Shop", "User", "License", "ModuleGrant", "Machine", "Ticket", "ServiceItem"];
/** A company's Features as JSON (the table has no id to order snapshot() by). */
const featuresOf = async (shopId: string) => JSON.stringify(await db.shopFeature.findMany({ where: { shopId }, orderBy: { module: "asc" } }));

let steps = 0;
const ok = (label: string) => {
  steps += 1;
  console.log(`  ok  ${label}`);
};

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

async function main() {
  const a = await makeCompany(`Check ${RUN} A`);
  const b = await makeCompany(`Check ${RUN} B`);
  try {
    await switchFeatures(a.shopId, ["vac", "appliance"]);
    await switchFeatures(b.shopId, ["vac", "appliance"]);
    for (const c of [a, b]) {
      const m = await loadModules(c.shopId);
      assert.equal(m.states.vac.active, true);
      assert.equal(m.states.appliance.active, true);
    }
    // A's records: a vacuum with an open ticket that has readings and answers.
    const machine = await db.machine.create({
      data: { shopId: a.shopId, brand: "Miele", model: "C3", modelKey: modelKey("C3"), equipment: "VACUUM", kind: "vacuum", details: { bagged: "Bagged", bagType: "GN" } },
      select: { id: true },
    });
    const ticket = await db.ticket.create({ data: { shopId: a.shopId, number: 1, machineId: machine.id, readings: { suction: { found: 60 } }, intake: {} }, select: { id: true } });
    ok("two companies with Vac Shop and Small Appliance Repair, A with a vacuum ticket");

    // Controls: A itself can work on its own records, so B's "false" below isn't a bad id. (The save bodies aren't
    // run for A here: on success they call Next's revalidatePath, which only works inside a request.)
    assert.equal(await ticketWorkable(a.shopId, ticket.id), true);
    assert.equal(await machineWorkable(a.shopId, machine.id), true);
    ok("A can work on its own ticket and machine");

    const before = await snapshot(a.shopId, TABLES);
    const bBefore = await snapshot(b.shopId, TABLES);
    const aFeatures = await featuresOf(a.shopId);

    await expectNotFound("saveReadingsFor(B, A's ticket)", () => saveReadingsFor(b.user, ticket.id, form({ "found:suction": "10", "left:suction": "20" })));
    await expectNotFound("saveIntakeFor(B, A's ticket)", () => saveIntakeFor(b.user, ticket.id, form({ "f:bagged": "Bagless", "f:bagType": "changed" })));
    await assert.rejects(saveIntakeFor(b.user, ticket.id, form({ "f:bagged": "Bagless" })), { message: "Ticket not found." });
    await assert.rejects(saveReadingsFor(b.user, ticket.id, form({})), { message: "Ticket not found." });
    ok("saveReadingsFor / saveIntakeFor: Ticket not found.");

    await expectNotFound("convertMachineKindFor(B, A's machine)", () => convertMachineKindFor(b.user, machine.id, form({ kind: "stand-mixer" })));
    await assert.rejects(convertMachineKindFor(b.user, machine.id, form({ kind: "stand-mixer" })), { message: "Machine not found." });
    ok("convertMachineKindFor: Machine not found.");

    await expectNotFound("ticketWorkable(B, A's ticket)", () => ticketWorkable(b.shopId, ticket.id));
    await expectNotFound("machineWorkable(B, A's machine)", () => machineWorkable(b.shopId, machine.id));
    assert.equal(await ticketWorkable(b.shopId, ticket.id), false);
    assert.equal(await machineWorkable(b.shopId, machine.id), false);
    ok("ticketWorkable / machineWorkable: false");

    await expectNotFound("unitDetail(B, A's machine id)", () => unitDetail(b.shopId, machine.id));
    await expectNotFound("unitDetail(B, A's ticket id)", () => unitDetail(b.shopId, ticket.id));
    await expectNotFound("unitDetail(B, A's shop id)", () => unitDetail(b.shopId, a.shopId));
    await expectNotFound("listUnits(B)", () => listUnits(b.shopId, null, null));
    await expectNotFound("listInstalls(B)", () => listInstalls(b.shopId));
    ok("unitDetail null, listUnits [], listInstalls [] (the stubs)");

    assertUnchanged("company A", before, await snapshot(a.shopId, TABLES));
    assertUnchanged("company B", bBefore, await snapshot(b.shopId, TABLES));
    ok("A's rows (and B's) unchanged");

    // B's Features are its own: B switching Vac Shop off leaves A's on, and A's rows as they were.
    await switchFeatures(b.shopId, ["vac"], false);
    assert.equal((await loadModules(b.shopId)).states.vac.active, false);
    assert.equal((await loadModules(a.shopId)).states.vac.active, true, "A's Vac Shop is still on");
    assert.equal(await ticketWorkable(a.shopId, ticket.id), true);
    assertUnchanged("company A", before, await snapshot(a.shopId, TABLES));
    assert.equal(await featuresOf(a.shopId), aFeatures, "A's Features rows unchanged");
    ok("B's switch changes nothing of A's");

    console.log(`modules-tenant.check: ${steps} steps passed (run ${RUN})`);
  } finally {
    for (const id of [a.shopId, b.shopId]) await removeCompany(id).catch((e) => console.error(`cleanup of ${id} failed:`, e));
    const left = await db.shop.count({ where: { name: { startsWith: `Check ${RUN}` } } });
    if (left) console.error(`cleanup: ${left} "Check ${RUN}" companies left behind`);
    await db.$disconnect();
    if (left) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
