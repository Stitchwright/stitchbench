// Marketing and web-store drafts (shop-features-round-2-design.md 5.2, package marketing-drafts):
//   1. the requests (pure): the shop's voice, {first_name} and {shop_name} in the email, no customer, the subject split off
//   2. a new arrivals email from items received in the last N days: this company's own, not a partner's consigned stock,
//      not older receipts, not another company's; nothing received = refused before any call
//   3. a class blurb from the form as typed (a new class) and a saved class's meetings; another company's class: not found
//   4. an item's online text from its fields and details (the call names the item); another company's item: not found
//   5. a social post about arrivals, a class or an item; anything else refused
//   6. the "Marketing drafts" switch off: refused, no call; every call logged with its feature (class draft)
//   npm run -s check scripts/checks/marketing-drafts.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { saveSettings } from "@/lib/assistant/bodies";
import { draftArrivals, draftClassBlurb, draftProductText, draftSocialPost } from "@/lib/assistant/marketing";
import { buildArrivals, splitSubject } from "@/lib/assistant/marketing-prompt";
import { assistantOn, expectUserError, ok, startAssistantHub, stepCount } from "./assistant-hub";
import { checkShop, cleanup } from "./lib";

const DAY = 86_400_000;

async function main() {
  // ===== 1. pure =====
  const built = buildArrivals([{ name: "Kona Navy", brand: "Robert Kaufman", collection: "Kona Solids", details: null, tags: ["navy"], priceCents: 1200, unit: "yd" }], 14, { shopName: "Quill Quilts", sample: "Come see us!" }, { names: ["Pat Quill"] }, "mention Pat Quill and 555-123-4567");
  assert.equal(built.feature, "draft_arrivals");
  assert.equal(built.cls, "draft");
  assert.match(built.system, /\{first_name\}/);
  assert.match(built.system, /\{shop_name\}/);
  assert.match(built.system, /Come see us!/);
  assert.match(built.messages[0].content, /Kona Navy by Robert Kaufman, Kona Solids collection \[navy\] \$12\.00 a yard/);
  assert.ok(!/Pat Quill|555-123/.test(JSON.stringify(built)), "the instruction is redacted");
  assert.deepEqual(splitSubject("Subject: Fresh fabric!\n\nHi {first_name},\nNew things."), { subject: "Fresh fabric!", body: "Hi {first_name},\nNew things." });
  assert.deepEqual(splitSubject("Fresh fabric\nHi there"), { subject: "Fresh fabric", body: "Hi there" });
  assert.deepEqual(splitSubject("Just one line"), { subject: "New this week", body: "Just one line" });
  ok("the requests: voice, merge fields, redacted; the subject split off");

  const a = await checkShop({ retail: true, modules: ["scheduling"] });
  const b = await checkShop({ retail: true });
  const hub = await startAssistantHub((rec) => {
    if (rec.system.includes("email to the shop's customers")) return "Subject: New fabric is in\n\nHi {first_name},\n\nKona Navy just arrived.\n\n{shop_name}";
    if (rec.system.includes("describing this class")) return "Learn to bind a quilt in one evening.";
    if (rec.system.includes("online store")) return "A soft 40 wt polyester thread for machine embroidery.";
    if (rec.system.includes("social media post")) return "New in! Come see us. #quilting";
    return "?";
  });
  try {
    const now = Date.now();
    const recent = await db.part.create({ data: { shopId: a.shopId, partNumber: "K-NAVY", description: "Kona Navy", kind: "FABRIC", unit: "yd", qtyOnHand: 15, priceCents: 1200, brand: "Robert Kaufman", collection: "Kona Solids", colorTags: ["navy"] } });
    const old = await db.part.create({ data: { shopId: a.shopId, partNumber: "OLD-1", description: "Old Gingham OLDONE", kind: "FABRIC", unit: "yd", qtyOnHand: 15 } });
    const consigned = await db.part.create({ data: { shopId: a.shopId, partNumber: "CN-1", description: "Partner bobbins CONSIGNED", kind: "PART", qtyOnHand: 4, consignLinkId: "x" } });
    const thread = await db.part.create({ data: { shopId: a.shopId, partNumber: "ISA-0015", description: "Isacord thread", kind: "THREAD", itemType: "thread", brand: "Isacord", colorNumber: "0015", colorName: "White", material: "polyester", specs: { weight: "40 wt" }, qtyOnHand: 12, priceCents: 899 } });
    await db.stockMove.createMany({
      data: [
        { shopId: a.shopId, partId: recent.id, qty: 15, reason: "RECEIVED", createdAt: new Date(now - 2 * DAY) },
        { shopId: a.shopId, partId: thread.id, qty: 12, reason: "RECEIVED", createdAt: new Date(now - 3 * DAY) },
        { shopId: a.shopId, partId: old.id, qty: 15, reason: "RECEIVED", createdAt: new Date(now - 40 * DAY) },
        { shopId: a.shopId, partId: consigned.id, qty: 4, reason: "RECEIVED", createdAt: new Date(now - 1 * DAY) },
      ],
    });
    const partB = await db.part.create({ data: { shopId: b.shopId, partNumber: "B-1", description: "B-SECRET fabric", kind: "FABRIC", unit: "yd", qtyOnHand: 5 } });
    await db.stockMove.create({ data: { shopId: b.shopId, partId: partB.id, qty: 5, reason: "RECEIVED" } });
    await db.customer.create({ data: { shopId: a.shopId, name: "Pat Quill", phone: "555-123-4567" } });

    await expectUserError("module off", () => draftArrivals(a.user, { days: 14 }), /Assistant isn't turned on/);
    await assistantOn(a.shopId);
    await assistantOn(b.shopId);

    // ===== 2. arrivals =====
    const em = await draftArrivals(a.user, { days: 14 });
    assert.deepEqual(em, { subject: "New fabric is in", body: "Hi {first_name},\n\nKona Navy just arrived.\n\n{shop_name}", count: 2 });
    const sent = hub.lastSent();
    assert.equal(hub.calls.at(-1)!.body.feature, "draft_arrivals");
    assert.equal(hub.calls.at(-1)!.body.model, "draft");
    assert.match(sent, /Kona Navy/);
    assert.match(sent, /Isacord 0015 White/, "the item's details line");
    assert.ok(!/OLDONE|CONSIGNED|B-SECRET|Pat Quill/.test(sent), "not older receipts, not consigned stock, not another company, no customer");
    await db.stockMove.deleteMany({ where: { shopId: b.shopId } });
    const before = hub.calls.length;
    await expectUserError("nothing received", () => draftArrivals(b.user, { days: 30 }), /Nothing was received in the last 30 days/);
    await expectUserError("nothing received, the default days", () => draftArrivals(b.user, { days: 0 }), /Nothing was received in the last 14 days/);
    assert.equal(hub.calls.length, before, "refused before any call");
    ok("a new arrivals email: this company's recent receipts only; nothing received = no call");

    // ===== 3. class blurb =====
    const t1 = await draftClassBlurb(a.user, { classId: null, title: "Binding basics", teacher: "Jo", fee: "$25", supplies: "A finished quilt top" });
    assert.equal(t1, "Learn to bind a quilt in one evening.");
    assert.match(hub.lastSent(), /Class: Binding basics/);
    assert.match(hub.lastSent(), /Fee: \$25\.00/);
    assert.equal(hub.calls.at(-1)!.body.feature, "draft_class");
    const cls = await db.shopClass.create({ data: { shopId: a.shopId, title: "Saved class", seats: 8, feeCents: 4000, firstAt: new Date(now + 5 * DAY), meetings: { create: [{ shopId: a.shopId, startsAt: new Date(now + 5 * DAY), endsAt: new Date(now + 5 * DAY + 7200000) }, { shopId: a.shopId, startsAt: new Date(now + 12 * DAY), endsAt: new Date(now + 12 * DAY + 7200000) }] } } });
    await draftClassBlurb(a.user, { classId: cls.id, title: "" });
    assert.match(hub.lastSent(), /Class: Saved class/);
    assert.match(hub.lastSent(), /Meetings: 2/);
    await expectUserError("no name", () => draftClassBlurb(a.user, { classId: null, title: " " }), /class name/);
    await expectUserError("another company's class", () => draftClassBlurb(b.user, { classId: cls.id }), /not found/);
    ok("a class blurb from the form as typed, or the saved class; another company's: not found");

    // ===== 4. item text =====
    assert.equal(await draftProductText(a.user, { partId: thread.id }), "A soft 40 wt polyester thread for machine embroidery.");
    assert.match(hub.lastSent(), /Item: Isacord thread/);
    assert.match(hub.lastSent(), /Details: Isacord 0015 White/);
    assert.equal((await db.assistantCall.findFirstOrThrow({ where: { shopId: a.shopId, feature: "draft_product" } })).partId, thread.id, "the log names the item");
    await expectUserError("another company's item", () => draftProductText(b.user, { partId: thread.id }), /not found/);
    ok("an item's online text from its fields and details; another company's: not found");

    // ===== 5. posts =====
    for (const o of [{ about: "arrivals" }, { about: "class", id: cls.id }, { about: "item", id: recent.id }]) {
      assert.equal(await draftSocialPost(a.user, o), "New in! Come see us. #quilting");
      assert.equal(hub.calls.at(-1)!.body.feature, "draft_post");
    }
    await expectUserError("about nothing", () => draftSocialPost(a.user, { about: "weather" }), /isn't something/);
    ok("social posts about arrivals, a class, an item");

    // ===== 6. the switch =====
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, marketingOn: false, offerFirstNames: false, voice: null });
    const k = hub.calls.length;
    await expectUserError("switched off", () => draftProductText(a.user, { partId: thread.id }), /switched off/);
    assert.equal(hub.calls.length, k);
    const logged = await db.assistantCall.groupBy({ by: ["feature"], where: { shopId: a.shopId, error: null }, _count: { _all: true } });
    assert.deepEqual(Object.fromEntries(logged.map((l) => [l.feature, l._count._all])), { draft_arrivals: 1, draft_class: 2, draft_product: 1, draft_post: 3 });
    ok("the switch off: refused, no call; every call logged under its feature");

    console.log(`marketing-drafts check: ${stepCount()} groups passed`);
  } finally {
    await hub.close();
  }
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
