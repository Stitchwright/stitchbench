// The pickup sheet and words on fabric insight (shop-features-round-2-design.md 5.5, package
// pickup-sheet-and-insight-words):
//   1. the requests and their checks (pure): the ticket without its customer, the shop's tips numbered, a tip number not
//      offered dropped (three at most); insight cards from the program's numbers, a sentence for a card not offered dropped
//   2. care tips: starters with one tap, a tip of her own, remove with undo; a tech and another company refused
//   3. the sheet saved on a ticket: the tips ticked are the shop's own for the machine's kind, kept as printed;
//      another company's ticket: not found
//   4. Draft the pickup sheet through the stand-in hub (draft_pickup): the work and the tips go, the customer doesn't;
//      the answer's tips mapped to the shop's own; refused with nothing to write from or the drafts switched off
//   5. Say it in words on What sells (explain_insight): one sentence per card, from the cards' numbers
//   npm run -s check scripts/checks/pickup-sheet.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { saveSettings } from "@/lib/assistant/bodies";
import { buildInsightWords, insightCards, parseInsightWords } from "@/lib/assistant/insight-words";
import { draftPickup, explainInsight } from "@/lib/assistant/pickup";
import { buildPickupSheet, parsePickupSheet } from "@/lib/assistant/pickup-prompt";
import { addCareTipFor, addStartersFor, careTipsFor, removeCareTipFor, restoreCareTipFor, savePickupSheetFor } from "@/lib/care-tips";
import { STARTER_TIPS } from "@/lib/care-tips-starters";
import type { Insight } from "@/lib/fabric-insight";
import { INSIGHT_DEFAULTS } from "@/lib/fabric-insight-math";
import { assistantOn, expectUserError, ok, startAssistantHub, stepCount } from "./assistant-hub";
import { checkShop, cleanup } from "./lib";

const DAY = 86_400_000;
const at = (ago: number) => new Date(Date.now() - ago * DAY);

async function main() {
  // ===== 1. pure =====
  const facts = {
    number: 12,
    noun: "sewing machine",
    brand: "Janome",
    model: "MC6700P",
    machineType: null,
    serviceRequested: null,
    problem: null,
    diagnosis: "Timing off",
    workDone: "retimed hook, COA, called Pat Quill",
    notes: "SECRET-NOTE",
    accessories: [],
    lines: [{ kind: "LABOR", description: "Clean and oil", qty: 1, unitPriceCents: 8900 }],
  };
  const b1 = buildPickupSheet(facts, [{ n: 1, text: "Change the needle every 8 hours of sewing." }], { shopName: "Quill Sew", sample: null }, { names: ["Pat Quill"] });
  assert.deepEqual([b1.feature, b1.cls], ["draft_pickup", "draft"]);
  const s1 = JSON.stringify(b1);
  assert.match(s1, /retimed hook/);
  assert.match(s1, /1\. Change the needle every 8 hours/);
  assert.ok(!/Pat Quill|SECRET-NOTE/.test(s1), "no customer, no internal notes");
  assert.deepEqual(parsePickupSheet('{"whatWeDid":"We **cleaned** it.","tips":[1,7,1,2,3,4]}', [1, 2, 3, 4]), { what: "We cleaned it.", tips: [1, 2, 3] });
  assert.deepEqual(parsePickupSheet('{"whatWeDid":"x","tips":[9]}', [1]), { what: "x", tips: [] });
  assert.equal(parsePickupSheet('{"tips":[1]}', [1]), null);
  const fake = {
    settings: { ...INSIGHT_DEFAULTS },
    groups: {
      collection: [
        { name: "Kona", items: 4, qty: 40, perWeek: 6.2, perItem: 1.5, weeks: 6.5, margin: 120000 },
        { name: "Holiday", items: 12, qty: 84, perWeek: 0, perItem: 0, weeks: null, margin: 0 },
      ],
      color: [{ name: "navy", items: 3, qty: 20, perWeek: 2, perItem: 0.7, weeks: 10, margin: 3000 }],
      maker: [],
      designer: [],
      band: [],
    },
    slow: [],
  } as unknown as Pick<Insight, "groups" | "slow" | "settings">;
  const cards = insightCards(fake, "sells");
  assert.deepEqual(
    cards.map((c) => [c.ref, c.title]),
    [
      ["c1", "Kona"],
      ["c2", "Color: navy"],
      ["c3", "Holiday (slow)"],
    ],
  );
  assert.match(cards[2].facts, /12 fabrics, 84 yd on hand, nothing sold/);
  assert.equal(insightCards(fake, "slow").length, 0);
  const bw = buildInsightWords(cards, { shopName: "Quill", sample: null });
  assert.deepEqual([bw.feature, bw.cls], ["explain_insight", "draft"]);
  assert.match(bw.messages[0].content, /\[c3\] Collection Holiday/);
  assert.deepEqual(parseInsightWords('{"lines":[{"ref":"c1","text":"Kona sells fast."},{"ref":"c9","text":"made up"},{"ref":"c1","text":"again"}]}', cards), { c1: "Kona sells fast." });
  ok("the requests and their checks: no customer, only the shop's tips, only the cards offered");

  // ===== 2. care tips =====
  const a = await checkShop({ retail: true, repair: true });
  const b = await checkShop({ retail: true, repair: true });
  const tech = { ...a.user, role: "TECH" as const };
  await expectUserError("tech", () => addStartersFor(tech, "sewing"), /owner or an admin/);
  assert.equal(await addStartersFor(a.user, "sewing"), STARTER_TIPS.sewing.length);
  await expectUserError("starters twice", () => addStartersFor(a.user, "sewing"), /already has tips/);
  await addCareTipFor(a.user, "sewing", "  Keep  the foot pedal off the carpet.  ");
  await expectUserError("too short", () => addCareTipFor(a.user, "sewing", "no"), /in a sentence/);
  let tips = await careTipsFor(a.shopId, "sewing");
  assert.equal(tips.at(-1)!.text, "Keep the foot pedal off the carpet.");
  await expectUserError("another company's tip", () => removeCareTipFor(b.user, tips[0].id), /not found/);
  const undo = await removeCareTipFor(a.user, tips[0].id);
  assert.equal((await careTipsFor(a.shopId, "sewing")).length, tips.length - 1);
  await restoreCareTipFor(a.user, undo);
  tips = await careTipsFor(a.shopId, "sewing");
  assert.equal(tips[0].text, STARTER_TIPS.sewing[0], "Undo puts it back in its place");
  ok("care tips: starters, her own, remove and undo; a tech and another company refused");

  // ===== 3. the sheet saved =====
  const machine = await db.machine.create({ data: { shopId: a.shopId, brand: "Janome", model: "MC6700P", modelKey: "MC6700P", kind: "sewing" } });
  const pat = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Quill", phone: "555-123-4567" } });
  const ticket = await db.ticket.create({ data: { shopId: a.shopId, number: 12, machineId: machine.id, customerId: pat.id, status: "READY_FOR_PICKUP", diagnosis: "Timing off", workDone: "retimed hook, COA, call Pat Quill", notes: "SECRET-NOTE", lines: { create: [{ kind: "LABOR", description: "Clean and oil", qty: 1, unitPriceCents: 8900 }] } } });
  await savePickupSheetFor(a.user, ticket.id, { what: " We cleaned and oiled it. ", tipIds: [tips[1].id, tips[0].id] });
  const saved = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id }, select: { pickupWhat: true, pickupTips: true } });
  assert.deepEqual(saved, { pickupWhat: "We cleaned and oiled it.", pickupTips: [tips[0].text, tips[1].text] }, "kept as printed, in the list's order");
  await addStartersFor(a.user, "vacuum");
  const vacTip = (await careTipsFor(a.shopId, "vacuum"))[0];
  await expectUserError("a vacuum tip on a sewing machine", () => savePickupSheetFor(a.user, ticket.id, { what: "x", tipIds: [vacTip.id] }), /isn't on your list/);
  await expectUserError("another company's ticket", () => savePickupSheetFor(b.user, ticket.id, { what: "x", tipIds: [] }), /not found/);
  ok("the sheet saved: the shop's own tips for the kind, as printed; another company's ticket not found");

  // ===== 4. Draft the pickup sheet =====
  const hub = await startAssistantHub((rec) => {
    if (rec.system.includes("sheet a customer takes home")) return '```json\n{"whatWeDid":"We cleaned, oiled and retimed your machine.","tips":[2,1,99]}\n```';
    if (rec.system.startsWith("You turn a fabric shop's own numbers")) {
      const refs = [...rec.userText.matchAll(/\[(c\d+)\]/g)].map((m) => m[1]);
      return JSON.stringify({ lines: refs.map((ref) => ({ ref, text: `Sentence for ${ref}.` })) });
    }
    return "?";
  });
  try {
    await expectUserError("module off", () => draftPickup(a.user, ticket.id), /Assistant isn't turned on/);
    await assistantOn(a.shopId);
    const d = await draftPickup(a.user, ticket.id);
    assert.equal(d.what, "We cleaned, oiled and retimed your machine.");
    assert.deepEqual(d.tipIds, [tips[1].id, tips[0].id], "numbers mapped to the shop's own tips; 99 dropped");
    const sent = hub.lastSent();
    assert.equal(hub.calls.at(-1)!.body.feature, "draft_pickup");
    assert.match(sent, /retimed hook/);
    assert.match(sent, /2\. Brush the lint out/);
    assert.ok(!/Pat Quill|555-123|SECRET-NOTE/.test(sent), "no customer, no internal notes");
    assert.ok(!sent.includes("Run the vacuum") && !sent.includes(vacTip.text), "only the kind's tips");
    const empty = await db.ticket.create({ data: { shopId: a.shopId, number: 13, machineId: machine.id, status: "READY_FOR_PICKUP" } });
    const k = hub.calls.length;
    await expectUserError("nothing to write from", () => draftPickup(a.user, empty.id), /work done/);
    await expectUserError("another company's ticket", () => draftPickup(b.user, ticket.id), /Assistant isn't turned on|not found/);
    await saveSettings(a.user, { draftOn: false, causesOn: true, plateOn: true, offerFirstNames: false, voice: null });
    await expectUserError("drafts off", () => draftPickup(a.user, ticket.id), /switched off/);
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, offerFirstNames: false, voice: null });
    assert.equal(hub.calls.length, k, "no call for a refusal");
    ok("Draft the pickup sheet: the work and the kind's tips, never the customer; the tips mapped; refusals make no call");

    // ===== 5. Say it in words =====
    const p = await db.part.create({ data: { shopId: a.shopId, partNumber: "K-1", numberKeys: ["K1"], description: "Kona Navy", kind: "FABRIC", unit: "yd", qtyOnHand: 20, priceCents: 1400, costCents: 700, collection: "Kona", colorTags: ["navy"], createdAt: at(60) } });
    await db.stockMove.create({ data: { shopId: a.shopId, partId: p.id, qty: 40, reason: "RECEIVED", createdAt: at(60) } });
    for (const ago of [40, 25, 10]) {
      await db.sale.create({ data: { shopId: a.shopId, number: 1000 + ago, subtotalCents: 1400 * 6, taxCents: 0, totalCents: 1400 * 6, taxRatePct: 0, createdAt: at(ago), lines: { create: { partId: p.id, description: "Kona Navy", qty: 6, unit: "yd", unitPriceCents: 1400, costCents: 700 } } } });
      await db.stockMove.create({ data: { shopId: a.shopId, partId: p.id, qty: -6, reason: "SOLD", createdAt: at(ago) } });
    }
    const w = await explainInsight(a.user, "sells");
    assert.ok(w.cards.length >= 1, "the program made cards from its numbers");
    assert.equal(w.cards[0].title, "Kona");
    assert.equal(w.words.c1, "Sentence for c1.");
    assert.equal(hub.calls.at(-1)!.body.feature, "explain_insight");
    await expectUserError("nothing slow yet", () => explainInsight(a.user, "slow"), /isn't enough to say/);
    ok("Say it in words: a sentence per card the program made");

    console.log(`pickup-sheet check: ${stepCount()} groups passed`);
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
