// Warranty claims per maker (shop-features-round-2-design.md 9.1, package warranty-claims): a ticket line claimed from
// the maker charges nothing and starts (or joins) the ticket's open claim for the machine's brand, parts and labour
// added up; charged again while not sent; sent, paid in full, paid short, refused, undone; the per-maker summary; the
// books (owed by the maker from the day sent, paid off, the short part written off); a tech can't touch the money;
// tenant.
//   npm run check scripts/checks/warranty-claims.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { ticketTotals } from "@/lib/ticket-math";
import { buildBooks, balanced } from "@/lib/books";
import { DEFAULT_BOOKS } from "@/lib/books-accounts";
import { claimLineFor, claimSums, claimView, claimsFor, fileClaimFor, makerSummary, recordClaimPaymentFor, refuseClaimFor, saveClaimFor, undoClaimStepFor } from "@/lib/warranty-claims";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
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

async function main() {
  assert.deepEqual(claimSums([{ kind: "PART", qty: 2, coveredCents: 1250 }, { kind: "LABOR", qty: 1.5, coveredCents: 9800 }, { kind: "SERVICE", qty: 1, coveredCents: 8900 }]), { partsCents: 2500, laborCents: 14700 + 8900 });
  ok("parts and labour add up from the claimed lines");

  const a = await checkShop({ repair: true });
  const b = await checkShop({ repair: true });
  try {
    await db.shop.update({ where: { id: a.shopId }, data: { taxRatePct: 0 } });
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Wanda Warranty" } });
    const machine = await db.machine.create({ data: { shopId: a.shopId, brand: "Brother", model: "PE800", modelKey: "PE800", serial: "X123", customerId: cust.id } });
    const t = await db.ticket.create({ data: { shopId: a.shopId, number: 501, machineId: machine.id, customerId: cust.id } });
    const part = await db.ticketLine.create({ data: { ticketId: t.id, kind: "PART", description: "Hook assembly", qty: 1, unitPriceCents: 4500 } });
    const labor = await db.ticketLine.create({ data: { ticketId: t.id, kind: "LABOR", description: "Replace hook", qty: 1, unitPriceCents: 9800 } });
    const fee = await db.ticketLine.create({ data: { ticketId: t.id, kind: "FEE", description: "Shipping", qty: 1, unitPriceCents: 1500 } });
    const clean = await db.ticketLine.create({ data: { ticketId: t.id, kind: "SERVICE", description: "Clean and oil", qty: 1, unitPriceCents: 8900 } });

    // 1. Claiming lines.
    assert.match(await claimLineFor(tech(a), part.id, true), /claim #1 to Brother/);
    await claimLineFor(tech(a), labor.id, true);
    await expectError("a fee", () => claimLineFor(a.user, fee.id, true), /Only service, labour and parts/);
    await expectError("twice", () => claimLineFor(a.user, part.id, true), /already on a claim/);
    let lines = await db.ticketLine.findMany({ where: { ticketId: t.id } });
    const tot = ticketTotals(lines, [], 0);
    assert.equal(tot.total, 1500 + 8900, "the customer pays only the fee and the cleaning");
    const [c1] = await claimsFor(a.shopId);
    let v = (await claimView(a.shopId, c1.id))!;
    assert.deepEqual([v.number, v.maker, v.status, v.partsCents, v.laborCents, v.expectedCents, v.lines.length, v.ticket?.number], [1, "Brother", "OPEN", 4500, 9800, 14300, 2, 501]);
    await claimLineFor(a.user, clean.id, true);
    await claimLineFor(a.user, clean.id, false);
    lines = await db.ticketLine.findMany({ where: { ticketId: t.id } });
    assert.equal(lines.find((l) => l.id === clean.id)!.unitPriceCents, 8900, "charged again at its price");
    v = (await claimView(a.shopId, c1.id))!;
    assert.equal(v.expectedCents, 14300, "the expected amount follows the lines while not typed over");
    ok("claimed lines charge nothing and join the ticket's claim to the machine's maker; a fee can't be claimed; charged again");

    // 2. The details and sending.
    await saveClaimFor(tech(a), c1.id, fd({ maker: "Brother", claimNumber: "BR-77", note: "Hook cracked", expected: "1.00" }));
    v = (await claimView(a.shopId, c1.id))!;
    assert.deepEqual([v.claimNumber, v.note, v.expectedCents], ["BR-77", "Hook cracked", 14300], "a tech's typed amount is ignored");
    await saveClaimFor(a.user, c1.id, fd({ maker: "Brother", claimNumber: "BR-77", expected: "130.00" }));
    assert.equal((await claimView(a.shopId, c1.id))!.expectedCents, 13000, "the maker pays labour at its own rate");
    await fileClaimFor(a.user, c1.id, fd({ claimNumber: "BR-77" }));
    await expectError("charge a sent line", () => claimLineFor(a.user, part.id, false), /has been sent/);
    await expectError("change the amount once sent", () => saveClaimFor(a.user, c1.id, fd({ maker: "Brother", expected: "200" })), /stays as sent/);
    assert.match(await claimLineFor(a.user, clean.id, true), /claim #2/, "a sent claim takes no more lines: a new one starts");
    ok("details saved (a tech can't type the money); sent: the lines and amount stay; another line starts a new claim");

    // 3. Settling.
    await expectError("tech records money", () => recordClaimPaymentFor(tech(a), c1.id, fd({ amount: "100" })), /owner or admin/);
    await expectError("pay an unsent claim", async () => {
      const [c2] = await claimsFor(a.shopId, { status: "OPEN" });
      await recordClaimPaymentFor(a.user, c2.id, fd({ amount: "10" }));
    }, /Mark the claim sent first/);
    assert.match(await recordClaimPaymentFor(a.user, c1.id, fd({ amount: "100.00" })), /short by \$30.00/);
    v = (await claimView(a.shopId, c1.id))!;
    assert.deepEqual([v.status, v.receivedCents], ["SHORT", 10000]);
    await undoClaimStepFor(a.user, c1.id);
    assert.equal((await claimView(a.shopId, c1.id))!.status, "FILED");
    await recordClaimPaymentFor(a.user, c1.id, fd({ amount: "130" }));
    assert.equal((await claimView(a.shopId, c1.id))!.status, "PAID");
    const [c2] = await claimsFor(a.shopId, { status: "OPEN" });
    await fileClaimFor(a.user, c2.id, null);
    await refuseClaimFor(a.user, c2.id, fd({ why: "Out of warranty" }));
    v = (await claimView(a.shopId, c2.id))!;
    assert.deepEqual([v.status, v.receivedCents], ["REFUSED", 0]);
    assert.match(v.note ?? "", /Refused: Out of warranty/);
    ok("paid short (the shortfall said), undone, paid in full; refused with the reason");

    // 4. The summary and the books.
    const c3 = await db.warrantyClaim.create({ data: { shopId: a.shopId, number: 3, maker: "Janome", status: "FILED", filedAt: new Date(), expectedCents: 5000 } });
    const sum = await makerSummary(a.shopId);
    const bro = sum.find((m) => m.maker === "Brother")!;
    const jan = sum.find((m) => m.maker === "Janome")!;
    assert.deepEqual([bro.paid, bro.paidCents, bro.refused, bro.refusedCents, bro.owedCents], [1, 13000, 1, 8900, 0]);
    assert.deepEqual([jan.waiting, jan.owedCents], [1, 5000]);
    assert.equal(sum[0].maker, "Janome", "the maker owing most comes first");
    await db.warrantyClaim.update({ where: { id: c3.id }, data: { status: "SHORT", receivedCents: 4000, receivedAt: new Date() } });
    const books = await buildBooks(a.shopId, "America/New_York", new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000), DEFAULT_BOOKS);
    for (const d of books.days) assert.ok(balanced(d), `day ${d.day} balances`);
    const net = (acct: string) => books.days.flatMap((d) => d.lines).filter((l) => l.account === acct).reduce((x, l) => x + l.debitCents - l.creditCents, 0);
    assert.equal(net("Due from Manufacturers"), 0, "everything sent was settled");
    assert.equal(net("Warranty Claims Income"), -(13000 + 4000), "income is what the makers paid");
    ok("by maker: owed, paid, refused, the most owed first; the books balance, the receivable clears, income is what came in");

    // 5. Tenant.
    await expectNotFound("B claims A's line", () => claimLineFor(b.user, part.id, false));
    await expectNotFound("B saves A's claim", () => saveClaimFor(b.user, c1.id, fd({ maker: "x" })));
    await expectNotFound("B files A's claim", () => fileClaimFor(b.user, c2.id, null));
    await expectNotFound("B pays A's claim", () => recordClaimPaymentFor(b.user, c1.id, fd({ amount: "1" })));
    await expectNotFound("B undoes A's claim", () => undoClaimStepFor(b.user, c1.id));
    assert.equal(await claimView(b.shopId, c1.id), null);
    assert.deepEqual(await claimsFor(b.shopId), []);
    assert.deepEqual(await makerSummary(b.shopId), []);
    ok("tenant: B can't claim A's lines nor read, change, send, settle or undo A's claims");
  } finally {
    await cleanup();
  }
  console.log(`warranty-claims.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
