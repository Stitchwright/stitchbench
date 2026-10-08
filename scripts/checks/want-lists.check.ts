// Want lists (shop-features-round-2-design.md 1.4): the words rule; adding a line (an item, or words; an item on the
// shelf is "Here now" at once; refusals); an item received by hand, a new item and a supplier's list matching words;
// "4 customers want this"; "Let her know" (the order_in message, once; refused with messages off or no way to reach
// her); Done; the to-do count; the tenant section.
//   npm run -s check scripts/checks/want-lists.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { afterArrival } from "@/lib/arrivals";
import { addWantFor, doneWantFor, matchWantsFor, matchWantsSince, tellWantFor, wantersOf, wantsFor, wantsHereUntold, wantWords, wordsMatch } from "@/lib/want-lists";
import { checkShop, cleanup, clearKick, messagingFor, withSink } from "./lib";
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

const part = (shopId: string, n: string, o: Partial<{ description: string; designer: string; collection: string; qtyOnHand: number }> = {}) =>
  db.part.create({ data: { shopId, partNumber: n, numberKeys: [n.replace(/[^A-Z0-9]/gi, "").toUpperCase()], description: o.description ?? n, designer: o.designer ?? null, collection: o.collection ?? null, qtyOnHand: o.qtyOnHand ?? 0, priceCents: 1200, kind: "FABRIC", unit: "yd" } });

async function main() {
  await withSink();
  // A base shop (no Marketing): "it's here" (order_in) is in the base since 7 Oct 2026.
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    await messagingFor(a.shopId, { email: true });
    const jane = await db.customer.create({ data: { shopId: a.shopId, name: "Jane Wants", email: "jane.w@example.test", notifyBy: "email" } });
    const ann = await db.customer.create({ data: { shopId: a.shopId, name: "Ann Quiet", notifyBy: "none" } });

    // 1. The words rule (pure).
    assert.deepEqual(wantWords("Tula Pink!  a"), ["tula", "pink"]);
    const tp = { partNumber: "FS-1", description: "Untamed charm pack", brand: "FreeSpirit", collection: "Untamed", designer: "Tula Pink", colorName: null, onlineTitle: null };
    assert.ok(wordsMatch(["tula", "pink"], tp) && wordsMatch(["untamed"], tp) && !wordsMatch(["kaffe"], tp) && !wordsMatch(["pin"], { ...tp, designer: null, description: "Spinner" }));
    ok("words: lower case, two letters or more; every word must start a word of the item's names (\"pin\" isn't \"spinner\")");

    // 2. Adding.
    const shelf = await part(a.shopId, "AUR-2024", { description: "Aurifil 50wt white", qtyOnHand: 3 });
    const later = await part(a.shopId, "KF-OLD", { description: "Kaffe Fassett Millefiore", qtyOnHand: 0 });
    await expectError("nothing typed", () => addWantFor(a.user, { customerId: jane.id, words: " a " }), /Say what she wants/);
    assert.match(await addWantFor(a.user, { customerId: jane.id, partId: shelf.id }), /on the shelf now/);
    assert.match(await addWantFor(a.user, { customerId: jane.id, words: "Tula Pink", note: "Any line" }), /Here now/);
    await addWantFor(a.user, { customerId: ann.id, partId: later.id });
    await addWantFor(a.user, { customerId: ann.id, words: "tula pink" });
    let list = await wantsFor(a.shopId, { customerId: jane.id });
    assert.equal(list.length, 2);
    assert.equal(list[0].here?.partId, shelf.id, "an item on the shelf is here now at once, first");
    ok("added: an item (on the shelf now: Here now at once) and words; nothing typed is refused");

    // 3. Matching: received by hand, a new item, a supplier's list.
    await db.part.update({ where: { id: later.id }, data: { qtyOnHand: 2 } });
    assert.match(await afterArrival(a.user, [{ partId: later.id, qty: 2 }]), /1 want list line matches/);
    const since = new Date(Date.now() - 1000);
    const fresh = await part(a.shopId, "FS-UNT-1", { description: "Untamed charm pack", designer: "Tula Pink", collection: "Untamed" });
    assert.equal(await matchWantsSince(a.shopId, since), 2, "both Tula Pink lines match the new item");
    assert.equal(await matchWantsFor(a.shopId, [fresh.id]), 0, "already here: not matched twice");
    const wanters = await wantersOf(a.shopId, fresh.id);
    assert.deepEqual(wanters.map((w) => w.name).sort(), ["Ann Quiet", "Jane Wants"]);
    assert.equal(await wantsHereUntold(a.shopId), 4);
    ok("received stock, a new item and a supplier's list all match; \"2 customers want this\"; nothing matched twice");

    // 4. Let her know; Done.
    list = await wantsFor(a.shopId, { customerId: jane.id });
    const tula = list.find((w) => w.words === "Tula Pink")!;
    assert.match(await tellWantFor(a.user, tula.id), /Jane will hear/);
    const msg = await db.outMessage.findFirstOrThrow({ where: { shopId: a.shopId, kind: "order_in", refType: "want", refId: tula.id } });
    assert.match(msg.body, /Untamed charm pack is here/);
    assert.doesNotMatch(msg.body, /holding it for you/);
    assert.match(await tellWantFor(a.user, tula.id), /told about this one already/);
    const annLine = (await wantsFor(a.shopId, { customerId: ann.id }))[0];
    await expectError("no way to reach her", () => tellWantFor(a.user, annLine.id), /Call her instead/);
    await doneWantFor(a.user, annLine.id);
    assert.equal((await wantsFor(a.shopId, { customerId: ann.id })).length, 1);
    await expectError("done twice", () => doneWantFor(a.user, annLine.id), /not found/);
    ok("Let her know queues the message once; refused when she takes no messages; Done takes a line off");

    // 5. Tenant.
    await expectNotFound("B adds to A's customer", () => addWantFor(b.user, { customerId: jane.id, words: "Tula" }));
    await expectNotFound("B tells A's line", () => tellWantFor(b.user, tula.id));
    await expectNotFound("B finishes A's line", () => doneWantFor(b.user, tula.id));
    assert.deepEqual(await wantsFor(b.shopId), []);
    assert.deepEqual(await wantersOf(b.shopId, fresh.id), []);
    assert.equal(await matchWantsFor(b.shopId, [fresh.id]), 0);
    ok("tenant: another company can't add to, tell, finish or see A's want lists");

    console.log(`want-lists.check: ${steps} groups passed`);
  } finally {
    clearKick();
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
