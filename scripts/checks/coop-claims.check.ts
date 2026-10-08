// Co-op advertising and rebate claims (shop-features-round-2-design.md 9.2, package coop-claims): adding a claim with its
// proof (half the ad by default), owner or admin only, the deadline's dashboard list (14 days before, not sent), sent,
// paid short, undone, paid, turned down, the amount fixed once sent, the books (income when it comes in), tenant.
//   npm run check scripts/checks/coop-claims.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { addDays, ymdOf } from "@/lib/zoned";
import { buildBooks, balanced } from "@/lib/books";
import { DEFAULT_BOOKS } from "@/lib/books-accounts";
import { coopDue, coopList, coopProof, coopTotals, coopView, createCoopFor, denyCoopFor, fileCoopFor, recordCoopPaymentFor, removeProofFor, saveCoopFor, undoCoopFor } from "@/lib/coop-claims";
import { checkShop, cleanup, type CheckShop } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const tech = (s: CheckShop): CurrentUser => ({ ...s.user, role: "TECH" });
const fd = (o: Record<string, string | File>) => {
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
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

async function main() {
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    const today = ymdOf(new Date(), "America/New_York");
    // 1. Adding.
    await expectError("tech adds", () => createCoopFor(tech(a), fd({ maker: "Brother", spent: "400" })), /owner or admin/);
    await expectError("no maker", () => createCoopFor(a.user, fd({ maker: " ", spent: "400" })), /which maker/);
    await expectError("bad proof", () => createCoopFor(a.user, fd({ maker: "Brother", proof: new File([new Uint8Array([1])], "x.exe", { type: "application/x-msdownload" }) })), /photo .* or a PDF/);
    const c1 = await createCoopFor(a.user, fd({ maker: "Brother", spent: "400", program: "Spring co-op", adWhere: "The Gazette", placedOn: today, deadline: addDays(today, 10), proof: new File([PNG], "ad.png", { type: "image/png" }) }));
    let v = (await coopView(a.shopId, c1.id))!;
    assert.deepEqual([v.number, v.kind, v.spentCents, v.claimCents, v.status, v.proofs.length], [1, "COOP", 40000, 20000, "OPEN", 1], "half the ad by default");
    assert.ok(await coopProof(a.shopId, v.proofs[0].id));
    const c2 = await createCoopFor(a.user, fd({ maker: "Janome", kind: "REBATE", spent: "0", claim: "150", deadline: addDays(today, 40) }));
    assert.equal((await coopView(a.shopId, c2.id))!.claimCents, 15000);
    ok("adding: owner or admin, a maker, half the ad by default, a rebate's own amount, the ad's photo kept (a program file refused)");

    // 2. The dashboard's list.
    let due = await coopDue(a.shopId);
    assert.deepEqual(due.map((d) => d.number), [1], "due in 10 days shows; in 40 doesn't");
    await saveCoopFor(a.user, c2.id, fd({ maker: "Janome", kind: "REBATE", claim: "150", deadline: addDays(today, 14) }));
    due = await coopDue(a.shopId);
    assert.deepEqual(due.map((d) => d.number), [1, 2], "14 days ahead shows too");
    ok("the dashboard lists claims not sent with the deadline 14 days off or less");

    // 3. Steps.
    await expectError("tech files", () => fileCoopFor(tech(a), c1.id), /owner or admin/);
    await fileCoopFor(a.user, c1.id);
    assert.deepEqual((await coopDue(a.shopId)).map((d) => d.number), [2], "sent: off the list");
    await saveCoopFor(a.user, c1.id, fd({ maker: "Brother", spent: "400" }));
    assert.equal((await coopView(a.shopId, c1.id))!.claimCents, 20000, "the amount claimed stays as sent");
    assert.match(await recordCoopPaymentFor(a.user, c1.id, fd({ amount: "150" })), /short by \$50.00/);
    await undoCoopFor(a.user, c1.id);
    await recordCoopPaymentFor(a.user, c1.id, fd({ amount: "200" }));
    v = (await coopView(a.shopId, c1.id))!;
    assert.deepEqual([v.status, v.receivedCents], ["PAID", 20000]);
    await expectError("deny an unsent claim", () => denyCoopFor(a.user, c2.id, null), /Only a sent claim/);
    await fileCoopFor(a.user, c2.id);
    await denyCoopFor(a.user, c2.id, fd({ why: "Late" }));
    assert.match((await coopView(a.shopId, c2.id))!.note ?? "", /Turned down: Late/);
    const t = await coopTotals(a.shopId);
    assert.deepEqual(t.find((x) => x.maker === "Brother"), { maker: "Brother", waitingCents: 0, receivedCents: 20000, unsent: 0 });
    await removeProofFor(a.user, v.proofs[0].id);
    assert.equal((await coopView(a.shopId, c1.id))!.proofs.length, 0);
    ok("sent (off the list), the amount fixed, paid short, undone, paid; a rebate turned down with the reason; a proof removed");

    // 4. The books.
    const books = await buildBooks(a.shopId, "America/New_York", new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000), DEFAULT_BOOKS);
    for (const d of books.days) assert.ok(balanced(d));
    const net = books.days.flatMap((d) => d.lines).filter((l) => l.account === "Co-op and Rebates Received").reduce((x, l) => x + l.debitCents - l.creditCents, 0);
    assert.equal(net, -20000);
    ok("the books: what came in is income on its day");

    // 5. Tenant.
    await expectNotFound("B saves A's", () => saveCoopFor(b.user, c1.id, fd({ maker: "x" })));
    await expectNotFound("B files A's", () => fileCoopFor(b.user, c1.id));
    await expectNotFound("B pays A's", () => recordCoopPaymentFor(b.user, c1.id, fd({ amount: "1" })));
    await expectNotFound("B denies A's", () => denyCoopFor(b.user, c1.id, null));
    await expectNotFound("B undoes A's", () => undoCoopFor(b.user, c1.id));
    const p = await db.coopProof.create({ data: { shopId: a.shopId, claimId: c1.id, name: "inv.png", mime: "image/png", data: PNG } });
    await expectNotFound("B removes A's proof", () => removeProofFor(b.user, p.id));
    assert.equal(await coopProof(b.shopId, p.id), null);
    assert.equal(await coopView(b.shopId, c1.id), null);
    assert.deepEqual(await coopList(b.shopId), []);
    assert.deepEqual(await coopDue(b.shopId), []);
    ok("tenant: B can't read, change, send, settle, undo A's claims nor see or remove A's proof");
  } finally {
    await cleanup();
  }
  console.log(`coop-claims.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
