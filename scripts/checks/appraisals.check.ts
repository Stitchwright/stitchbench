// Quilt appraisal certificates (shop-features-round-2-design.md 9.8, package appraisals): a new appraisal (a new
// customer, the quilt's details, forgiving inches and dollars, photos checked), the shop's fee and appraiser filled in
// (a tech can't change the fee), the draft changed, issuing (a value and an appraiser needed) rings the fee up at the
// register untaxed, an issued certificate can't change, voiding the fee makes it a draft, the customer delete keeps it
// without her, tenant.
//   npm run check scripts/checks/appraisals.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { voidSaleAs } from "@/lib/register-sale";
import { deleteCustomerFor } from "@/lib/merge";
import { appraisalPhoto, appraisalView, appraisalsFor, createAppraisalFor, issueAppraisalFor, removeAppraisalPhotoFor, saveAppraisalFor, saveAppraisalSettingsFor } from "@/lib/appraisals";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
const fd = (o: Record<string, string | File | File[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
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
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const photo = () => new File([PNG], "quilt.png", { type: "image/png" });

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 6.35 } });
    await expectError("a tech sets the fee", () => saveAppraisalSettingsFor(tech(a), fd({ fee: "1" })), /owner or admin/);
    await saveAppraisalSettingsFor(a.user, fd({ fee: "85", appraiser: "Ruth Appraiser", credential: "AQS Certified Appraiser" }));
    const base = { customerName: "Quilla Owner", customerPhone: "555-0150", title: "Grandmother's Flower Garden", widthIn: '72"', lengthIn: "90 in", maker: "Her grandmother", made: "About 1935", techniques: "Hand pieced, hand quilted", value: "$1,200", purpose: "insurance" };

    // 1. Starting.
    await expectError("no name", () => createAppraisalFor(a.user, fd({ ...base, title: " " })), /Name the quilt/);
    await expectError("a bad photo", () => createAppraisalFor(a.user, fd({ ...base, photo: new File([new Uint8Array([1])], "x.gif", { type: "image/gif" }) })), /JPEG, PNG or WebP/);
    const t1 = await createAppraisalFor(tech(a), fd({ ...base, fee: "1", photo: [photo(), photo()] }));
    let v = (await appraisalView(a.shopId, t1.id))!;
    assert.deepEqual([v.number, v.name, v.quilt.widthIn, v.quilt.lengthIn, v.valueCents, v.feeCents, v.appraiser, v.credential, v.photos.length], [1, "Quilla Owner", 72, 90, 120000, 8500, "Ruth Appraiser", "AQS Certified Appraiser", 2]);
    assert.ok(await appraisalPhoto(a.shopId, v.photos[0].id));
    ok("a new appraisal: a new customer, forgiving inches and dollars, two photos; the shop's fee and appraiser filled in (a tech's fee ignored)");

    // 2. The draft and issuing.
    await saveAppraisalFor(a.user, t1.id, fd({ ...base, value: "1500", fee: "75", appraiser: "Ruth Appraiser", condition: "Light fading" }));
    v = (await appraisalView(a.shopId, t1.id))!;
    assert.deepEqual([v.valueCents, v.feeCents, v.quilt.condition], [150000, 7500, "Light fading"]);
    await removeAppraisalPhotoFor(a.user, v.photos[1].id);
    await saveAppraisalFor(a.user, t1.id, fd({ ...base, value: "1500", fee: "75", appraiser: "" }));
    await expectError("no appraiser", () => issueAppraisalFor(a.user, t1.id, fd({ method: "CARD" })), /Name the appraiser/);
    await saveAppraisalFor(a.user, t1.id, fd({ ...base, value: "1500", fee: "75", appraiser: "Ruth Appraiser" }));
    assert.match(await issueAppraisalFor(a.user, t1.id, fd({ method: "CARD" })), /issued; the fee is sale #/);
    v = (await appraisalView(a.shopId, t1.id))!;
    const sale = await db.sale.findFirstOrThrow({ where: { id: v.saleId!, shopId: a.shopId }, include: { lines: true } });
    assert.deepEqual([sale.totalCents, sale.taxCents, sale.lines[0].taxable, (sale.tenders as { method: string }[])[0].method], [7500, 0, false, "CARD"], "the fee, untaxed, by card");
    await expectError("change it", () => saveAppraisalFor(a.user, t1.id, fd(base)), /is issued: it can't be changed/);
    await expectError("issue twice", () => issueAppraisalFor(a.user, t1.id, null), /already issued/);
    await expectError("remove a photo", () => removeAppraisalPhotoFor(a.user, v.photos[0].id), /photos stay/);
    await voidSaleAs(a.user, sale.id, "wrong card");
    v = (await appraisalView(a.shopId, t1.id))!;
    assert.deepEqual([v.issuedAt, v.saleId], [null, null], "the void makes it a draft again");
    ok("the draft changed (value, fee, condition, a photo off); issuing needs an appraiser, rings the fee up untaxed; issued it is fixed; the void undoes it");

    // 3. The customer delete; tenant.
    await expectNotFound("B saves A's", () => saveAppraisalFor(b.user, t1.id, fd(base)));
    await expectNotFound("B issues A's", () => issueAppraisalFor(b.user, t1.id, null));
    await expectNotFound("B removes A's photo", () => removeAppraisalPhotoFor(b.user, v.photos[0].id));
    assert.equal(await appraisalView(b.shopId, t1.id), null);
    assert.equal(await appraisalPhoto(b.shopId, v.photos[0].id), null);
    assert.deepEqual(await appraisalsFor(b.shopId), []);
    const custId = v.customerId!;
    await db.sale.updateMany({ where: { shopId: a.shopId, customerId: custId }, data: { customerId: null } });
    await deleteCustomerFor(a.user, custId, "Quilla Owner");
    v = (await appraisalView(a.shopId, t1.id))!;
    assert.deepEqual([v.customerId, v.name, v.photos.length], [null, "Deleted customer", 0]);
    ok("tenant: B can't change, issue, read or see A's photos; deleting the customer keeps the appraisal without her or the photos");
  } finally {
    await cleanup();
  }
  console.log(`appraisals.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
