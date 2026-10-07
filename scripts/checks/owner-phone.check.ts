// The owner's phone and notes between stores (shop-features-round-2-design.md 7.5, 7.7): each store's day (taken by
// payment, sales, repairs waiting and ready, low stock, who's on shift now, approvals waiting, to ship, between stores);
// the daily summary email at each store's closing time, once a day, only with more than one store and the summary on;
// approvals waiting for the owner; the owner's email when the register asks; notes to one store or all, read ticks,
// pins, taken down; and the tenant section.
//   npm run -s check scripts/checks/owner-phone.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { completeSaleAs } from "@/lib/register-sale";
import { addStoreFor } from "@/lib/stores-admin";
import { activeStores } from "@/lib/stores";
import { moveStock } from "@/lib/stock";
import { dailySummaries, storeDay, summaryText } from "@/lib/owner-today";
import { askOwnerFor, waitingApprovals } from "@/lib/approvals";
import { markNotesReadFor, notesFor, pinNoteFor, postNoteFor, removeNoteFor, unreadNotes } from "@/lib/store-notes";
import { askStockFor } from "@/lib/transfers";
import { todayIn } from "@/lib/time-zone";
import { checkShop, cleanup, messagingFor, withSink } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

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

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

async function main() {
  await withSink();
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    const A = a.shopId;
    await messagingFor(A, { email: true });
    await db.user.update({ where: { id: a.user.id }, data: { email: `owner-${Date.now()}@example.test` } });
    const owner = { ...a.user, email: (await db.user.findUniqueOrThrow({ where: { id: a.user.id } })).email };

    // ---------- 1. one store: no notes board, no daily summary ----------
    await expectError("a note with one store", () => postNoteFor(owner, { to: "all", text: "Hello" }), /second store/);
    assert.equal(await dailySummaries(new Date(), [A]), 0, "one store: no daily summary");
    ok("one store: no notes between stores and no daily summary");

    const fl = await addStoreFor(owner, form({ name: "Florida", mainName: "Boston", taxRatePct: "0" }));
    const main = (await activeStores(A)).find((s) => s.main)!;
    await db.shop.update({ where: { id: A }, data: { taxRatePct: 0 } });
    const atFl: CurrentUser = { ...owner, locationId: fl.id };
    const atMain: CurrentUser = { ...owner, locationId: main.id };
    const part = await db.part.create({ data: { shopId: A, partNumber: "OP-1", description: "Thread snips", priceCents: 1500, kind: "NOTION", numberKeys: ["OP1"], reorderAt: 3 } });
    await db.$transaction((tx) => moveStock(tx, { shopId: A, partId: part.id, locationId: fl.id, qty: 4, reason: "RECEIVED" }));

    // ---------- 2. a store's day ----------
    await completeSaleAs(atFl, { lines: [{ partId: part.id, description: "Thread snips", qty: 2, unitPriceCents: 1500, taxable: true }], tenders: [{ method: "CASH", amountCents: 1000 }, { method: "CARD", amountCents: 2000 }] });
    const now = new Date();
    const tech = await db.user.create({ data: { shopId: A, email: `op-tech-${Date.now()}@stitchbench.test`, name: "Tess", role: "TECH", passwordHash: "x", locationId: fl.id } });
    await db.shift.create({ data: { shopId: A, locationId: fl.id, userId: tech.id, name: "Tess", startsAt: new Date(now.getTime() - 3_600_000), endsAt: new Date(now.getTime() + 3_600_000) } });
    await askOwnerFor({ ...owner, id: tech.id, name: "Tess", role: "TECH", locationId: fl.id }, fl, { kind: "REFUND", amountCents: 30000, pct: null }, "Broken in the box", {});
    await askStockFor(atMain, { fromId: fl.id, lines: [{ partId: part.id, qty: 1 }] });
    // Florida's own reorder point (the main store's is the item's own field).
    await db.stockLevel.update({ where: { partId_locationId: { partId: part.id, locationId: fl.id } }, data: { reorderAt: 3 } });
    const d = await storeDay(A, fl, now);
    assert.equal(d.takenCents, 3000);
    assert.deepEqual(d.tenders.map((t) => t.cents).sort((x, y) => x - y), [1000, 2000]);
    assert.equal(d.sales, 1);
    assert.deepEqual(d.onShift.map((s) => s.name), ["Tess"]);
    assert.equal(d.lowCount, 1, "2 left at Florida, its reorder point 3");
    assert.equal(d.approvals, 1);
    assert.equal(d.askedOfUs, 1);
    const dm = await storeDay(A, main, now);
    assert.equal(dm.takenCents, 0, "Boston took nothing");
    assert.equal(dm.onShift.length, 0);
    ok("Florida's day: $30 taken (cash and card), 1 sale, Tess on shift, 1 low, 1 approval waiting, 1 request asked of it; Boston's apart");
    assert.equal(dm.lowCount, 1, "Boston has none and the item's own point is 3: low there too");

    // ---------- 3. approvals waiting for the owner ----------
    const waiting = await waitingApprovals(A);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].askedBy, "Tess");
    assert.match(waiting[0].words, /refund of \$300\.00/);
    const mail = await db.outMessage.findFirst({ where: { shopId: A, kind: "owner_notice", refType: "approval" } });
    assert.ok(mail && /Tess at Florida asks you to approve a refund of \$300\.00/.test(mail.body) && mail.address === owner.email, "the owner is emailed with the link");
    ok("an approval asked: on the owner's Today list (who, what, why) and emailed to her");

    // ---------- 4. the daily summary ----------
    await db.location.updateMany({ where: { shopId: A }, data: { dailyAt: "00:00" } });
    const n1 = await dailySummaries(now, [A]);
    assert.equal(n1, 2, "one email per store (two stores, one owner)");
    assert.equal(await dailySummaries(now, [A]), 0, "never twice a day");
    const sum = await db.outMessage.findFirstOrThrow({ where: { shopId: A, kind: "owner_notice", refType: "owner_daily", refId: fl.id } });
    assert.match(sum.subject ?? "", /Florida's day \(\$30\.00 taken\)/);
    assert.match(sum.body, /Worked today: Tess/);
    await db.location.updateMany({ where: { shopId: A }, data: { dailySentOn: null, dailyAt: "23:59" } });
    const late = new Date(`${todayIn(main.timeZone)}T12:00:00Z`);
    assert.equal(await dailySummaries(late, [A]), 0, "not before the closing time");
    await db.shop.update({ where: { id: A }, data: { dailySummaryOn: false } });
    await db.location.updateMany({ where: { shopId: A }, data: { dailyAt: "00:00" } });
    assert.equal(await dailySummaries(now, [A]), 0, "the owner turned it off");
    assert.match(summaryText(d, "Check").body, /Repairs waiting: \d+; ready for pickup: \d+/);
    ok("the daily summary: one email a store after its closing time, once a day; none before it or when turned off");

    // ---------- 5. notes between stores ----------
    const techUser: CurrentUser = { ...owner, id: tech.id, name: "Tess", role: "TECH", locationId: fl.id };
    const n = await postNoteFor(atMain, { to: fl.id, text: "  The Bernina rep visits Thursday  ", pinned: true });
    const all = await postNoteFor(techUser, { to: "all", text: "Closed Monday for inventory", pinned: true });
    await expectError("empty", () => postNoteFor(atMain, { to: "all", text: " " }), /Type the note/);
    await expectError("no such store", () => postNoteFor(atMain, { to: "nope", text: "x" }), /Store not found/);
    const board = await notesFor(techUser, fl.id);
    assert.deepEqual(board.map((x) => x.text), ["The Bernina rep visits Thursday", "Closed Monday for inventory"], "pinned first");
    assert.equal(board[0].from, owner.name);
    assert.equal(board[0].fromStore, "Boston");
    assert.equal(board[1].pinned, false, "a tech's note isn't pinned");
    assert.equal(await unreadNotes(techUser, fl.id), 1, "her own note counts as read");
    await markNotesReadFor(techUser, [n, all]);
    assert.equal(await unreadNotes(techUser, fl.id), 0);
    assert.deepEqual((await notesFor(atMain, null)).find((x) => x.id === n)?.readBy, ["Tess"], "the read tick shows who read it");
    await expectError("a tech pins", () => pinNoteFor(techUser, n, false), /Only the owner/);
    await pinNoteFor(atMain, n, false);
    await expectError("a tech takes down another's", () => removeNoteFor(techUser, n), /Only the writer/);
    await removeNoteFor(techUser, all);
    assert.deepEqual((await notesFor(atMain, null)).map((x) => x.id), [n]);
    ok("notes: to Florida (pinned first) and to all; read ticks; owners pin; the writer takes hers down");

    // ---------- 6. tenant ----------
    const snap = await snapshot(A, ["StoreNote", "Approval", "Location"]);
    const B = b.user;
    await expectNotFound("B pins A's note", () => pinNoteFor(B, n, true));
    await expectNotFound("B removes A's note", () => removeNoteFor(B, n));
    await markNotesReadFor(B, [n]);
    assert.deepEqual(await notesFor(B, null), []);
    assert.deepEqual(await waitingApprovals(b.shopId), []);
    await expectNotFound("B's day of A's store", async () => ((await storeDay(b.shopId, fl, now)).takenCents === 0 ? null : "leak"));
    assertUnchanged("company A", snap, await snapshot(A, ["StoreNote", "Approval", "Location"]));
    ok("tenant: B can't pin, take down, read or list A's notes or approvals, and A's store's day shows B nothing");

    console.log(`owner-phone.check: ${steps} groups passed`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
