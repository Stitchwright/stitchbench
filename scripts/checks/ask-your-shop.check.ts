// Ask your shop (shop-features-round-2-design.md 5.1, package ask-your-shop):
//   1. the pick checked (pure): an unknown report is "none", dates clamped to real days up to today, kind and collection
//      only from the lists, top N 1-50; the requests carry no customer (a name, a phone in the question are blanked)
//   2. a question end to end through the stand-in hub: two ask_shop calls (suggest), the numbers from the program's own
//      report (best sellers of fabric in a collection), the answer worded from them; both calls logged
//   3. no report covers it: one call, "I can't answer that from your reports yet" and the list
//   4. refused: a tech, the module off, the "Ask your shop" switch off (no call made)
//   5. every report in the registry runs; another company's sales never appear
//   npm run -s check scripts/checks/ask-your-shop.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { askShop, CANT_ANSWER } from "@/lib/assistant/ask";
import { buildAskChoose, buildAskWord, parseAskChoice } from "@/lib/assistant/ask-prompt";
import { saveSettings } from "@/lib/assistant/bodies";
import { checkChoice, REPORT_IDS } from "@/lib/reports/registry-defs";
import { runReport } from "@/lib/reports/registry";
import { todayIn } from "@/lib/time-zone";
import { assistantOn, expectUserError, ok, startAssistantHub, stepCount } from "./assistant-hub";
import { checkShop, cleanup } from "./lib";

let saleNo = 0;
async function sale(shopId: string, customerId: string | null, lines: { partId: string; description: string; qty: number; cents: number; unit?: string }[]) {
  const total = lines.reduce((a, l) => a + Math.round(l.qty * l.cents), 0);
  saleNo += 1;
  return db.sale.create({
    data: { shopId, number: saleNo, customerId, subtotalCents: total, taxCents: 0, totalCents: total, taxRatePct: 0, tenders: [{ method: "CASH", amountCents: total }], lines: { create: lines.map((l) => ({ partId: l.partId, description: l.description, qty: l.qty, unit: l.unit ?? null, unitPriceCents: l.cents, kind: "FABRIC" })) } },
  });
}

async function main() {
  // ===== 1. pure =====
  const today = "2026-10-07";
  assert.deepEqual(checkChoice({ report: "poems" }, today, []), { report: "none" });
  assert.equal(checkChoice("nope", today, []), null);
  const c1 = checkChoice({ report: "best_sellers", from: "2026-03-20", to: "2027-01-01", kind: "fabric", collection: "kona", top: 500 }, today, ["Kona Solids", "Grunge"]);
  assert.deepEqual(c1, { report: "best_sellers", params: { from: "2026-03-20", to: today, kind: "FABRIC", collection: "Kona Solids", top: 50 } });
  const c2 = checkChoice({ report: "sales_by_kind", from: "2026-09-31", to: "2026-05-01", kind: "PART", collection: "Kona Solids", top: 3 }, today, ["Kona Solids"]);
  assert.deepEqual(c2, { report: "sales_by_kind", params: { from: "2026-01-01", to: "2026-05-01", kind: null, collection: null, top: 25 } }, "a day that doesn't exist is the year's start; settings a report doesn't take are dropped");
  const c3 = checkChoice({ report: "class_fill", from: "2026-10-01", to: "2026-02-01", kind: "goats" }, today, []);
  assert.deepEqual(c3, { report: "class_fill", params: { from: "2026-02-01", to: "2026-10-01", kind: null, collection: null, top: 10 } }, "from after to: swapped");
  assert.equal(checkChoice({ report: "slow_items", from: "1999-01-01" }, today, [])?.report, "slow_items");
  assert.ok((checkChoice({ report: "slow_items", from: "1999-01-01" }, today, []) as { params: { from: string } }).params.from >= "2021-10-01", "at most five years back");
  const red = { names: ["Pat Quill"] };
  const choose = buildAskChoose("Did Pat Quill (555-123-4567, pat@example.com) buy the most Kona?", today, ["Kona Solids"], red);
  assert.equal(choose.feature, "ask_shop");
  assert.equal(choose.cls, "suggest");
  const sentChoose = JSON.stringify(choose);
  assert.ok(!/Pat Quill|555-123|pat@example/.test(sentChoose), "no customer in the question as sent");
  assert.match(sentChoose, /best_sellers/);
  assert.match(sentChoose, /Kona Solids/);
  assert.deepEqual(parseAskChoice('Sure: {"report":"tickets_by_status"}', today, []), { report: "tickets_by_status", params: { from: "2026-01-01", to: today, kind: null, collection: null, top: 25 } });
  const word = buildAskWord("which sold best?", { title: "Best sellers, Jan 1 to Oct 7, 2026", facts: ["1. Kona Navy (K-1): 3 yd sold, $36.00"] }, red);
  assert.match(word.messages[0].content, /Kona Navy \(K-1\): 3 yd sold, \$36\.00/);
  ok("the pick is checked; the requests carry no customer");

  // ===== set-up =====
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const respond = (rec: { system: string; userText: string }) => {
    if (rec.system.startsWith("You pick which")) {
      if (/unicorn/i.test(rec.userText)) return '{"report":"none"}';
      return '```json\n{"report":"best_sellers","from":"2020-01-01","to":"2099-12-31","kind":"fabric","collection":"kona solids","top":5}\n```';
    }
    if (rec.system.startsWith("You answer a shop owner")) {
      const first = /1\. ([^\n]+)/.exec(rec.userText)?.[1] ?? "nothing";
      return `The best seller was ${first}.`;
    }
    return "?";
  };
  const hub = await startAssistantHub(respond);
  try {
    const navy = await db.part.create({ data: { shopId: a.shopId, partNumber: "K-NAVY", description: "Kona Navy", kind: "FABRIC", unit: "yd", qtyOnHand: 10, priceCents: 1200, costCents: 600, collection: "Kona Solids" } });
    const red2 = await db.part.create({ data: { shopId: a.shopId, partNumber: "K-RED", description: "Kona Red", kind: "FABRIC", unit: "yd", qtyOnHand: 4, priceCents: 1200, collection: "Kona Solids" } });
    const grunge = await db.part.create({ data: { shopId: a.shopId, partNumber: "G-1", description: "Grunge Grey", kind: "FABRIC", unit: "yd", qtyOnHand: 4, priceCents: 1400, collection: "Grunge" } });
    const pat = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Quill", phone: "555-123-4567", email: "pat@example.com" } });
    await sale(a.shopId, pat.id, [
      { partId: navy.id, description: "Kona Navy", qty: 3, cents: 1200, unit: "yd" },
      { partId: red2.id, description: "Kona Red", qty: 1, cents: 1200, unit: "yd" },
    ]);
    await sale(a.shopId, null, [{ partId: grunge.id, description: "Grunge Grey", qty: 5, cents: 1400, unit: "yd" }]);
    // Company B sells far more of its own Kona Navy: never in A's answer.
    const navyB = await db.part.create({ data: { shopId: b.shopId, partNumber: "K-NAVY", description: "Kona Navy B-SECRET", kind: "FABRIC", unit: "yd", qtyOnHand: 99, priceCents: 1200, collection: "Kona Solids" } });
    await sale(b.shopId, null, [{ partId: navyB.id, description: "Kona Navy B-SECRET", qty: 50, cents: 1200, unit: "yd" }]);

    // ===== 4. refused before the module =====
    await expectUserError("module off", () => askShop(a.user, "Which fabric sold best?"), /Assistant isn't turned on/);
    assert.equal(hub.calls.length, 0);
    await assistantOn(a.shopId);
    await expectUserError("a tech", () => askShop({ ...a.user, role: "TECH" }, "Which fabric sold best?"), /owner or an admin/);
    await expectUserError("too short", () => askShop(a.user, "?"), /Type a question/);
    assert.equal(hub.calls.length, 0);
    ok("refused: module off, a tech, an empty question (no call made)");

    // ===== 2. end to end =====
    const r = await askShop(a.user, "Which Kona sold best since spring? Pat Quill asked, 555-123-4567");
    assert.equal(hub.calls.length, 2, "two calls: the pick and the words");
    assert.deepEqual(hub.calls.map((c) => [c.body.feature, c.body.model]), [["ask_shop", "suggest"], ["ask_shop", "suggest"]]);
    for (const c of hub.calls) assert.ok(!/Pat Quill|555-123|pat@example|B-SECRET/.test(JSON.stringify(c.body)), "no customer, no other company");
    assert.ok(r.report);
    assert.equal(r.report!.id, "best_sellers");
    assert.deepEqual(r.report!.rows, [["Kona Navy (K-NAVY)", "3 yd", "$36.00"], ["Kona Red (K-RED)", "1 yd", "$12.00"]], "the collection only, the program's own numbers, best first");
    assert.match(String(hub.calls[1].body.messages[0].content), /Kona Navy \(K-NAVY\): 3 yd sold, \$36\.00/, "the model words the program's numbers");
    assert.equal(r.answer, "The best seller was Kona Navy (K-NAVY): 3 yd sold, $36.00.");
    assert.match(r.report!.title, /^Best sellers, .*fabric, "Kona Solids"$/);
    assert.equal(r.report!.href, "/fabric?tab=sells");
    const logged = await db.assistantCall.findMany({ where: { shopId: a.shopId, feature: "ask_shop" } });
    assert.equal(logged.length, 2);
    assert.deepEqual(new Set(r.callIds), new Set(logged.map((l) => l.id)));
    ok("a question: the program's report, worded from its numbers, two calls logged");

    // ===== 3. nothing covers it =====
    const none = await askShop(a.user, "How many unicorns visited?");
    assert.equal(hub.calls.length, 3, "one call only");
    assert.equal(none.answer, CANT_ANSWER);
    assert.equal(none.report, null);
    assert.ok(none.cant && none.cant.length === REPORT_IDS.length);
    ok("no report covers it: one call and the list of what it can answer");

    // ===== 4b. the switch =====
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, askOn: false, offerFirstNames: false, voice: null });
    await expectUserError("switched off", () => askShop(a.user, "Which fabric sold best?"), /switched off/);
    assert.equal(hub.calls.length, 3);
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, askOn: true, offerFirstNames: false, voice: null });
    ok("the Ask your shop switch off: refused, no call");

    // ===== 5. every report runs, A's rows only =====
    const tz = "America/New_York";
    for (const id of REPORT_IDS) {
      const res = await runReport(a.shopId, id, { from: "2026-01-01", to: todayIn(tz), kind: null, collection: null, top: 10 });
      assert.equal(res.id, id);
      assert.ok(Array.isArray(res.rows) && res.rows.every((row) => row.length === res.columns.length || res.columns.length === 0), `${id}: rows match the columns`);
      assert.ok(!JSON.stringify(res).includes("B-SECRET"), `${id}: nothing of company B`);
      assert.ok(!JSON.stringify(res).includes("Pat Quill"), `${id}: no customer`);
    }
    const best = await runReport(a.shopId, "best_sellers", { from: "2026-01-01", to: todayIn(tz), kind: "FABRIC", collection: null, top: 10 });
    assert.equal(best.rows[0][0], "Grunge Grey (G-1)", "all fabric: Grunge's $70 first");
    const slow = await runReport(a.shopId, "slow_items", { from: todayIn(tz), to: todayIn(tz), kind: "FABRIC", collection: null, top: 10 });
    assert.equal(slow.rows.length, 0, "everything sold today: nothing slow since today");
    ok("every report in the registry runs on A's rows only");

    console.log(`ask-your-shop check: ${stepCount()} groups passed`);
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
