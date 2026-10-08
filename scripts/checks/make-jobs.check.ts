// Print and cut jobs (shop-features-round-2-design.md 6.5, package make-jobs, Maker Shop): the price (machine time, material
// by the gram, ml or sheet, set-up), the never-cut list, taking a job with its file (a tech gets the shop's rates), the
// steps, turning a job down, collecting it as a register sale and voiding that sale, the quote by estimate link
// (approving it moves the job on), files deleted 30 days after the job ends, the Maker Shop gate, the customer delete,
// and the tenant section.
//   npm run check scripts/checks/make-jobs.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { makePrice, materialMeasure, neverCutHit, statusLabel } from "@/lib/make-jobs-math";
import { collectJobFor, createJobFor, jobFile, jobView, jobsFor, purgeJobFiles, saveJobFor, setJobStatusFor, turnDownFor } from "@/lib/make-jobs";
import { answerByToken, createEstimateLink } from "@/lib/estimate-links";
import { unseal } from "@/lib/messaging/secrets";
import { voidSaleAs } from "@/lib/register-sale";
import { customerDeletePlan } from "@/lib/merge";
import { grantDevLicense } from "../license/dev";
import { checkShop, cleanup, type CheckShop } from "./lib";
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
const fd = (o: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function main() {
  // 1. The math.
  assert.deepEqual(makePrice({ minutes: 90, rateCents: 2000, materialQty: 120, materialUnitCents: 2.5, setupCents: 500 }), { machineCents: 3000, materialCents: 300, setupCents: 500, totalCents: 3800 });
  assert.deepEqual(materialMeasure({ kind: "SUPPLY", itemType: "filament", priceCents: 2500, specs: { spool: "1 kg" } }), { unit: "g", unitCents: 2.5 });
  assert.deepEqual(materialMeasure({ kind: "SUPPLY", itemType: "filament", priceCents: 1000, specs: { spool: "250 g" } }), { unit: "g", unitCents: 4 });
  assert.deepEqual(materialMeasure({ kind: "SUPPLY", itemType: "resin", priceCents: 3000, specs: { volume: "500 ml" } }), { unit: "ml", unitCents: 6 });
  assert.deepEqual(materialMeasure({ kind: "SUPPLY", itemType: "laser-material", priceCents: 899, specs: {} }), { unit: "sheet", unitCents: 899 });
  assert.equal(neverCutHit("PVC, vinyl", { description: "Clear PVC sheet 3 mm" }), "pvc");
  assert.equal(neverCutHit("PVC, vinyl", { material: "Vinyl" }), "vinyl");
  assert.equal(neverCutHit("PVC, vinyl", { description: "Birch plywood", material: "Birch plywood" }), null);
  assert.deepEqual([statusLabel("WORKING", "PRINT"), statusLabel("WORKING", "LASER"), statusLabel("TURNED_DOWN", "CUT")], ["Printing", "Cutting", "Turned down"]);
  ok("the price: an hour and a half at $20, 120 g of $25 a kg filament, $5 set-up; resin by the ml, stock by the sheet; never cut PVC or vinyl; the words");

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const pla = await db.part.create({ data: { shopId: a.shopId, partNumber: "PLA-BLK", numberKeys: ["PLABLK"], description: "PLA black", kind: "SUPPLY", itemType: "filament", specs: { spool: "1 kg" }, priceCents: 2500, qtyOnHand: 4 } });
    const pvc = await db.part.create({ data: { shopId: a.shopId, partNumber: "PVC-3", numberKeys: ["PVC3"], description: "Clear PVC sheet", kind: "SUPPLY", itemType: "laser-material", priceCents: 600, qtyOnHand: 4 } });
    const birch = await db.part.create({ data: { shopId: a.shopId, partNumber: "BIRCH-3", numberKeys: ["BIRCH3"], description: "Birch plywood 3 mm", kind: "SUPPLY", itemType: "laser-material", material: "Birch plywood", priceCents: 450, qtyOnHand: 10 } });
    const base = { customerName: "Mae Maker", customerPhone: "555-0101", title: "Phone stand", kind: "PRINT", hours: "1", minutes: "30", materialPartId: pla.id, materialQty: "120" };

    // 2. The gate, then taking a job.
    await expectError("no Maker Shop", () => createJobFor(user(a), fd(base)), /Maker Shop/);
    await grantDevLicense(a.shopId, ["maker"], { from: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) });
    const file = new File([new Uint8Array([1, 2, 3, 4])], "stand.3mf", { type: "model/3mf" });
    const j1 = await createJobFor(user(a), fd({ ...base, file }));
    let v = (await jobView(a.shopId, j1.id))!;
    assert.deepEqual([v.number, v.status, v.quoteCents, v.materialCents, v.materialUnit, v.rateCents, v.setupCents, v.hasFile, v.fileName], [1, "QUOTED", 3800, 300, "g", 2000, 500, true, "stand.3mf"]);
    const t1 = await createJobFor(tech(a), fd({ ...base, title: "Tech's job", rate: "1.00", setup: "0", file: new File([new Uint8Array([9, 9])], "logo.svg", { type: "image/svg+xml" }) }));
    assert.deepEqual([(await jobView(a.shopId, t1.id))!.rateCents, (await jobView(a.shopId, t1.id))!.setupCents], [2000, 500], "a tech's job takes the shop's rate and set-up fee");
    await expectError("laser on PVC", () => createJobFor(user(a), fd({ ...base, title: "Name tags", kind: "LASER", materialPartId: pvc.id, materialQty: "2" })), /never cuts pvc/);
    await expectError("laser on vinyl typed", () => createJobFor(user(a), fd({ ...base, title: "Decal", kind: "LASER", materialPartId: "", materialName: "her own vinyl" })), /never cuts vinyl/);
    const j2 = await createJobFor(user(a), fd({ ...base, title: "20 name tags", kind: "LASER", hours: "0", minutes: "45", materialPartId: birch.id, materialQty: "2" }));
    assert.equal((await jobView(a.shopId, j2.id))!.quoteCents, 1500 + 900 + 500, "45 minutes, two sheets, set-up");
    await expectError("too big a file", () => createJobFor(user(a), fd({ ...base, file: new File([new Uint8Array(11 * 1024 * 1024)], "big.stl") })), /larger than 10 MB/);
    ok("taking a job: Maker Shop on, the price worked out, the file kept; a tech gets the shop's rates; the laser refuses PVC and vinyl; files 10 MB at most");

    // 3. The steps, turning down.
    await expectError("quoted to printing", () => setJobStatusFor(user(a), j1.id, "WORKING"), /can't go to printing/);
    await setJobStatusFor(user(a), j1.id, "APPROVED");
    await saveJobFor(user(a), j1.id, fd({ ...base, hours: "2", minutes: "0" }));
    assert.equal((await jobView(a.shopId, j1.id))!.quoteCents, 4000 + 300 + 500, "changed while approved: priced again");
    await setJobStatusFor(user(a), j1.id, "WORKING");
    await saveJobFor(user(a), j1.id, fd({ ...base, hours: "2" }));
    assert.equal((await jobView(a.shopId, j1.id))!.quoteCents, 5000 + 300 + 500, "changed while printing (2 h 30): priced again");
    assert.match(await setJobStatusFor(user(a), j1.id, "READY"), /is ready/);
    await expectError("change when ready", () => saveJobFor(user(a), j1.id, fd(base)), /can't be changed/);
    await expectError("no reason", () => turnDownFor(user(a), t1.id, " "), /Say why/);
    await turnDownFor(user(a), t1.id, "A copied logo");
    v = (await jobView(a.shopId, t1.id))!;
    assert.deepEqual([v.status, v.turnedDownWhy, !!v.fileDeleteAfter], ["TURNED_DOWN", "A copied logo", true]);
    await expectError("turn down a ready job", () => turnDownFor(user(a), j1.id, "x"), /can't be turned down/);
    ok("the steps: quoted, approved, printing, ready (changes priced again until ready); turned down with a reason, kept as a record");

    // 4. Collecting, voiding.
    await expectError("collect a quoted job", () => collectJobFor(user(a), j2.id, fd({ method: "CASH" })), /Only a ready job/);
    assert.match(await collectJobFor(user(a), j1.id, fd({ method: "CARD" })), /collected: sale #/);
    v = (await jobView(a.shopId, j1.id))!;
    const sale = await db.sale.findFirstOrThrow({ where: { id: v.saleId!, shopId: a.shopId }, include: { lines: true } });
    assert.deepEqual([v.status, sale.totalCents, sale.lines.length, (sale.tenders as { method: string }[])[0].method], ["COLLECTED", 5800, 3, "CARD"]);
    assert.ok(v.fileDeleteAfter && +v.fileDeleteAfter - Date.now() > 29 * DAY, "the file goes 30 days after pickup");
    await voidSaleAs(user(a), sale.id, "wrong job");
    v = (await jobView(a.shopId, j1.id))!;
    assert.deepEqual([v.status, v.saleId, v.fileDeleteAfter], ["READY", null, null], "voiding the sale puts it back on the shelf with its file");
    ok("collecting: billed as a register sale (machine, material, set-up) in the payment picked; voiding it makes the job ready again");

    // 5. The quote by link.
    if (!process.env.PUBLIC_URL) process.env.PUBLIC_URL = "http://localhost:3000";
    const link = await db.$transaction((tx) => createEstimateLink(tx, { shopId: a.shopId, makeJobId: j2.id, customerId: v.customerId!, totalCents: 2900, lines: [{ description: "Laser", amountCents: 2900 }], note: null, days: 7, byUserId: a.user.id }));
    const row = await db.estimateLink.findFirstOrThrow({ where: { id: link.id } });
    const token = unseal(row.tokenSealed, a.shopId, `estimateToken:${row.id}`)!.plain;
    assert.equal(await answerByToken(token, "APPROVED", "Yes please", "check"), "ok");
    v = (await jobView(a.shopId, j2.id))!;
    assert.equal(v.status, "APPROVED");
    assert.match(v.note ?? "", /approved the quote by link: Yes please/);
    ok("the quote by link: the customer's approval moves the job to approved, her words in its note");

    // 6. Files after their days; the customer delete.
    assert.ok(await jobFile(a.shopId, t1.id), "a turned-down job's file is kept for now");
    await db.makeJob.update({ where: { id: t1.id }, data: { fileDeleteAfter: new Date(Date.now() - DAY) } });
    assert.equal(await jobFile(a.shopId, t1.id), null, "past its days it can't be downloaded");
    assert.equal(await purgeJobFiles(a.shopId), 1);
    v = (await jobView(a.shopId, t1.id))!;
    assert.deepEqual([v.hasFile, v.fileName], [false, "logo.svg"], "deleted, its name kept");
    assert.ok((await jobsFor(a.shopId)).some((r) => r.id === j2.id));
    const plan = await customerDeletePlan(user(a), (await jobView(a.shopId, j2.id))!.customerId!);
    assert.ok(plan.blockers.some((x) => /Print or cut job #\d+ isn't collected yet/.test(x)), "an open job blocks deleting the customer");
    ok("files: unavailable past their days, deleted (the name kept); an open job blocks deleting the customer");

    // 7. Tenant.
    await grantDevLicense(b.shopId, ["maker"], { from: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) });
    await expectNotFound("B moves A's job", () => setJobStatusFor(user(b), j2.id, "WORKING"));
    await expectNotFound("B collects A's job", () => collectJobFor(user(b), j1.id, fd({ method: "CASH" })));
    await expectNotFound("B turns down A's job", () => turnDownFor(user(b), j2.id, "no"));
    assert.equal(await jobView(b.shopId, j1.id), null);
    assert.equal(await jobFile(b.shopId, j1.id), null);
    assert.deepEqual(await jobsFor(b.shopId), []);
    await expectError("B uses A's material", () => createJobFor(user(b), fd({ ...base, materialPartId: pla.id })), /isn't in your inventory/);
    ok("tenant: B can't move, collect, turn down, read or download A's jobs, nor use A's material");
  } finally {
    await cleanup();
  }
  console.log(`make-jobs.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
