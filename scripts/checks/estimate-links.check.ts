// Estimate links against the database, the SMTP sink and the Twilio mock (scheduling-messaging-design.md 15.3 acceptance 2).
// Every scenario has its own customer (the staff cap is 3 messages a day per address) in throwaway companies "Check <run>".
//   npm run check scripts/checks/estimate-links.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { isUserError } from "@/lib/action";
import { db } from "@/lib/db";
import { answerByToken, estimateByToken, estimateStillWanted, ticketEstimateLines, recordEstimateAnswerAs, repliesSince, revokeEstimateLinkAs, sendEstimateAs, type SendEstimateInput } from "@/lib/estimate-links";
import { hookContext } from "@/lib/notices/context";
import { changeTicketStatus } from "@/lib/ticket-status";
import { unseal } from "@/lib/messaging/secrets";
import { messageRun } from "@/lib/messaging/worker";
import type { CurrentUser } from "@/lib/session";
import { checkShop, cleanup, clearKick, linkPair, messagingFor, withSink, type CheckShop, type SinkHandle } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

const BASE = "http://127.0.0.1:39998";
const DAY = 86_400_000;
const SOURCE = "203.0.113.9 · check";

let steps = 0;
const ok = (label: string) => {
  steps += 1;
  console.log(`  ok  ${label}`);
};

let sink: SinkHandle;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

async function customer(shopId: string, o: { name?: string; email?: string | null; phone?: string | null; notifyBy?: string } = {}) {
  const u = uniq();
  return db.customer.create({
    data: { shopId, name: o.name ?? "Mary Smith", email: o.email === undefined ? `est-${u}@a.test` : o.email, phone: o.phone === undefined ? null : o.phone, notifyBy: o.notifyBy ?? "email" },
  });
}

let ticketNumber = 1000;
/** A direct ticket waiting for the customer's OK, with one $145.00 taxable line and 8% tax (total $156.60). */
async function ticket(shopId: string, customerId: string | null, status: "WAITING_CUSTOMER_OK" | "ON_BENCH" = "WAITING_CUSTOMER_OK") {
  const m = await db.machine.create({ data: { shopId, brand: "Janome", model: "MC6700P", modelKey: "MC6700P", customerId } });
  return db.ticket.create({
    data: {
      shopId,
      number: ticketNumber++,
      status,
      machineId: m.id,
      customerId,
      taxRatePct: 8,
      lines: { create: [{ kind: "SERVICE", description: "Clean and oil", qty: 1, unitPriceCents: 14500, taxable: true }] },
    },
  });
}

const user = (s: CheckShop): CurrentUser => s.user;
const both: SendEstimateInput = { email: true, sms: false, note: null };
const linkOf = (shopId: string, ticketId: string) => db.estimateLink.findMany({ where: { shopId, ticketId }, orderBy: { createdAt: "asc" } });

/** The raw token of a link that hasn't been sent yet (it's sealed until the worker has sent its messages). */
async function tokenOf(shopId: string, linkId: string): Promise<string> {
  const l = await db.estimateLink.findFirstOrThrow({ where: { id: linkId, shopId } });
  const t = unseal(l.tokenSealed, shopId, `estimateToken:${l.id}`);
  assert.ok(t, "tokenSealed opens with the shop and link id");
  return t.plain;
}

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

async function tokenAndSecrets(a: CheckShop) {
  sink.clear();
  const c = await customer(a.shopId, { name: "Mary Smith" });
  const t = await ticket(a.shopId, c.id);
  await sendEstimateAs(user(a), "ticket", t.id, { ...both, note: "Thanks for waiting." });
  const [link] = await linkOf(a.shopId, t.id);
  assert.equal(link.totalCents, 15660, "the bill with tax");
  assert.deepEqual(link.lines, [{ description: "Clean and oil", amountCents: 14500 }, { description: "Tax", amountCents: 1160 }]);
  assert.equal(link.note, "Thanks for waiting.");
  assert.equal(link.customerId, c.id);
  const token = await tokenOf(a.shopId, link.id);
  assert.equal(token.length, 43, "256 bits as base64url");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(link.tokenHash, crypto.createHash("sha256").update(token).digest("hex"));
  assert.equal(link.maskedUrl, `${BASE}/e/•••${token.slice(-4)}`);
  assert.ok(+link.expiresAt - Date.now() > 6.9 * DAY && +link.expiresAt - Date.now() < 7.1 * DAY, "expires in estimateLinkDays (7)");
  let rows = await db.outMessage.findMany({ where: { shopId: a.shopId, ticketId: t.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "estimate");
  assert.equal(rows[0].refType, "estimate");
  assert.equal(rows[0].refId, link.id);
  assert.equal(rows[0].byUserId, a.user.id);
  assert.ok(rows[0].body.includes(link.maskedUrl), "the stored body carries the masked link");
  assert.ok(rows[0].body.includes("Clean and oil") && rows[0].body.includes("Tax"), "the lines are in the email");
  assert.ok(rows[0].body.includes("Thanks for waiting."), "the note is in the email");
  assert.ok(!rows[0].body.includes(token));

  // The worker sends it: the real link goes out, the token is cleared and found nowhere in the company's data.
  await run(a.shopId);
  rows = await db.outMessage.findMany({ where: { shopId: a.shopId, ticketId: t.id } });
  assert.equal(rows[0].status, "SENT", `${rows[0].status} ${rows[0].error}`);
  assert.equal(sink.messages.length, 1);
  assert.ok(sink.messages[0].raw.includes(`/e/${token}`), "the email carries the real link");
  assert.equal((await db.estimateLink.findUniqueOrThrow({ where: { id: link.id } })).tokenSealed, null, "tokenSealed is cleared after the send");
  const tables = await db.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'shopId'`;
  const like = `%${token}%`;
  for (const { table_name } of tables) {
    const hits = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table_name}" WHERE "shopId" = $1 AND "${table_name}"::text LIKE $2`, a.shopId, like);
    assert.equal(Number(hits[0].n), 0, `the raw token is in ${table_name}`);
  }
  ok("token: 43 chars, sha256 stored, sealed until sent; after the worker no row of the company holds it; the email carries /e/<token>");
  return { ticketId: t.id, token, linkId: link.id };
}

async function secondLinkRevokesFirst(a: CheckShop, first: { ticketId: string; token: string; linkId: string }) {
  await sendEstimateAs(user(a), "ticket", first.ticketId, both);
  const links = await linkOf(a.shopId, first.ticketId);
  assert.equal(links.length, 2);
  assert.ok(links[0].revokedAt, "the first link is stopped by the second");
  assert.equal(links[1].revokedAt, null);
  assert.equal(await answerByToken(first.token, "APPROVED", null, SOURCE), "gone", "an answer on the stopped link");
  assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: first.ticketId } })).status, "WAITING_CUSTOMER_OK");
  await sendEstimateAs(user(a), "ticket", first.ticketId, both); // the third
  await expectError("fourth send", () => sendEstimateAs(user(a), "ticket", first.ticketId, both), /^You've sent this estimate 3 times today\. Call them instead\.$/);
  assert.equal((await linkOf(a.shopId, first.ticketId)).length, 3, "a refused send creates no link");
  ok("a second link revokes the first (its token answers 'gone'); a fourth send in a shop-day is refused");
}

async function answers(a: CheckShop) {
  // Approved.
  const c = await customer(a.shopId, { name: "Bob Jones" });
  const t = await ticket(a.shopId, c.id);
  await sendEstimateAs(user(a), "ticket", t.id, both);
  const [link] = await linkOf(a.shopId, t.id);
  const token = await tokenOf(a.shopId, link.id);
  const view = await estimateByToken(token);
  assert.ok(view && view.view.state === "open");
  assert.equal(view.view.firstName, "Bob");
  assert.equal(view.view.machine, "Janome MC6700P");
  assert.match(view.view.ref, /^ticket 1\d{3}$/);
  const shown = JSON.stringify(view.view);
  assert.ok(!shown.includes("@a.test") && !shown.includes("Jones"), "the page view holds no email or last name");
  assert.equal(await answerByToken(token, "APPROVED", "Go ahead", SOURCE), "ok");
  const after = await db.ticket.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(after.status, "ON_BENCH", "approval moves the ticket to the bench");
  assert.equal(after.approvedCents, link.totalCents);
  assert.ok(after.notes?.includes("by link"), `notes: ${after.notes}`);
  assert.ok(after.notes?.includes("Go ahead"));
  const l2 = await db.estimateLink.findUniqueOrThrow({ where: { id: link.id } });
  assert.equal(l2.answer, "APPROVED");
  assert.equal(l2.answerFrom, SOURCE);
  assert.equal(l2.tokenSealed, null);
  assert.equal(await answerByToken(token, "DECLINED", null, SOURCE), "gone", "a second answer");
  assert.equal((await estimateByToken(token))!.view.state, "answered");
  ok("APPROVED by link: WAITING_CUSTOMER_OK -> ON_BENCH, approvedCents = the link's total, a notes line 'by link'; the second answer is 'gone'");

  // Declined keeps the status.
  const c2 = await customer(a.shopId, { name: "Cy Dee" });
  const t2 = await ticket(a.shopId, c2.id);
  await sendEstimateAs(user(a), "ticket", t2.id, both);
  const tok2 = await tokenOf(a.shopId, (await linkOf(a.shopId, t2.id))[0].id);
  assert.equal(await answerByToken(tok2, "DECLINED", null, SOURCE), "ok");
  const d = await db.ticket.findUniqueOrThrow({ where: { id: t2.id } });
  assert.equal(d.status, "WAITING_CUSTOMER_OK", "DECLINED leaves the status for staff");
  assert.equal(d.approvedCents, null);
  assert.ok(d.notes?.includes("declined by link"));
  ok("DECLINED by link keeps the status and writes the note");

  // Expired.
  const c3 = await customer(a.shopId, { name: "Ed Fay" });
  const t3 = await ticket(a.shopId, c3.id);
  await sendEstimateAs(user(a), "ticket", t3.id, both);
  const l3 = (await linkOf(a.shopId, t3.id))[0];
  const tok3 = await tokenOf(a.shopId, l3.id);
  await db.estimateLink.update({ where: { id: l3.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await estimateByToken(tok3))!.view.state, "expired");
  assert.equal(await answerByToken(tok3, "APPROVED", null, SOURCE), "gone");
  assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: t3.id } })).status, "WAITING_CUSTOMER_OK");
  ok("an expired link answers 'gone' and changes nothing");

  // The ticket moved on.
  const c4 = await customer(a.shopId, { name: "Flo Gee" });
  const t4 = await ticket(a.shopId, c4.id);
  await sendEstimateAs(user(a), "ticket", t4.id, both);
  const l4 = (await linkOf(a.shopId, t4.id))[0];
  const tok4 = await tokenOf(a.shopId, l4.id);
  await db.ticket.update({ where: { id: t4.id }, data: { status: "ON_BENCH" } });
  assert.equal((await estimateByToken(tok4))!.view.state, "revoked", "the page notices the ticket left WAITING_CUSTOMER_OK");
  assert.ok((await db.estimateLink.findUniqueOrThrow({ where: { id: l4.id } })).revokedAt);
  assert.equal(await answerByToken(tok4, "APPROVED", null, SOURCE), "gone");
  ok("a link whose ticket left 'Waiting on customer OK' is stopped on the next look");

  // Format.
  assert.equal(await estimateByToken("short"), null);
  assert.equal(await estimateByToken("x".repeat(43)), null);
  assert.equal(await answerByToken("short", "APPROVED", null, SOURCE), "gone");
  ok("a token of the wrong shape or an unknown one is no link");
}

async function counterAndPhone(a: CheckShop) {
  // The staff record the answer (text reply): the ticket moves, the reply is handled, open links stop.
  const c = await customer(a.shopId, { name: "Gus Hill", phone: "+12125550141", notifyBy: "email" });
  const t = await ticket(a.shopId, c.id);
  await sendEstimateAs(user(a), "ticket", t.id, both);
  const link = (await linkOf(a.shopId, t.id))[0];
  const tok = await tokenOf(a.shopId, link.id);
  const sent = await db.outMessage.findFirstOrThrow({ where: { shopId: a.shopId, ticketId: t.id } });
  await db.inboundText.create({ data: { shopId: a.shopId, sid: `SM${uniq()}`, fromNumber: "+12125550141", body: "yes go ahead", receivedAt: new Date(+sent.createdAt + 1000), customerId: c.id } });
  const replies = await repliesSince(a.shopId, c.phone, sent.createdAt);
  assert.equal(replies.length, 1);
  assert.deepEqual(await repliesSince(a.shopId, c.phone, new Date(Date.now() + DAY)), []);
  assert.deepEqual(await repliesSince(a.shopId, null, sent.createdAt), []);
  await recordEstimateAnswerAs(user(a), "ticket", t.id, { answer: "APPROVED", via: "text reply", note: null });
  const after = await db.ticket.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(after.status, "ON_BENCH");
  assert.equal(after.approvedCents, link.totalCents);
  assert.ok(after.notes?.includes("by text reply"));
  assert.ok((await db.inboundText.findFirstOrThrow({ where: { shopId: a.shopId, sid: replies[0].sid } })).handledAt, "the reply is marked handled");
  assert.ok((await db.estimateLink.findUniqueOrThrow({ where: { id: link.id } })).revokedAt, "the open link is stopped");
  assert.equal(await answerByToken(tok, "APPROVED", null, SOURCE), "gone", "the counter answered first");
  await expectError("again", () => recordEstimateAnswerAs(user(a), "ticket", t.id, { answer: "APPROVED", via: "phone", note: null }), /isn't waiting|already recorded/);
  ok("a text reply recorded by staff: ON_BENCH, 'by text reply', the reply handled, the link stopped; the link's answer is then 'gone'");

  // revokeEstimateLink.
  const c2 = await customer(a.shopId, { name: "Ida Jay" });
  const t2 = await ticket(a.shopId, c2.id);
  await sendEstimateAs(user(a), "ticket", t2.id, both);
  const l2 = (await linkOf(a.shopId, t2.id))[0];
  const tok2 = await tokenOf(a.shopId, l2.id);
  await revokeEstimateLinkAs(user(a), l2.id);
  const l2b = await db.estimateLink.findUniqueOrThrow({ where: { id: l2.id } });
  assert.ok(l2b.revokedAt && l2b.tokenSealed === null);
  assert.equal(await answerByToken(tok2, "APPROVED", null, SOURCE), "gone");
  await revokeEstimateLinkAs(user(a), l2.id); // stopping twice is fine
  ok("'Stop this link' sets revokedAt and clears the sealed token");
}

async function sendRules(a: CheckShop) {
  await expectError("no channel", async () => sendEstimateAs(user(a), "ticket", (await ticket(a.shopId, (await customer(a.shopId)).id)).id, { email: false, sms: false, note: null }), /^Pick email, text or both\.$/);
  const noCustomer = await ticket(a.shopId, null);
  await expectError("no customer", () => sendEstimateAs(user(a), "ticket", noCustomer.id, both), /^No customer on this ticket\.$/);
  const notWaiting = await ticket(a.shopId, (await customer(a.shopId)).id, "ON_BENCH");
  await expectError("not waiting", () => sendEstimateAs(user(a), "ticket", notWaiting.id, both), /^This ticket isn't waiting for the customer's OK\.$/);
  const emptyBill = await ticket(a.shopId, (await customer(a.shopId)).id);
  await db.ticketLine.deleteMany({ where: { ticketId: emptyBill.id } });
  await expectError("empty bill", () => sendEstimateAs(user(a), "ticket", emptyBill.id, both), /^There's nothing on the bill yet\.$/);
  const noEmail = await ticket(a.shopId, (await customer(a.shopId, { email: null, notifyBy: "email" })).id);
  const before = await db.estimateLink.count({ where: { shopId: a.shopId } });
  await expectError("no address", () => sendEstimateAs(user(a), "ticket", noEmail.id, both), /^Not sent: no email on file\.$/);
  assert.equal(await db.estimateLink.count({ where: { shopId: a.shopId } }), before, "a send that reaches nobody leaves no link behind");
  await expectError("long note", async () => sendEstimateAs(user(a), "ticket", (await ticket(a.shopId, (await customer(a.shopId)).id)).id, { ...both, note: "x".repeat(501) }), /too long/);
  // A machine that came through a partner shop: they call their customer.
  const viaPartner = await ticket(a.shopId, (await customer(a.shopId)).id);
  await db.repairJob.create({ data: { id: `chk${uniq()}`, shopId: a.shopId, linkId: "chk-none", side: "repair", tag: "7", status: "WAITING_CUSTOMER_OK", ticketId: viaPartner.id, customerName: "Sam S.", brand: "Janome", model: "X" } });
  await expectError("partner ticket", () => sendEstimateAs(user(a), "ticket", viaPartner.id, both), /^This customer came through another shop; they call their customer\.$/);
  ok("send rules: pick a channel, customer, status, bill, address, note length, a partner's machine");
}

async function noPublicAddress(a: CheckShop) {
  const prior = process.env.PUBLIC_URL;
  delete process.env.PUBLIC_URL;
  try {
    sink.clear();
    const c = await customer(a.shopId, { name: "Hal Ito" });
    const t = await ticket(a.shopId, c.id);
    const links = await db.estimateLink.count({ where: { shopId: a.shopId } });
    await sendEstimateAs(user(a), "ticket", t.id, both);
    assert.equal(await db.estimateLink.count({ where: { shopId: a.shopId } }), links, "no link without a public address");
    const row = await db.outMessage.findFirstOrThrow({ where: { shopId: a.shopId, ticketId: t.id } });
    assert.equal(row.refId, null);
    assert.ok(!row.body.includes("/e/"), "no link in the body");
    assert.match(row.body, /reply to this email to approve or decline/);
    ok("without a public address: no link, the 'call or reply' wording");
  } finally {
    process.env.PUBLIC_URL = prior;
  }
}

async function retailJob(retail: CheckShop, repair: CheckShop) {
  const linkId = await linkPair(repair.shopId, retail.shopId);
  const job = async (tag: string, c: { id: string; name: string }) =>
    db.repairJob.create({
      data: {
        id: `chk${uniq()}`,
        shopId: retail.shopId,
        linkId,
        side: "retail",
        tag,
        status: "WAITING_CUSTOMER_OK",
        customerId: c.id,
        customerName: "Dot K.",
        brand: "Bernina",
        model: "770",
        totalCents: 21600,
        taxCents: 1600,
        lines: [{ description: "Rebuild", qty: 1, amountCents: 20000, kind: "SERVICE" }],
      },
    });
  const c = await customer(retail.shopId, { name: "Dot Kim" });
  const j = await job("101", c);
  await sendEstimateAs(user(retail), "job", j.id, both);
  const link = await db.estimateLink.findFirstOrThrow({ where: { shopId: retail.shopId, repairJobId: j.id } });
  assert.equal(link.totalCents, 21600);
  assert.deepEqual(link.lines, [{ description: "Rebuild", amountCents: 20000 }, { description: "Tax", amountCents: 1600 }]);
  const tok = await tokenOf(retail.shopId, link.id);
  const v = await estimateByToken(tok);
  assert.equal(v!.view.ref, "tag 101");
  assert.equal(v!.view.machine, "Bernina 770");
  assert.equal(await answerByToken(tok, "APPROVED", "ok", SOURCE), "ok");
  const after = await db.repairJob.findUniqueOrThrow({ where: { shopId_id: { shopId: retail.shopId, id: j.id } } });
  assert.equal(after.approval, "APPROVED");
  assert.equal(after.approvedCents, 21600);
  const out = await db.partnerOutbox.findMany({ where: { shopId: retail.shopId, linkId, type: "job.reply" } });
  assert.equal(out.length, 1, "job.reply goes to the repair shop");
  assert.equal((out[0].data as { approval: string }).approval, "APPROVED");
  assert.equal(await answerByToken(tok, "APPROVED", null, SOURCE), "gone");
  ok("a retail job answered by link: approval + approvedCents written and a job.reply PartnerOutbox row");

  // The counter answers first (through the counter's own path, which doesn't know the link): the link answer is gone.
  const c2 = await customer(retail.shopId, { name: "Eve Lan" });
  const j2 = await job("102", c2);
  await sendEstimateAs(user(retail), "job", j2.id, both);
  const l2 = await db.estimateLink.findFirstOrThrow({ where: { shopId: retail.shopId, repairJobId: j2.id } });
  const tok2 = await tokenOf(retail.shopId, l2.id);
  await db.repairJob.update({ where: { shopId_id: { shopId: retail.shopId, id: j2.id } }, data: { approval: "DECLINED" } });
  assert.equal((await estimateByToken(tok2))!.view.state, "revoked", "the page sees the counter's answer");
  assert.equal(await answerByToken(tok2, "APPROVED", null, SOURCE), "gone");
  const c3 = await customer(retail.shopId, { name: "Fay Mo" });
  const j3 = await job("103", c3);
  await sendEstimateAs(user(retail), "job", j3.id, both);
  const l3 = await db.estimateLink.findFirstOrThrow({ where: { shopId: retail.shopId, repairJobId: j3.id } });
  const tok3 = await tokenOf(retail.shopId, l3.id);
  await db.repairJob.update({ where: { shopId_id: { shopId: retail.shopId, id: j3.id } }, data: { approval: "APPROVED" } }); // lands between the page's look and the answer
  assert.equal(await answerByToken(tok3, "DECLINED", null, SOURCE), "gone");
  assert.equal((await db.estimateLink.findUniqueOrThrow({ where: { id: l3.id } })).answer, null, "the claim is rolled back when the counter was first");
  ok("the counter answering first: the link's answer is 'gone'");

  // The staff record it for a job.
  const c4 = await customer(retail.shopId, { name: "Gil Ng" });
  const j4 = await job("104", c4);
  await sendEstimateAs(user(retail), "job", j4.id, both);
  await recordEstimateAnswerAs(user(retail), "job", j4.id, { answer: "DECLINED", via: "phone", note: "too much" });
  assert.equal((await db.repairJob.findUniqueOrThrow({ where: { shopId_id: { shopId: retail.shopId, id: j4.id } } })).approval, "DECLINED");
  await expectError("job again", () => recordEstimateAnswerAs(user(retail), "job", j4.id, { answer: "DECLINED", via: "phone", note: null }), /already recorded/);
  assert.equal(await db.partnerOutbox.count({ where: { shopId: retail.shopId, linkId, type: "job.reply" } }), 2, "one job.reply per answer: the by-link one and this one");
  ok("a job answer recorded by staff goes through the same path (job.reply sent once)");
  return j.id;
}

async function otherCompany(a: CheckShop, b: CheckShop, ticketId: string, linkId: string) {
  const tables = ["Ticket", "EstimateLink", "OutMessage", "PartnerOutbox"];
  const before = await snapshot(a.shopId, tables);
  await expectError("send, other company's ticket", () => sendEstimateAs(user(b), "ticket", ticketId, both), /^Ticket not found\.$/);
  await expectError("record, other company's ticket", () => recordEstimateAnswerAs(user(b), "ticket", ticketId, { answer: "APPROVED", via: "phone", note: null }), /^Ticket not found\.$/);
  await expectNotFound("revoke, other company's link", () => revokeEstimateLinkAs(user(b), linkId));
  await expectNotFound("send, other company's job", () => sendEstimateAs(user(b), "job", ticketId, both));
  assert.deepEqual(await repliesSince(b.shopId, "+12125550141", new Date(0)), [], "replies are the company's own");
  assertUnchanged("other company", before, await snapshot(a.shopId, tables));
  ok("another company's ticket id -> 'Ticket not found.'; revoke / record / job lookups find nothing; its rows are unchanged");
}

/** Without Marketing: the estimate link is in the base (pricing-review-2026-10.md, 7 Oct 2026). */
async function moduleOff(off: CheckShop) {
  const c = await customer(off.shopId);
  const t = await ticket(off.shopId, c.id);
  await sendEstimateAs(user(off), "ticket", t.id, both);
  const links = await linkOf(off.shopId, t.id);
  assert.equal(links.length, 1, "the link is made without Marketing");
  const rows = await db.outMessage.findMany({ where: { shopId: off.shopId, ticketId: t.id, kind: "estimate" } });
  assert.equal(rows.length, 1, "the estimate email is queued without Marketing");
  assert.equal(rows[0].status, "QUEUED");
  assert.equal(rows[0].refId, links[0].id);
  // Recording an answer is counter work: it works without the module.
  await recordEstimateAnswerAs(user(off), "ticket", t.id, { answer: "APPROVED", via: "phone", note: null });
  assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).status, "ON_BENCH");
  ok("Marketing off: the estimate still goes by link (base), and recording an answer works");
}

async function lines() {
  const t = { taxRatePct: 8.25, lines: [{ kind: "PART", description: "Belt", qty: 2, unitPriceCents: 1000, taxable: true }, { kind: "DISCOUNT", description: "Loyal", qty: 1, unitPriceCents: -500, taxable: false }] };
  const r = ticketEstimateLines(t);
  assert.deepEqual(r.lines.map((l) => l.description), ["Belt x2", "Loyal", "Tax"]);
  assert.equal(r.lines.reduce((s, l) => s + l.amountCents, 0), r.totalCents, "the lines add up to the total");
  ok("ticketEstimateLines: each line, then Tax; the lines add up to the total");
}


/** The review of 1 Oct 2026: a declined ticket is answered, a phone approval takes the open link's total, queued sends stop, replies of the whole round. */
async function reviewFixes(a: CheckShop) {
  // Declined by phone: the ticket keeps its status (design 10.4) but is answered: no form, no link answers, no re-send until a new estimate.
  const c = await customer(a.shopId, { name: "Dee Kline", phone: "+12125550177", notifyBy: "email" });
  const t = await ticket(a.shopId, c.id);
  await sendEstimateAs(user(a), "ticket", t.id, both);
  const l1 = (await linkOf(a.shopId, t.id))[0];
  const tok1 = await tokenOf(a.shopId, l1.id);
  await recordEstimateAnswerAs(user(a), "ticket", t.id, { answer: "DECLINED", via: "phone", note: null });
  let after = await db.ticket.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(after.status, "WAITING_CUSTOMER_OK", "declined keeps the status");
  assert.equal(after.estimateAnswer, "DECLINED");
  assert.ok(after.estimateAnsweredAt, "the answer is kept on the ticket");
  assert.equal((await estimateByToken(tok1))?.view.state, "revoked", "the link stops with the answer");
  await expectError("declined twice", () => recordEstimateAnswerAs(user(a), "ticket", t.id, { answer: "APPROVED", via: "phone", note: null }), /isn't waiting/);
  assert.equal(await estimateStillWanted({ kind: "estimate", shopId: a.shopId, refType: "estimate", refId: null, ticketId: t.id, repairJobId: null }), "The ticket isn't waiting for the customer's OK any more");
  // A new estimate (the bill was revised): waiting for an answer again.
  await sendEstimateAs(user(a), "ticket", t.id, both);
  after = await db.ticket.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(after.estimateAnswer, null, "a new estimate clears the old answer");
  // Back to the bench and waiting again by status: cleared then too.
  await db.ticket.update({ where: { id: t.id }, data: { estimateAnswer: "DECLINED", estimateAnsweredAt: new Date() } });
  const ctx = await hookContext(a.shopId, "Check");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { warrantyDays: true } });
  await db.$transaction(async (tx) => {
    const t1 = await tx.ticket.findUniqueOrThrow({ where: { id: t.id } });
    await changeTicketStatus(tx, t1, "ON_BENCH", new Date(), shop.warrantyDays, ctx);
    const t2 = await tx.ticket.findUniqueOrThrow({ where: { id: t.id } });
    await changeTicketStatus(tx, t2, "WAITING_CUSTOMER_OK", new Date(), shop.warrantyDays, ctx);
  });
  assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).estimateAnswer, null, "waiting for an OK again clears the answer");
  ok("a declined ticket is answered (no re-answer, its link stops, the queued row isn't wanted); a new estimate or waiting again clears it");

  // A phone approval records the OPEN link's total; with none open, the bill as it stands now.
  const c2 = await customer(a.shopId, { name: "Tot Al" });
  const t2 = await ticket(a.shopId, c2.id);
  await sendEstimateAs(user(a), "ticket", t2.id, both);
  const l2 = (await linkOf(a.shopId, t2.id))[0];
  assert.equal(l2.totalCents, 15660);
  await revokeEstimateLinkAs(user(a), l2.id); // the $156.60 link is stopped, then the bill grows
  await db.ticketLine.create({ data: { ticketId: t2.id, kind: "PART", description: "Bobbin case", qty: 1, unitPriceCents: 2000, taxable: false } });
  await recordEstimateAnswerAs(user(a), "ticket", t2.id, { answer: "APPROVED", via: "phone", note: null });
  const t2b = await db.ticket.findUniqueOrThrow({ where: { id: t2.id } });
  assert.equal(t2b.approvedCents, 17660, "the current bill, not the stopped link's $156.60");
  assert.ok(t2b.notes?.includes("approved $176.60 by phone"), t2b.notes ?? "");
  ok("a phone approval takes the current bill when the only link was stopped (an open link's total otherwise)");

  // Queued estimate messages stop when the answer arrives (by phone here; by link in answerByToken).
  const c3 = await customer(a.shopId, { name: "Que Ued", phone: "+12125550178" });
  const t3 = await ticket(a.shopId, c3.id);
  await sendEstimateAs(user(a), "ticket", t3.id, both);
  clearKick();
  const queued = await db.outMessage.findMany({ where: { shopId: a.shopId, ticketId: t3.id, kind: "estimate" } });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, "QUEUED");
  // A reply arrives, the estimate is re-sent, then staff record the answer: BOTH replies are handled (the whole round).
  await db.inboundText.create({ data: { shopId: a.shopId, sid: `SM${uniq()}`, fromNumber: "+12125550178", body: "how much again?", receivedAt: new Date(+queued[0].createdAt + 1000), customerId: c3.id } });
  await new Promise((r) => setTimeout(r, 1100));
  await sendEstimateAs(user(a), "ticket", t3.id, both);
  clearKick();
  await db.inboundText.create({ data: { shopId: a.shopId, sid: `SM${uniq()}`, fromNumber: "+12125550178", body: "ok yes", receivedAt: new Date(), customerId: c3.id } });
  await recordEstimateAnswerAs(user(a), "ticket", t3.id, { answer: "APPROVED", via: "text reply", note: null });
  const rows = await db.outMessage.findMany({ where: { shopId: a.shopId, ticketId: t3.id, kind: "estimate" }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(rows.map((r) => r.status), ["CANCELLED", "CANCELLED"], rows.map((r) => `${r.status}:${r.error}`).join(", "));
  // An approval moves the ticket to the bench first (the status hook cancels it then); a decline leaves closeOut to do it.
  assert.match(rows[1].error ?? "", /^(The customer answered|The ticket moved on before it went out)$/);
  const unhandled = await db.inboundText.count({ where: { shopId: a.shopId, fromNumber: "+12125550178", handledAt: null } });
  assert.equal(unhandled, 0, "the reply between the send and the re-send is handled too");
  ok("an answer cancels the estimate messages still queued and handles every reply of the round");

  // A trade account's end customer never gets a link: the dealer tells them.
  const dealer = await db.customer.create({ data: { shopId: a.shopId, name: "Quilt Corner", kind: "TRADE", email: `dealer-${uniq()}@a.test` } });
  const c4 = await customer(a.shopId, { name: "End Customer" });
  const t4 = await ticket(a.shopId, c4.id);
  await db.ticket.update({ where: { id: t4.id }, data: { viaAccountId: dealer.id } });
  await expectError("trade account", () => sendEstimateAs(user(a), "ticket", t4.id, both), /^This machine came in through a trade account; they tell their customer\.$/);
  ok("a ticket that came in through a trade account can't be sent an estimate link");
}

async function main() {
  const t0 = Date.now();
  const prior = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = BASE;
  try {
    sink = await withSink();
    const a = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
    await messagingFor(a.shopId, { email: true });
    const b = await checkShop({ retail: true, modules: ["marketing"] });
    await messagingFor(b.shopId, { email: true });
    const repair = await checkShop({ repair: true });
    const off = await checkShop({ modules: [] });
    await messagingFor(off.shopId, { email: true });

    await lines();
    const first = await tokenAndSecrets(a);
    await secondLinkRevokesFirst(a, first);
    await answers(a);
    await counterAndPhone(a);
    await reviewFixes(a);
    await sendRules(a);
    await noPublicAddress(a);
    await retailJob(b, repair);
    await otherCompany(a, b, first.ticketId, first.linkId);
    await moduleOff(off);
    console.log(`estimate-links.check: ${steps} groups passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    if (prior === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = prior;
    await cleanup();
    await db.$disconnect();
  }
}

main()
  .then(() => setTimeout(() => process.exit(0), 100).unref())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
    clearKick();
    setTimeout(() => process.exit(1), 100).unref();
  });
