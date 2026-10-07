// The trade-in helper (shop-features-round-2-design.md 5.4, package trade-in-helper):
//   1. the note's request (pure): a read-class call with the photos counted, no price asked; the answer cleaned
//   2. the expected price from the program: this company's used and refurbished units of the model that sold (what the
//      buyer paid, how long they took), else the brand and kind; the rule (less 30%) to the dollar; new units, unsold
//      units and another company's sales never count
//   3. Draft a condition note through the stand-in hub: the picture as the image, trade_in_note (read); refused with the
//      module off or "Read the plate" switched off (no call)
//   4. a trade-in rung up with its note: kept on the machine for sale; not on the receipt's notes
//   npm run -s check scripts/checks/trade-in-helper.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { saveSettings } from "@/lib/assistant/bodies";
import { tradeInNote } from "@/lib/assistant/trade-in";
import { buildTradeInNote, cleanNote } from "@/lib/assistant/trade-in-prompt";
import { completeSaleAs } from "@/lib/register-sale";
import { tradeInEstimate } from "@/lib/units/trade-in-value";
import { assistantOn, expectUserError, ok, PHOTO, startAssistantHub, stepCount } from "./assistant-hub";
import { checkShop, cleanup } from "./lib";

const DAY = 86_400_000;

async function main() {
  // ===== 1. pure =====
  const built = buildTradeInNote({ noun: "sewing machine", brand: "Janome", model: "MC6700P", photos: 3 });
  assert.deepEqual([built.feature, built.cls], ["trade_in_note", "read"]);
  assert.match(built.messages[0].content, /A used sewing machine \(Janome MC6700P\) traded in: 3 photos side by side/);
  assert.match(built.system, /Never give a price/);
  assert.equal(cleanNote('"**Light scratches** on the bed;\n bobbin cover missing."'), "Light scratches on the bed; bobbin cover missing.");
  ok("the note's request: read class, the photos counted, never a price; the answer cleaned");

  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const hub = await startAssistantHub((rec) => (rec.system.startsWith("You look at photos of a used machine") ? "Light scratches on the bed, bobbin cover missing." : "?"));
  try {
    // ===== 2. the expected price =====
    const now = Date.now();
    let n = 0;
    const unit = async (shopId: string, brand: string, model: string, o: { condition?: string; sold?: number | null; days?: number; kind?: string }) => {
      n += 1;
      const m = await db.machine.create({ data: { shopId, brand, model, modelKey: model.toUpperCase().replace(/[^A-Z0-9]/g, ""), kind: o.kind ?? "sewing", serial: `S${n}` } });
      const created = new Date(now - (o.days ?? 10) * DAY - 5 * DAY);
      return db.stockUnit.create({
        data: { shopId, machineId: m.id, condition: o.condition ?? "USED", status: o.sold != null ? "SOLD" : "IN_STOCK", createdAt: created, soldAt: o.sold != null ? new Date(created.getTime() + (o.days ?? 10) * DAY) : null, soldNetCents: o.sold ?? null, priceCents: 99_900 },
      });
    };
    await unit(a.shopId, "Janome", "MC6700P", { sold: 60_000, days: 20 });
    await unit(a.shopId, "Janome", "MC6700P", { sold: 70_000, days: 40 });
    await unit(a.shopId, "Janome", "MC6700P", { condition: "REFURB", sold: 50_000, days: 10 });
    await unit(a.shopId, "Janome", "MC6700P", { condition: "NEW", sold: 200_000, days: 5 });
    await unit(a.shopId, "Janome", "MC6700P", { sold: null });
    await unit(a.shopId, "Janome", "MC6700P", { kind: "vacuum", sold: 1_000 });
    await unit(b.shopId, "Janome", "MC6700P", { sold: 999_900, days: 1 });
    const e1 = await tradeInEstimate(a.shopId, { kind: "sewing", brand: "Janome", model: "mc-6700p" });
    assert.deepEqual(e1, { basis: "model", count: 3, medianCents: 60_000, lowCents: 50_000, highCents: 70_000, medianDays: 20, lessPct: 30, startCents: 42_000 });
    const e2 = await tradeInEstimate(a.shopId, { kind: "sewing", brand: "janome", model: "HD3000" });
    assert.equal(e2.basis, "brand", "no sale of the model: the brand and kind");
    assert.equal(e2.count, 3);
    const e3 = await tradeInEstimate(a.shopId, { kind: "sewing", brand: "Singer", model: "4423" });
    assert.deepEqual([e3.basis, e3.startCents], [null, null]);
    const eb = await tradeInEstimate(b.shopId, { kind: "sewing", brand: "Janome", model: "MC6700P" });
    assert.equal(eb.medianCents, 999_900, "each company's own sales");
    // The shop's own rule (Shop.tradeInLessPct, Settings -> Selling, phase 1's trade-up) sets the percent.
    await db.shop.update({ where: { id: a.shopId }, data: { tradeInLessPct: 40 } });
    const e4 = await tradeInEstimate(a.shopId, { kind: "sewing", brand: "Janome", model: "MC6700P" });
    assert.deepEqual([e4.lessPct, e4.startCents], [40, 36_000], "less the shop's 40%");
    await db.shop.update({ where: { id: a.shopId }, data: { tradeInLessPct: 30 } });
    ok("the expected price: used and refurbished sales of the model (else the brand), the days, less the shop's percent (30 by default); this company's only");

    // ===== 3. the note =====
    const photo = { mediaType: "image/jpeg" as const, data: PHOTO };
    await expectUserError("module off", () => tradeInNote(a.user, { photo, photos: 2, kind: "sewing", brand: "Janome", model: "MC6700P" }), /Assistant isn't turned on/);
    await assistantOn(a.shopId);
    const note = await tradeInNote(a.user, { photo, photos: 2, kind: "sewing", brand: "Janome", model: "MC6700P" });
    assert.equal(note, "Light scratches on the bed, bobbin cover missing.");
    const call = hub.calls.at(-1)!;
    assert.deepEqual([call.body.feature, call.body.model, call.body.image?.data === PHOTO], ["trade_in_note", "read", true]);
    assert.match(call.body.messages[0].content, /2 photos side by side/);
    const k = hub.calls.length;
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: false, offerFirstNames: false, voice: null });
    await expectUserError("switched off", () => tradeInNote(a.user, { photo, photos: 2, kind: "sewing", brand: "Janome", model: "MC6700P" }), /switched off/);
    assert.equal(hub.calls.length, k);
    ok("Draft a condition note: the picture through the hub as trade_in_note; refused when off, no call");

    // ===== 4. rung up with its note =====
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Trader" } });
    const sale = await completeSaleAs(a.user, {
      customerId: cust.id,
      lines: [{ description: "", qty: -1, unitPriceCents: 42_000, taxable: false, tradeIn: { kind: "sewing", brand: "Janome", model: "MC6700P", serial: "TI-1", machineType: null, condition: "USED", bagged: null, bagType: null, note: "  Light scratches   on the bed  " } }],
      tenders: [{ method: "CASH", amountCents: -42_000 }],
    });
    const traded = await db.stockUnit.findFirstOrThrow({ where: { shopId: a.shopId, machine: { serial: "TI-1" } } });
    assert.equal(traded.note, "Light scratches on the bed");
    assert.equal(traded.costCents, 42_000);
    const lines = await db.saleLine.findMany({ where: { saleId: sale.saleId } });
    assert.ok(!lines.some((l) => /scratches/.test(l.description)), "the note isn't on the receipt's lines");
    ok("a trade-in rung up keeps its note on the machine for sale, not on the receipt");

    console.log(`trade-in-helper check: ${stepCount()} groups passed`);
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
