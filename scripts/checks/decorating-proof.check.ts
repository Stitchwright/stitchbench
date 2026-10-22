// The decorating order's quote and proof by link (docs/plans/decorators-proposal.md, package D3), against the database and the
// SMTP sink: the mock-up picture (PNG or JPEG by its bytes, 2 MB, replaced or removed), sending the quote (Marketing, a public
// address, a channel), what the customer's page lists, the picture served for that link only, approving or declining by the
// link, a link that stops when the order or the picture changes, and the tenant section.
//   npm run check scripts/checks/decorating-proof.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { addLineFor, addPlacementFor, createOrderFor, mockupFile, orderView, proofMockup, removeMockupFor, sendProofFor, setMockupFor, setOrderStatusFor } from "@/lib/decor";
import { answerByToken, estimateByToken } from "@/lib/estimate-links";
import { unseal } from "@/lib/messaging/secrets";
import { messageRun } from "@/lib/messaging/worker";
import type { CurrentUser } from "@/lib/session";
import { grantDevLicense } from "../license/dev";
import { checkShop, cleanup, clearKick, messagingFor, withSink, type CheckShop, type SinkHandle } from "./lib";
import { expectNotFound } from "./tenant";

const BASE = "http://127.0.0.1:39997";
const DAY = 86_400_000;
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;
let sink: SinkHandle;

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
const fd = (o: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])], "mockup.png", { type: "image/png" });

async function tokenOf(shopId: string, linkId: string): Promise<string> {
  const l = await db.estimateLink.findFirstOrThrow({ where: { id: linkId, shopId } });
  const t = unseal(l.tokenSealed, shopId, `estimateToken:${l.id}`);
  assert.ok(t, "tokenSealed opens with the shop and link id");
  return t.plain;
}
async function run(shopId: string) {
  clearKick();
  for (let i = 0; i < 120; i++) {
    const r = await messageRun({ now: new Date(Date.now() + 1000), shopIds: [shopId] });
    if ("busy" in r) {
      await new Promise((res) => setTimeout(res, 500));
      continue;
    }
    return r;
  }
  throw new Error("messageRun stayed busy");
}
const mk = async (a: CheckShop, title: string, email = `proof-${Math.random().toString(36).slice(2, 8)}@a.test`) => {
  const c = await db.customer.create({ data: { shopId: a.shopId, name: "Fran Fire", email, notifyBy: "email" } });
  const o = await createOrderFor(user(a), fd({ customerId: c.id, title }));
  await addLineFor(user(a), o.id, fd({ description: "Gildan tee", color: "Black", qty: "24", garment: "6.00" }));
  await addPlacementFor(user(a), o.id, fd({ location: "Front", method: "SCREEN_PRINT", colors: "2", underbase: "on", newDesign: "on", width: "280", height: "300" }));
  await addPlacementFor(user(a), o.id, fd({ location: "Left chest", stitches: "5000", colors: "1" }));
  return o;
};

async function main() {
  const prior = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = BASE;
  try {
    sink = await withSink();
    const a = await checkShop({ retail: true, modules: ["marketing"] });
    await messagingFor(a.shopId, { email: true });
    const b = await checkShop({ retail: true, modules: ["marketing"] });
    await messagingFor(b.shopId, { email: true });
    const off = await checkShop({ retail: true });
    for (const s of [a, b, off]) await grantDevLicense(s.shopId, ["decorating"], { from: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) });

    // 1. The mock-up picture.
    const o = await mk(a, "Spirit week tees");
    await expectError("nothing chosen", () => setMockupFor(user(a), o.id, fd({})), /Choose a picture/);
    await expectError("a text file named .png", () => setMockupFor(user(a), o.id, fd({ mockup: new File(["not a picture"], "x.png", { type: "image/png" }) })), /PNG or JPEG/);
    await expectError("an SVG", () => setMockupFor(user(a), o.id, fd({ mockup: new File(["<svg onload=alert(1)></svg>"], "x.svg", { type: "image/svg+xml" }) })), /PNG or JPEG/);
    await expectError("over 2 MB", () => setMockupFor(user(a), o.id, fd({ mockup: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(2 * 1024 * 1024)])], "big.png") })), /larger than 2 MB/);
    await setMockupFor(user(a), o.id, fd({ mockup: PNG() }));
    const f = await mockupFile(a.shopId, o.id);
    assert.deepEqual([f?.mime, f?.data.length], ["image/png", 12]);
    await setMockupFor(user(a), o.id, fd({ mockup: new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9])], "renamed.png", { type: "image/png" }) }));
    assert.equal((await mockupFile(a.shopId, o.id))?.mime, "image/jpeg", "the type comes from the bytes, not the name");
    assert.equal((await orderView(a.shopId, o.id))!.hasMockup, true);
    ok("the mock-up: PNG or JPEG by its bytes (a text file named .png and an SVG are refused), 2 MB at most, replaced in place");

    // 2. Sending: the rules, then the real send.
    await expectError("no marketing", () => sendProofFor(user(off), o.id, { email: true, sms: false, note: null }), /Messages|Marketing|not on|off/i);
    await expectError("no channel", () => sendProofFor(user(a), o.id, { email: false, sms: false, note: null }), /Pick email, text or both/);
    delete process.env.PUBLIC_URL;
    await expectError("no public address", () => sendProofFor(user(a), o.id, { email: true, sms: false, note: null }), /no public address/);
    process.env.PUBLIC_URL = BASE;
    const empty = await createOrderFor(user(a), fd({ customerId: (await db.customer.create({ data: { shopId: a.shopId, name: "Nobody", email: "n@a.test", notifyBy: "email" } })).id, title: "Empty" }));
    await expectError("no price yet", () => sendProofFor(user(a), empty.id, { email: true, sms: false, note: null }), /Add the garments/);
    sink.clear();
    assert.match(await sendProofFor(user(a), o.id, { email: true, sms: false, note: "Please check the colours." }), /on their way/);
    const link = await db.estimateLink.findFirstOrThrow({ where: { shopId: a.shopId, decorOrderId: o.id } });
    const view0 = (await orderView(a.shopId, o.id))!;
    assert.equal(link.totalCents, view0.quoteCents);
    assert.equal((link.lines as { amountCents: number }[]).reduce((t, l) => t + l.amountCents, 0), view0.quoteCents, "the lines the customer sees add up to the total");
    const token = await tokenOf(a.shopId, link.id);
    const row = await db.outMessage.findFirstOrThrow({ where: { shopId: a.shopId, refId: link.id } });
    assert.ok(row.body.includes(link.maskedUrl) && row.body.includes("Screen print, front") && row.body.includes("Please check the colours.") && !row.body.includes(token), "the stored body has the masked link, the lines and the note");
    await run(a.shopId);
    assert.equal(sink.messages.length, 1);
    assert.ok(sink.messages[0].raw.includes(`/e/${token}`), "the email carries the real link");
    await expectError("not quoted any more", async () => {
      const x = await mk(a, "Approved already");
      await setOrderStatusFor(user(a), x.id, "APPROVED");
      await sendProofFor(user(a), x.id, { email: true, sms: false, note: null });
    }, /Only a quoted order/);
    ok("sending: Marketing, a public address, a channel, a price and a quoted order are all required; the email carries the lines, the note and the real link, the stored copy only the masked one");

    // 3. What the customer's page lists, and the picture for that link only.
    const found = (await estimateByToken(token))!;
    assert.equal(found.view.state, "open");
    assert.deepEqual([found.view.machine, found.view.ref, found.view.proof?.hasMockup], ["Spirit week tees", `order #${view0.number}`, true]);
    assert.deepEqual(found.view.proof?.items, [
      { where: "Front", what: "Screen print, 2 colours on a white underbase, 280 × 300 mm" },
      { where: "Left chest", what: "Embroidery, 5,000 stitches, 1 colour" },
    ]);
    const img = await proofMockup(token);
    assert.deepEqual([img?.mime, img?.data.length], ["image/jpeg", 7]);
    assert.equal(await proofMockup("x".repeat(43)), null);
    assert.equal(await proofMockup("short"), null);
    const other = await mk(a, "Another order");
    await sendProofFor(user(a), other.id, { email: true, sms: false, note: null });
    const otherToken = await tokenOf(a.shopId, (await db.estimateLink.findFirstOrThrow({ where: { shopId: a.shopId, decorOrderId: other.id } })).id);
    assert.equal(await proofMockup(otherToken), null, "an order with no picture shows none, whatever another order has");
    ok("the customer's page lists each decoration in words and says there is a picture; the picture is served for that link's order only (a wrong token, a short one and an order with none give nothing)");

    // 4. A change stops the link; the picture stops with it.
    await addLineFor(user(a), o.id, fd({ description: "Cap", qty: "2", garment: "10" }));
    assert.equal((await estimateByToken(token))!.view.state, "revoked", "the price changed: the link stops");
    assert.equal(await proofMockup(token), null, "a stopped link shows no picture");
    await sendProofFor(user(a), o.id, { email: true, sms: false, note: null });
    const link2 = await db.estimateLink.findFirstOrThrow({ where: { shopId: a.shopId, decorOrderId: o.id, revokedAt: null } });
    const token2 = await tokenOf(a.shopId, link2.id);
    await setMockupFor(user(a), o.id, fd({ mockup: PNG() }));
    assert.equal((await estimateByToken(token2))!.view.state, "revoked", "a new picture stops the link: they approved something else");
    await removeMockupFor(user(a), o.id);
    assert.equal((await orderView(a.shopId, o.id))!.hasMockup, false);
    ok("a change to the garments, decorations or picture stops the link already sent, and a stopped link shows no picture");

    // 5. Approving and declining (an order of its own: staff may send at most three to one address a day).
    const p5 = await mk(a, "Approval order");
    await sendProofFor(user(a), p5.id, { email: true, sms: false, note: null });
    const link3 = await db.estimateLink.findFirstOrThrow({ where: { shopId: a.shopId, decorOrderId: p5.id, revokedAt: null } });
    const token3 = await tokenOf(a.shopId, link3.id);
    assert.equal(await answerByToken(token3, "DECLINED", "Can we use blue?", "203.0.113.9 · check"), "ok");
    let v = (await orderView(a.shopId, p5.id))!;
    assert.deepEqual([v.status, /declined the quote and proof by link: Can we use blue\?/.test(v.note ?? "")], ["QUOTED", true], "declined: still quoted, her words in the note");
    assert.equal(await answerByToken(token3, "APPROVED", null, "x"), "gone", "one answer per link");
    await sendProofFor(user(a), p5.id, { email: true, sms: false, note: null });
    const link4 = await db.estimateLink.findFirstOrThrow({ where: { shopId: a.shopId, decorOrderId: p5.id, revokedAt: null, answer: null } });
    const token4 = await tokenOf(a.shopId, link4.id);
    assert.equal(await answerByToken(token4, "APPROVED", "Looks good", "203.0.113.9 · check"), "ok");
    v = (await orderView(a.shopId, p5.id))!;
    assert.deepEqual([v.status, !!v.approvedAt, /approved the quote and proof by link: Looks good/.test(v.note ?? ""), v.link?.answer], ["APPROVED", true, true, "APPROVED"], "approved moves the order on");
    assert.equal((await estimateByToken(token4))!.view.state, "answered");
    ok("approving moves the order to approved and declining leaves it quoted, her words in the note; one answer per link");

    // 6. Tenant.
    await setMockupFor(user(a), other.id, fd({ mockup: PNG() }));
    await expectNotFound("B sets A's mock-up", () => setMockupFor(user(b), other.id, fd({ mockup: PNG() })));
    await expectNotFound("B removes A's mock-up", () => removeMockupFor(user(b), other.id));
    await expectNotFound("B sends A's order", () => sendProofFor(user(b), other.id, { email: true, sms: false, note: null }));
    assert.equal(await mockupFile(b.shopId, other.id), null);
    assert.equal(await orderView(b.shopId, other.id), null);
    ok("tenant: B can't set, remove, read or send A's mock-up or quote");
  } finally {
    process.env.PUBLIC_URL = prior;
    await cleanup();
  }
  console.log(`decorating-proof.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
