// Round-3 batch A: money and stock records.
//   M56  a partner's consignment return waits for the repair shop's confirmation (nothing restocked until then)
//   L127 removing a ticket payment keeps it and adds a reversing negative payment (balances unchanged)
//   L79  a supplier cost keeps four decimals beside costCents (parts form, import)
//   npm run check scripts/checks/money-records.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { fineCost, lineCostCents, modelKey, moneyCost, costText } from "@/lib/format";
import { costField } from "@/lib/parts";
import { runImport } from "@/lib/inventory-import";
import { answerConsignReturn, answerConsignReturnDetailed, holdConsignReturn } from "@/lib/partners";
import { removePaymentFor } from "@/lib/payments";
import { paymentsBetween } from "@/lib/sales";
import { ticketTotals } from "@/lib/ticket-math";
import { checkShop, cleanup, linkPair } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
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

let n = 9100;
async function ticket(shopId: string) {
  const m = await db.machine.create({ data: { shopId, customerId: null, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
  return db.ticket.create({ data: { shopId, number: n++, status: "ON_BENCH", machineId: m.id, customerId: null, intake: {} } });
}

async function main() {
  const repair = await checkShop({ repair: true });
  const retail = await checkShop({ retail: true });
  const other = await checkShop({ repair: true });
  try {
    // ---------- L127 ----------
    const t = await ticket(repair.shopId);
    const longAgo = new Date(Date.now() - 60 * 86_400_000);
    const p1 = await db.payment.create({ data: { ticketId: t.id, method: "CARD", amountCents: 5000, paidAt: longAgo } });
    const p2 = await db.payment.create({ data: { ticketId: t.id, method: "CASH", amountCents: 1200, paidAt: new Date() } });
    const paid = async () => (await db.payment.findMany({ where: { ticketId: t.id } })).reduce((s, p) => s + p.amountCents, 0);
    assert.equal(await paid(), 6200);

    await expectNotFound("removePaymentFor(other shop)", () => removePaymentFor(other.user, p1.id));
    await expectError("a tech can't remove", () => removePaymentFor({ ...repair.user, role: "TECH" }, p1.id), /owner or an admin/);
    assert.equal(await db.payment.count({ where: { ticketId: t.id } }), 2);

    assert.equal(await removePaymentFor(repair.user, p1.id), t.id);
    const rows = await db.payment.findMany({ where: { ticketId: t.id }, orderBy: { paidAt: "asc" } });
    assert.equal(rows.length, 3, "the original stays");
    assert.ok(rows.some((r) => r.id === p1.id && r.amountCents === 5000));
    const rev = rows.find((r) => r.reversesId === p1.id)!;
    assert.equal(rev.amountCents, -5000);
    assert.equal(rev.method, "CARD");
    assert.ok(Date.now() - rev.paidAt.getTime() < 60_000, "dated today");
    assert.match(rev.note ?? "", /^Removed: the Card payment of \$50\.00/);
    assert.equal(await paid(), 1200, "balance as if it was never taken");
    assert.equal(ticketTotals([], rows, 0).paid, 1200);
    ok("removing a payment keeps it and adds a negative one dated today");

    const march = await paymentsBetween(repair.shopId, new Date(longAgo.getTime() - 86_400_000), new Date(longAgo.getTime() + 86_400_000));
    assert.deepEqual(march.map((x) => x.id), [p1.id], "the day it was taken still shows it");
    ok("the day the payment was taken keeps its sales total");

    await expectError("removed twice", () => removePaymentFor(repair.user, p1.id), /already removed/);
    await expectError("removing the removal", () => removePaymentFor(repair.user, rev.id), /itself a removal/);
    assert.equal(await db.payment.count({ where: { ticketId: t.id } }), 3);
    ok("a payment is removed once, and a removal can't be removed");

    const before = JSON.stringify(await db.payment.findMany({ where: { ticketId: t.id }, orderBy: { id: "asc" } }));
    await expectNotFound("tenant", () => removePaymentFor(other.user, p2.id));
    assert.equal(JSON.stringify(await db.payment.findMany({ where: { ticketId: t.id }, orderBy: { id: "asc" } })), before);
    ok("tenant: another company can't remove this one's payment");

    // ---------- M56 ----------
    const linkId = await linkPair(repair.shopId, retail.shopId);
    const repairLink = { id: linkId, side: "repair", partnerName: "Retail" };
    const part = await db.part.create({ data: { shopId: repair.shopId, partNumber: "CS-1", description: "Spool", numberKeys: ["CS1"], qtyOnHand: 0 } });
    const mk = (itemKey: string, placed: number) =>
      db.consignItem.create({ data: { shopId: repair.shopId, linkId, side: "owner", itemKey, partId: part.id, partNumber: "CS-1", description: "Spool", priceCents: 300, placed } });
    const it = await mk(part.id, 10);
    const qty = async () => (await db.part.findUniqueOrThrow({ where: { id: part.id } })).qtyOnHand;
    const item = () => db.consignItem.findUniqueOrThrow({ where: { id: it.id } });

    await db.$transaction((tx) => holdConsignReturn(repair.shopId, linkId, part.id, 4, new Date(), tx));
    let i = await item();
    assert.equal(i.pendingReturn, 4);
    assert.equal(i.returned, 0);
    assert.equal(await qty(), 0, "nothing on the shelf until confirmed");
    ok("a return claim is held as pending; stock and Returned don't move");

    // 40 claimed with 6 still out there: held at 6, never more than is out there.
    await db.$transaction((tx) => holdConsignReturn(repair.shopId, linkId, part.id, 40, new Date(), tx));
    i = await item();
    assert.equal(i.pendingReturn, 10);
    assert.equal(await db.$transaction((tx) => holdConsignReturn(repair.shopId, linkId, part.id, 5, new Date(), tx)), 0);
    assert.equal(await qty(), 0);
    ok("claims can't add up to more than is on consignment");

    // Another company can't answer this one's claim (its rows are filtered by its own shopId).
    assert.equal(await answerConsignReturn(other.shopId, repairLink, part.id, true, new Date()), 0);
    assert.equal((await item()).pendingReturn, 10);
    assert.equal(await qty(), 0);

    const back = await answerConsignReturn(repair.shopId, repairLink, part.id, true, new Date());
    assert.equal(back, 10);
    i = await item();
    assert.equal(i.returned, 10);
    assert.equal(i.pendingReturn, 0);
    assert.equal(i.pendingAt, null);
    assert.equal(await qty(), 10);
    assert.equal(await db.stockMove.count({ where: { shopId: repair.shopId, partId: part.id, reason: "CONSIGNED", qty: 10 } }), 1);
    assert.equal(await answerConsignReturn(repair.shopId, repairLink, part.id, true, new Date()), 0, "a second confirm does nothing");
    assert.equal(await qty(), 10);
    ok("confirming restocks once");

    const part2 = await db.part.create({ data: { shopId: repair.shopId, partNumber: "CS-2", description: "Needle", numberKeys: ["CS2"], qtyOnHand: 0 } });
    const it2 = await db.consignItem.create({ data: { shopId: repair.shopId, linkId, side: "owner", itemKey: part2.id, partId: part2.id, partNumber: "CS-2", description: "Needle", priceCents: 100, placed: 5 } });
    await db.$transaction((tx) => holdConsignReturn(repair.shopId, linkId, part2.id, 3, new Date(), tx));
    assert.equal(await answerConsignReturn(repair.shopId, repairLink, part2.id, false, new Date()), 3);
    const r2 = await db.consignItem.findUniqueOrThrow({ where: { id: it2.id } });
    assert.equal(r2.pendingReturn, 0);
    assert.equal(r2.returned, 0);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part2.id } })).qtyOnHand, 0);
    ok("Not received drops the claim and restocks nothing");

    // Confirming when the shelf is already empty: the claim is cleared in the same transaction, nothing restocked, no error.
    const part3 = await db.part.create({ data: { shopId: repair.shopId, partNumber: "CS-3", description: "Pin", numberKeys: ["CS3"], qtyOnHand: 0 } });
    const it3 = await db.consignItem.create({ data: { shopId: repair.shopId, linkId, side: "owner", itemKey: part3.id, partId: part3.id, partNumber: "CS-3", description: "Pin", priceCents: 100, placed: 5 } });
    await db.$transaction((tx) => holdConsignReturn(repair.shopId, linkId, part3.id, 3, new Date(), tx));
    await db.consignItem.update({ where: { id: it3.id }, data: { returned: 5 } }); // all taken back some other way meanwhile
    const empty = await answerConsignReturnDetailed(repair.shopId, repairLink, part3.id, true, new Date());
    assert.deepEqual(empty, { claimed: true, qty: 0 });
    const r3 = await db.consignItem.findUniqueOrThrow({ where: { id: it3.id } });
    assert.equal(r3.pendingReturn, 0);
    assert.equal(r3.returned, 5);
    assert.equal((await db.part.findUniqueOrThrow({ where: { id: part3.id } })).qtyOnHand, 0);
    assert.deepEqual(await answerConsignReturnDetailed(repair.shopId, repairLink, part3.id, true, new Date()), { claimed: false, qty: 0 }, "no claim left");
    ok("confirming against an empty shelf clears the claim (claimed, nothing back) and a second try finds no claim");

    // The fine cost: 1000 buttons at $0.004 cost $4, rounded once for the line.
    assert.equal(fineCost(0, 40), 40);
    assert.equal(fineCost(1250, null), 125000);
    assert.equal(fineCost(13, 1250), 1250);
    assert.equal(fineCost(15, 1250), 1500, "a finer figure that no longer agrees with the cents is ignored");
    assert.equal(fineCost(null, null), null);
    assert.equal(lineCostCents(1000, 0, 40), 400);
    assert.equal(lineCostCents(1000, 0, null), 0);
    assert.equal(lineCostCents(2.5, 800, null), 2000);
    ok("stock value and cost of goods use the fine cost, rounded once for the line");

    // ---------- L79 ----------
    assert.deepEqual(costField("0.125", "Cost"), { costCents: 13, costTenThou: 1250 });
    assert.deepEqual(costField("12.50", "Cost"), { costCents: 1250, costTenThou: 125000 });
    assert.equal(costField("", "Cost"), null);
    await expectError("minus", async () => costField("-1", "Cost"), /between \$0/);
    await expectError("ambiguous", async () => costField("1,50", "Cost"), /enter dollars/);
    ok("costField keeps four decimals and the cents it rounds to");

    const res = await runImport(
      repair.shopId,
      repair.user.id,
      [
        { partNumber: "ND-125", description: "Needle", costCents: 13, costTenThou: 1250, priceCents: 50, qty: 8 },
        { partNumber: "ND-CENTS", description: "Thread", costCents: 250, qty: 1 },
      ],
      { kind: "PART", unit: null, supplier: null, addQty: true, updateExisting: true },
    );
    assert.equal(res.added, 2);
    const nd = await db.part.findFirstOrThrow({ where: { shopId: repair.shopId, partNumber: "ND-125" } });
    assert.equal(nd.costCents, 13);
    assert.equal(nd.costTenThou, 1250);
    assert.equal(moneyCost(nd.costCents, nd.costTenThou), "$0.125");
    const th = await db.part.findFirstOrThrow({ where: { shopId: repair.shopId, partNumber: "ND-CENTS" } });
    assert.equal(th.costCents, 250);
    assert.equal(th.costTenThou, null);
    assert.equal(costText(th.costCents, th.costTenThou), "2.50");
    ok("an import keeps a cost finer than a cent; a cents-only row stays cents");

    // Re-importing with a new cost updates both; a row with no cost leaves them alone.
    await runImport(repair.shopId, repair.user.id, [{ partNumber: "ND-125", description: "Needle", costCents: 15, costTenThou: 1475, qty: 0 }, { partNumber: "ND-CENTS", description: "Thread", qty: 0 }], { kind: "PART", unit: null, supplier: null, addQty: false, updateExisting: true });
    const nd2 = await db.part.findUniqueOrThrow({ where: { id: nd.id } });
    assert.deepEqual([nd2.costCents, nd2.costTenThou], [15, 1475]);
    const th2 = await db.part.findUniqueOrThrow({ where: { id: th.id } });
    assert.deepEqual([th2.costCents, th2.costTenThou], [250, null]);
    ok("updating by import changes both figures together");
  } finally {
    await cleanup();
  }
  console.log(`money-records.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
