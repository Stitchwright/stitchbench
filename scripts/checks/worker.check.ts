// The message worker against the database, the SMTP sink and the Twilio mock (scheduling-messaging-design.md section
// 16.2, scheduling-foundation acceptance item 4). Sink and mock run in this process on ephemeral ports; every scenario
// has its own throwaway company "Check <run> ..." (all removed at the end) and runs the worker for that company only
// (messageRun({ shopIds })) with an injected clock. Rows come from queueToCustomer / queueToAddress, except the
// hand-made EstimateLink and the stale SENDING rows.
//   npm run check scripts/checks/worker.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import { SKIP_REASON_LABEL } from "@/lib/constants";
import { db } from "@/lib/db";
import { clearStaleOwnLeases, LEASE_HOLDER } from "@/lib/lease";
import { kickMessages } from "@/lib/messaging/kick";
import { INCOMPLETE_HOLD, pollReplies } from "@/lib/messaging/inbound";
import { queueToAddress, queueToCustomer } from "@/lib/messaging/queue";
import { seal } from "@/lib/messaging/secrets";
import { sendConfig } from "@/lib/messaging/settings";
import { messageRun, OFF_MESSAGE, runMessages, sendOneNow, type MessageRunResult } from "@/lib/messaging/worker";
import type { Channel, MessageKind } from "@/lib/messaging/types";
import { shopsWith } from "@/lib/module-gate";
import { addDays, ymdOf, zonedTime } from "@/lib/zoned";
import { checkShop, cleanup, clearKick, messagingFor, switchFeatures, withMock, withSink, type CheckShop, type MessagingOverrides, type MockHandle, type SinkHandle } from "./lib";

const NY = "America/New_York";
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const g = globalThis as unknown as { __messageKick?: NodeJS.Timeout | null };

/** Shop wall-clock time in New York: at("2026-10-14", "13:00"). Clocks are injected, so any day will do; 2026-10-14 is a Wednesday. */
const at = (ymd: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return zonedTime(ymd, h * 60 + m, NY);
};
const WED = "2026-10-14";
const NOON_ISH = at(WED, "13:00");

let steps = 0;
const ok = (label: string) => {
  steps += 1;
  console.log(`  ok  ${label}`);
};

let sink: SinkHandle;
let mock: MockHandle;
let fromCounter = 0;
/** Every shop gets its own Twilio number, so a reply posted for one is never read by another. */
const nextFrom = () => `+1212555${String(1100 + fromCounter++)}`;

type LiveOpts = { modules?: ("marketing" | "scheduling")[]; email?: boolean; sms?: boolean; token?: string; settings?: MessagingOverrides };
type Shop = CheckShop & { from: string };

async function shopWith(o: LiveOpts = {}): Promise<Shop> {
  const s = await checkShop({ modules: o.modules ?? ["marketing"], tz: NY });
  const from = nextFrom();
  await messagingFor(s.shopId, {
    email: o.email === false ? undefined : true,
    sms: o.sms === false ? undefined : { from, token: o.token },
    settings: o.settings,
  });
  return { ...s, from };
}

async function customer(shopId: string, o: { name?: string; phone?: string | null; email?: string | null; notifyBy?: string; consent?: boolean | string }) {
  const phone = o.phone === undefined ? null : o.phone;
  const consentPhone = typeof o.consent === "string" ? o.consent : o.consent ? phone : null;
  const c = await db.customer.create({
    data: {
      shopId,
      name: o.name ?? "Mary Smith",
      phone,
      email: o.email === undefined ? null : o.email,
      notifyBy: o.notifyBy ?? "",
      smsConsentAt: consentPhone ? new Date("2026-09-01T12:00:00Z") : null,
      smsConsentPhone: consentPhone,
      smsConsentSource: consentPhone ? "paper" : null,
    },
  });
  return c.id;
}

const content = (label: string) => (c: Channel) => ({ subject: `Subject ${label}`, body: `Body ${label} ${c}` });

/** A notice ("ready") to the customer on the channels their notifyBy asks for. */
async function notice(shopId: string, customerId: string, key: string, sendAfter: Date, channels: "preferred" | Channel[] = "preferred", kind: MessageKind = "ready") {
  const r = await queueToCustomer(db, { shopId, customerId, kind, channels, content: content(key), dedupeKey: key, sendAfter });
  clearKick();
  return r;
}

/** A marketing message ("campaign") on one channel. */
async function marketing(shopId: string, customerId: string, key: string, channel: Channel, sendAfter: Date, kind: MessageKind = "campaign") {
  const r = await queueToCustomer(db, { shopId, customerId, kind, channels: [channel], content: content(key), dedupeKey: key, sendAfter });
  clearKick();
  return r;
}

const rowOf = (shopId: string, key: string, channel: Channel) => db.outMessage.findFirstOrThrow({ where: { shopId, dedupeKey: `${key}:${channel}` } });
const rowById = (id: string) => db.outMessage.findUniqueOrThrow({ where: { id } });
const settingsOf = (shopId: string) => db.messagingSettings.findUniqueOrThrow({ where: { shopId } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One run for the company; waits while another process (a dev server, another check on this database) holds the lease. */
async function run(s: { shopId: string }, now: Date): Promise<{ sent: number; failed: number; waiting: number }> {
  for (let i = 0; i < 120; i++) {
    const r: MessageRunResult = await messageRun({ now, shopIds: [s.shopId] });
    if ("busy" in r) {
      await sleep(500);
      continue;
    }
    assert.ok("sent" in r, `messageRun answered ${JSON.stringify(r)}`);
    return r;
  }
  throw new Error("messageRun stayed busy for a minute: another process holds the \"messages\" lease");
}

const reset = () => {
  sink.clear();
  mock.clear();
};

async function messagesOff() {
  process.env.MESSAGES = "off";
  try {
    assert.deepEqual(await runMessages(), { off: true }, "runMessages");
    assert.deepEqual(await messageRun(), { off: true }, "messageRun");
    assert.deepEqual(await messageRun({ shopIds: ["nobody"], now: new Date() }), { off: true }, "messageRun with options");
    const one = await sendOneNow("no-such-row");
    assert.deepEqual(one, { error: OFF_MESSAGE }, "sendOneNow");
    assert.match(OFF_MESSAGE, /MESSAGES=off/);
    clearKick();
    kickMessages();
    assert.ok(!g.__messageKick, "kickMessages sets no timer with MESSAGES=off");
  } finally {
    delete process.env.MESSAGES;
  }
  // And with it unset the kick does start a timer (cleared at once: the check runs the worker itself).
  clearKick();
  kickMessages();
  assert.ok(g.__messageKick, "kickMessages sets its timer when messages are on");
  clearKick();
  ok("MESSAGES=off: runMessages, messageRun, sendOneNow answer off; kickMessages does nothing");
}

async function deliveryAndRace() {
  reset();
  const s = await shopWith();
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push(await customer(s.shopId, { name: `Mary ${i}`, phone: `+1212555${2010 + i}`, email: `c${i}@a.test`, notifyBy: "both" }));
  const sendAfter = new Date(NOON_ISH.getTime() - HOUR);
  const first = await notice(s.shopId, ids[0], "ready:0", sendAfter);
  assert.deepEqual(
    first.queued.map((q) => q.channel),
    ["email", "sms"],
  );
  const again = await notice(s.shopId, ids[0], "ready:0", sendAfter);
  assert.deepEqual(again.queued, [], "the same dedupe key twice queues nothing the second time");
  assert.deepEqual(again.duplicate, ["email", "sms"]);
  assert.equal(await db.outMessage.count({ where: { shopId: s.shopId, dedupeKey: { startsWith: "ready:0:" } } }), 2, "one row per channel, not four");
  for (let i = 1; i < 6; i++) await notice(s.shopId, ids[i], `ready:${i}`, sendAfter);
  assert.equal(await db.outMessage.count({ where: { shopId: s.shopId, status: "QUEUED" } }), 12);

  // Two runs at once: the lease lets the same process in twice, the per-row claim makes each row go once.
  let r1: MessageRunResult = { busy: true };
  let r2: MessageRunResult = { busy: true };
  for (let i = 0; i < 120 && "busy" in r1 && "busy" in r2; i++) {
    [r1, r2] = await Promise.all([messageRun({ now: NOON_ISH, shopIds: [s.shopId] }), messageRun({ now: NOON_ISH, shopIds: [s.shopId] })]);
    if ("busy" in r1 && "busy" in r2) await sleep(500); // another process holds the lease
  }
  const counted = [r1, r2].reduce((n, r) => n + ("sent" in r ? r.sent : 0), 0);
  assert.equal(counted, 12, `the two runs reported ${JSON.stringify([r1, r2])}`);
  const rows = await db.outMessage.findMany({ where: { shopId: s.shopId } });
  assert.equal(rows.length, 12);
  for (const r of rows) {
    assert.equal(r.status, "SENT", `${r.dedupeKey}: ${r.status} ${r.error}`);
    assert.ok(r.providerId, `${r.dedupeKey} has no provider id`);
    assert.equal(r.tries, 1, `${r.dedupeKey} was claimed ${r.tries} times`);
    assert.equal(+r.sentAt!, +NOON_ISH);
  }
  assert.equal(sink.messages.length, 6, "each email reached the sink once");
  assert.deepEqual(new Set(sink.messages.map((m) => m.to[0])).size, 6);
  for (let i = 0; i < 6; i++) {
    const m = sink.messages.find((x) => x.to.includes(`c${i}@a.test`));
    assert.ok(m, `no email to c${i}@a.test`);
    assert.equal(m.user, "check-user", "authenticated with the saved login");
    assert.match(m.raw, /Subject: Subject ready:\d/);
    assert.ok(m.raw.includes(`Body ready:${i} email`), "the body is in the message");
    assert.ok(m.raw.includes(s.name), "the notice email is signed with the shop's name");
  }
  assert.equal(mock.sent.length, 6, "each text reached the mock once");
  assert.equal(new Set(mock.sent.map((m) => m.to)).size, 6);
  for (const m of mock.sent) {
    assert.equal(m.from, s.from);
    assert.ok(m.body.startsWith(`${s.name}: Body ready:`), `the text starts with the shop's name: ${m.body}`);
    assert.ok(!m.body.includes("Reply STOP"), "a notice has no STOP line");
  }
  const st = await settingsOf(s.shopId);
  assert.ok(st.emailOkAt && st.smsOkAt && st.emailError === null && st.smsError === null, "both channels report working");
  ok("a notice email and text reach the sink / mock; the same dedupe key twice -> one row; two messageRun() at once send each row once");
}

async function sinkStopped() {
  reset();
  const s = await shopWith({ sms: false });
  const c = await customer(s.shopId, { email: "stopped@b.test", notifyBy: "email" });
  await notice(s.shopId, c, "stopped", new Date(NOON_ISH.getTime() - HOUR));
  await sink.stop();
  try {
    const r = await run(s, NOON_ISH);
    assert.equal(r.sent, 0);
    let row = await rowOf(s.shopId, "stopped", "email");
    assert.equal(row.status, "QUEUED", `${row.status} ${row.error}`);
    assert.equal(row.retryTries, 0, "being offline never counts as a failure");
    assert.ok(row.nextTryAt && row.nextTryAt.getTime() > NOON_ISH.getTime(), "nextTryAt is set");
    assert.equal(+row.nextTryAt, NOON_ISH.getTime() + 60_000, "30 s * 2^tries with tries 1");
    assert.ok(row.error, "the row says why");
    assert.ok(row.claimedAt === null, "claim released");
    const st = await settingsOf(s.shopId);
    assert.match(st.emailError ?? "", /^Can't reach/, `emailError: ${st.emailError}`);
    assert.equal(st.emailPausedAt, null, "not paused after a few minutes offline");
    // Not due again until nextTryAt.
    await run(s, new Date(NOON_ISH.getTime() + 30_000));
    row = await rowOf(s.shopId, "stopped", "email");
    assert.equal(row.status, "QUEUED");
    assert.equal(row.tries, 1, "not tried again before nextTryAt");
  } finally {
    await sink.start();
  }
  const r2 = await run(s, new Date(NOON_ISH.getTime() + 11 * MIN));
  assert.equal(r2.sent, 1);
  const row = await rowOf(s.shopId, "stopped", "email");
  assert.equal(row.status, "SENT", `${row.status} ${row.error}`);
  assert.equal(row.error, null);
  assert.equal(sink.messages.length, 1, "sent after the restart");
  assert.equal((await settingsOf(s.shopId)).emailError, null, "the status line clears");
  ok("sink stopped -> QUEUED with nextTryAt, retryTries 0, emailError set; sent after restart");
}

async function smtpAnswers() {
  // 451: the row retries and the channel stops for the run.
  reset();
  let s = await shopWith({ sms: false });
  const cLater = await customer(s.shopId, { name: "Later", email: "later@c.test", notifyBy: "email" });
  let cOk = await customer(s.shopId, { name: "Fine", email: "fine@c.test", notifyBy: "email" });
  await notice(s.shopId, cLater, "later", new Date(NOON_ISH.getTime() - 10 * MIN));
  await notice(s.shopId, cOk, "fine", new Date(NOON_ISH.getTime() - 5 * MIN));
  await run(s, NOON_ISH);
  const later = await rowOf(s.shopId, "later", "email");
  assert.equal(later.status, "QUEUED", `${later.status} ${later.error}`);
  assert.equal(later.retryTries, 1);
  assert.equal(+later.nextTryAt!, NOON_ISH.getTime() + 60_000, "backoff 30 s * 2^1");
  assert.ok(later.error);
  const fine = await rowOf(s.shopId, "fine", "email");
  assert.equal(fine.status, "QUEUED", "a 4xx stops the channel for the run: the next row isn't tried");
  assert.equal(fine.tries, 0);
  assert.equal(sink.messages.length, 0);
  assert.equal((await settingsOf(s.shopId)).emailPausedAt, null, "a 451 doesn't pause the channel");
  ok("sink answers 451 -> retry, the channel stops for the run");

  // 550 5.4.5: the channel is paused until 08:00 on the next shop-day, rows stay QUEUED.
  reset();
  s = await shopWith({ sms: false });
  const cQuota = await customer(s.shopId, { name: "Quota", email: "quota@c.test", notifyBy: "email" });
  cOk = await customer(s.shopId, { name: "Fine", email: "fine@c.test", notifyBy: "email" });
  await notice(s.shopId, cQuota, "quota", new Date(NOON_ISH.getTime() - 10 * MIN));
  await notice(s.shopId, cOk, "fine", new Date(NOON_ISH.getTime() - 5 * MIN));
  await run(s, NOON_ISH);
  const next8 = zonedTime(addDays(ymdOf(NOON_ISH, NY), 1), 8 * 60, NY);
  let st = await settingsOf(s.shopId);
  assert.ok(st.emailPausedAt, "paused");
  assert.equal(+st.emailPausedUntil!, +next8, `paused until ${st.emailPausedUntil?.toISOString()}, wanted ${next8.toISOString()} (08:00 next shop-day)`);
  assert.ok(st.emailError, "the status line says why");
  const quota = await rowOf(s.shopId, "quota", "email");
  assert.equal(quota.status, "QUEUED");
  assert.equal((await rowOf(s.shopId, "fine", "email")).status, "QUEUED");
  assert.equal(sink.messages.length, 0);
  // The pause ends by itself at 08:00 (tidy), then mail flows again.
  await db.outMessage.update({ where: { id: quota.id }, data: { status: "CANCELLED" } });
  await run(s, new Date(+next8 + MIN));
  st = await settingsOf(s.shopId);
  assert.equal(st.emailPausedAt, null, "unpaused at the next shop-day 08:00");
  assert.equal((await rowOf(s.shopId, "fine", "email")).status, "SENT");
  ok("550 5.4.5 -> channel paused until the next shop-day 08:00, rows still QUEUED; unpaused after");

  // 550 5.1.1: that row FAILED, the others go on.
  reset();
  s = await shopWith({ sms: false });
  const cReject = await customer(s.shopId, { name: "Reject", email: "reject@c.test", notifyBy: "email" });
  cOk = await customer(s.shopId, { name: "Fine", email: "fine@c.test", notifyBy: "email" });
  await notice(s.shopId, cReject, "reject", new Date(NOON_ISH.getTime() - 10 * MIN));
  await notice(s.shopId, cOk, "fine", new Date(NOON_ISH.getTime() - 5 * MIN));
  const r = await run(s, NOON_ISH);
  const reject = await rowOf(s.shopId, "reject", "email");
  assert.equal(reject.status, "FAILED", `${reject.status} ${reject.error}`);
  assert.ok(reject.error, "FAILED carries the plain error");
  assert.equal((await rowOf(s.shopId, "fine", "email")).status, "SENT", "the next recipient still goes");
  assert.equal(r.failed, 1);
  assert.equal((await settingsOf(s.shopId)).emailPausedAt, null, "one bad address doesn't pause the channel");
  ok("550 5.1.1 -> that row FAILED");

  // Three 5.1.1 in a row: the channel is paused.
  reset();
  s = await shopWith({ sms: false });
  const cBad = await customer(s.shopId, { name: "Reject", email: "reject@c.test", notifyBy: "email" });
  cOk = await customer(s.shopId, { name: "Fine", email: "fine@c.test", notifyBy: "email" });
  for (let i = 1; i <= 3; i++) await notice(s.shopId, cBad, `reject${i}`, new Date(NOON_ISH.getTime() - (10 - i) * MIN));
  await notice(s.shopId, cOk, "fine", new Date(NOON_ISH.getTime() - 2 * MIN));
  await run(s, NOON_ISH);
  for (let i = 1; i <= 3; i++) assert.equal((await rowOf(s.shopId, `reject${i}`, "email")).status, "FAILED", `reject${i}`);
  st = await settingsOf(s.shopId);
  assert.ok(st.emailPausedAt, "three recipient failures in a row pause the channel");
  assert.equal(st.emailPausedUntil, null, "no end date: the hourly check decides");
  assert.ok(st.emailCheckAt && +st.emailCheckAt === NOON_ISH.getTime() + HOUR, "next check in an hour");
  assert.match(st.emailError ?? "", /refusing messages/);
  assert.equal((await rowOf(s.shopId, "fine", "email")).status, "QUEUED", "the fourth row waits");
  assert.equal(sink.messages.length, 0);
  ok("three 5.1.1 in a row -> channel paused");
  void later;
  void cLater;
}

async function ambiguous() {
  // The sink closes the socket after DATA.
  reset();
  let s = await shopWith({ sms: false });
  const cm = await customer(s.shopId, { name: "Vanish M", email: "vanish+m@c.test", notifyBy: "email" });
  const cn = await customer(s.shopId, { name: "Vanish N", email: "vanish+n@c.test", notifyBy: "email" });
  await marketing(s.shopId, cm, "vanish-marketing", "email", new Date(NOON_ISH.getTime() - 10 * MIN));
  await notice(s.shopId, cn, "vanish-notice", new Date(NOON_ISH.getTime() - 5 * MIN));
  await run(s, NOON_ISH);
  const m = await rowOf(s.shopId, "vanish-marketing", "email");
  assert.equal(m.status, "FAILED", `${m.status} ${m.error}`);
  assert.equal(m.error, "May have gone out; not sent again");
  let n = await rowOf(s.shopId, "vanish-notice", "email");
  assert.equal(n.status, "QUEUED", `${n.status} ${n.error}`);
  assert.equal(n.retryTries, 1, "a notice is retried once");
  assert.ok(n.nextTryAt && +n.nextTryAt === NOON_ISH.getTime() + 30_000);
  const later = new Date(NOON_ISH.getTime() + 2 * MIN);
  await run(s, later);
  n = await rowOf(s.shopId, "vanish-notice", "email");
  assert.equal(n.status, "FAILED", `${n.status} ${n.error}`);
  assert.equal(n.error, "May have gone out; not sent again");
  assert.equal(n.tries, 2, "tried exactly twice");
  ok("sink closes the socket after DATA: marketing -> FAILED 'May have gone out; not sent again', notice -> retried once then FAILED");

  // The mock records a text and drops the connection: findSent finds it, SENT with that SID, one copy.
  reset();
  s = await shopWith({ email: false });
  const c = await customer(s.shopId, { name: "Drop", phone: "+12125550003", notifyBy: "sms" });
  await notice(s.shopId, c, "drop", new Date(NOON_ISH.getTime() - HOUR));
  await run(s, NOON_ISH);
  const row = await rowOf(s.shopId, "drop", "sms");
  assert.equal(mock.sent.length, 1, "the mock holds exactly one copy");
  assert.equal(row.status, "SENT", `${row.status} ${row.error}`);
  assert.equal(row.providerId, mock.sent[0].sid, "SENT with the SID the mock recorded");
  assert.equal(row.tries, 1);
  ok("the mock records a text and drops the connection -> findSent finds it -> SENT with that SID, one copy");
}

async function twilioErrors() {
  reset();
  let s = await shopWith({ email: false, token: "not-the-secret" });
  let c = await customer(s.shopId, { phone: "+12125550111", notifyBy: "sms" });
  await notice(s.shopId, c, "badtoken", new Date(NOON_ISH.getTime() - HOUR));
  await run(s, NOON_ISH);
  let row = await rowOf(s.shopId, "badtoken", "sms");
  assert.equal(row.status, "QUEUED", `${row.status} ${row.error}`);
  const st = await settingsOf(s.shopId);
  assert.ok(st.smsPausedAt, "a wrong token pauses texts");
  assert.ok(st.smsError, "and says why");
  assert.equal(mock.sent.length, 0);
  ok("wrong Twilio token -> smsPausedAt set, rows still QUEUED");

  reset();
  s = await shopWith({ email: false });
  c = await customer(s.shopId, { name: "Opted", phone: "+12125550000", notifyBy: "sms" });
  await notice(s.shopId, c, "carrier", new Date(NOON_ISH.getTime() - HOUR));
  await run(s, NOON_ISH);
  row = await rowOf(s.shopId, "carrier", "sms");
  assert.equal(row.status, "FAILED", `${row.status} ${row.error}`);
  const sup = await db.suppression.findUnique({ where: { shopId_channel_address: { shopId: s.shopId, channel: "sms", address: "+12125550000" } } });
  assert.ok(sup, "21610 suppresses the number");
  assert.equal(sup.scope, "all");
  assert.equal(sup.source, "carrier");
  const ev = await db.consentEvent.findFirst({ where: { shopId: s.shopId, address: "+12125550000", event: "optout" } });
  assert.ok(ev, "and records a ConsentEvent");
  assert.equal(ev.source, "carrier");
  assert.equal(ev.customerId, c);
  assert.equal(mock.sent.length, 0, "the mock refused it");
  assert.equal((await settingsOf(s.shopId)).smsPausedAt, null, "one opted-out number doesn't pause texts");
  ok("21610 -> row FAILED + Suppression(sms, all, carrier) + ConsentEvent");
}

async function quietHoursAndCaps() {
  // A notice text due at 21:30 shop time waits for 09:00 the next day.
  reset();
  let s = await shopWith({ email: false });
  let c = await customer(s.shopId, { phone: "+12125550121", notifyBy: "sms" });
  const late = at(WED, "21:30");
  await notice(s.shopId, c, "late", new Date(late.getTime() - HOUR));
  await run(s, late);
  let row = await rowOf(s.shopId, "late", "sms");
  assert.equal(row.status, "QUEUED", `${row.status} ${row.error}`);
  assert.equal(+row.sendAfter, +at("2026-10-15", "09:00"), `sendAfter ${row.sendAfter.toISOString()}`);
  assert.equal(mock.sent.length, 0);
  await run(s, at("2026-10-15", "09:00"));
  assert.equal((await rowOf(s.shopId, "late", "sms")).status, "SENT", "and goes at 09:00");
  ok("a notice text due at 21:30 shop time gets sendAfter 09:00 next day");

  // Marketing to a Pacific number from an Eastern shop at 09:30 ET waits until 12:00 ET; then the frequency rules.
  reset();
  s = await shopWith({ email: false });
  const pacific = "+14155550123";
  c = await customer(s.shopId, { name: "Pat", phone: pacific, notifyBy: "sms", consent: true });
  const send = async (key: string, now: Date, rowSendAfter: Date) => {
    await marketing(s.shopId, c, key, "sms", rowSendAfter);
    await run(s, now);
    return rowOf(s.shopId, key, "sms");
  };
  row = await send("m1", at(WED, "09:30"), at(WED, "09:00"));
  assert.equal(row.status, "QUEUED", `${row.status} ${row.error}`);
  assert.equal(+row.sendAfter, +at(WED, "12:00"), `sendAfter ${row.sendAfter.toISOString()}: 09:00 Pacific is 12:00 Eastern`);
  assert.equal(mock.sent.length, 0);
  await run(s, at(WED, "12:00"));
  row = await rowOf(s.shopId, "m1", "sms");
  assert.equal(row.status, "SENT", `${row.status} ${row.error}`);
  assert.ok(mock.sent[0].body.endsWith("Reply STOP to opt out."), "marketing texts end with the STOP line");
  ok("a marketing text to a Pacific number from an Eastern shop at 09:30 ET waits until 12:00 ET");

  // A second marketing text to the same number within 24 h waits.
  row = await send("m2", at(WED, "12:05"), at(WED, "12:01"));
  assert.equal(row.status, "QUEUED", `${row.status} ${row.error}`);
  assert.equal(+row.sendAfter, +at(WED, "12:00") + DAY, `sendAfter ${row.sendAfter.toISOString()}: 24 h after the last one`);
  assert.equal(mock.sent.length, 1);
  ok("a second marketing text to the same number within 24 h waits");

  // ...a fifth in 30 days is skipped. Sends on Wed 13:00, Fri, Sat; the fifth on Monday (never Sunday).
  await run(s, at("2026-10-15", "13:00"));
  assert.equal((await rowOf(s.shopId, "m2", "sms")).status, "SENT", "the waiting one goes the next day");
  row = await send("m3", at("2026-10-16", "14:00"), at("2026-10-16", "12:00"));
  assert.equal(row.status, "SENT", `${row.status} ${row.error}`);
  row = await send("m4", at("2026-10-17", "15:00"), at("2026-10-17", "12:00"));
  assert.equal(row.status, "SENT", `${row.status} ${row.error}`);
  assert.equal(mock.sent.length, 4);
  row = await send("m5", at("2026-10-19", "14:00"), at("2026-10-19", "12:00"));
  assert.equal(row.status, "SKIPPED", `${row.status} ${row.error}`);
  assert.equal(row.error, SKIP_REASON_LABEL.too_often);
  assert.equal(mock.sent.length, 4, "no fifth text");
  ok("a fifth marketing text in 30 days -> SKIPPED too_often");

  // An unhandled reply from the number holds marketing texts: SKIPPED unread_reply.
  reset();
  s = await shopWith({ email: false });
  const number = "+14155550130";
  c = await customer(s.shopId, { name: "Chatty", phone: number, notifyBy: "sms", consent: true });
  await mock.inbound(number, s.from, "what time do you close?", new Date(NOON_ISH.getTime() - 30 * MIN));
  await marketing(s.shopId, c, "reply-held", "sms", new Date(NOON_ISH.getTime() - HOUR));
  await run(s, NOON_ISH);
  row = await rowOf(s.shopId, "reply-held", "sms");
  assert.equal(row.status, "SKIPPED", `${row.status} ${row.error}`);
  assert.equal(row.error, SKIP_REASON_LABEL.unread_reply);
  const inbound = await db.inboundText.findMany({ where: { shopId: s.shopId } });
  assert.equal(inbound.length, 1, "the reply was read and stored");
  assert.equal(inbound[0].keyword, null);
  assert.equal(inbound[0].handledAt, null);
  assert.equal(mock.sent.length, 0);
  ok("an unhandled reply from the number -> SKIPPED unread_reply");
  void row;
}

async function held() {
  // A company without Marketing: the base kinds (ready, parts in, estimate; pricing-review-2026-10.md, 7 Oct 2026) go
  // out; every other row stays QUEUED and is the held list.
  reset();
  const s = await shopWith({ modules: [] });
  const c = await customer(s.shopId, { name: "Held", phone: "+12125550141", email: "held@c.test", notifyBy: "both" });
  await notice(s.shopId, c, "held", new Date(NOON_ISH.getTime() - HOUR), "preferred", "class_notice");
  await notice(s.shopId, c, "base-ready", new Date(NOON_ISH.getTime() - HOUR));
  assert.deepEqual(await shopsWith("marketing", [s.shopId]), [], "no Marketing module");
  const r = await run(s, NOON_ISH);
  assert.deepEqual(r, { sent: 2, failed: 0, waiting: 0 }, "the ready notice goes by email and text without Marketing");
  assert.equal((await rowOf(s.shopId, "base-ready", "email")).status, "SENT");
  assert.equal((await rowOf(s.shopId, "base-ready", "sms")).status, "SENT");
  assert.equal(sink.messages.length, 1, "the ready email went");
  assert.equal(mock.sent.length, 1, "the ready text went");
  reset();
  const held = await db.outMessage.findMany({ where: { shopId: s.shopId, status: "QUEUED" } });
  assert.equal(held.length, 2, "both class-notice rows are held");
  for (const h of held) {
    assert.equal(h.tries, 0);
    assert.equal(h.error, null);
    assert.equal(h.claimedAt, null);
  }
  assert.equal(sink.messages.length, 0);
  assert.equal(mock.sent.length, 0);
  ok("a company without Marketing: the ready notice goes (base); its other rows stay QUEUED (held, untouched, listed by status QUEUED)");

  // Switching the module on releases them.
  await switchFeatures(s.shopId, ["marketing"]);
  assert.deepEqual(await shopsWith("marketing", [s.shopId]), [s.shopId], "Marketing is on now");
  await run(s, NOON_ISH);
  assert.equal(await db.outMessage.count({ where: { shopId: s.shopId, status: "SENT", kind: "class_notice" } }), 2, "held rows go once the module is on");
  ok("held rows go out once Marketing is switched on");
}

async function optOutWhileModuleOff() {
  reset();
  const s = await shopWith({ modules: [], email: false });
  const now = new Date();
  await db.messagingSettings.update({ where: { shopId: s.shopId }, data: { inboundAt: new Date(now.getTime() - 45 * DAY) } });
  const number = "+12125550140";
  const c = await customer(s.shopId, { name: "Leaving", phone: number, notifyBy: "sms" });
  await notice(s.shopId, c, "waiting", new Date(now.getTime() - HOUR));
  // The module has been off for 45 days; she texted on day 40 (five days ago).
  await mock.inbound(number, s.from, "please don't text me anymore", new Date(now.getTime() - 5 * DAY));
  assert.deepEqual(await shopsWith("marketing", [s.shopId]), []);
  await run(s, now);
  const sup = await db.suppression.findUnique({ where: { shopId_channel_address: { shopId: s.shopId, channel: "sms", address: number } } });
  assert.ok(sup, "the Suppression exists");
  assert.equal(sup.scope, "all");
  assert.equal(sup.source, "reply");
  const reply = await db.inboundText.findFirstOrThrow({ where: { shopId: s.shopId, fromNumber: number } });
  assert.equal(reply.keyword, "STOPLIKE");
  assert.ok(reply.handledAt);
  assert.equal(reply.customerId, c, "matched to the customer");
  assert.ok(await db.consentEvent.findFirst({ where: { shopId: s.shopId, address: number, event: "optout", source: "reply" } }), "a ConsentEvent records it");
  const w = await rowOf(s.shopId, "waiting", "sms");
  assert.equal(w.status, "CANCELLED", "the queued text is cancelled by the opt-out");
  assert.equal(mock.sent.length, 0, "nothing was sent");
  const st = await settingsOf(s.shopId);
  assert.ok(st.inboundAt && now.getTime() - st.inboundAt.getTime() < DAY, "the read watermark moved up to today");
  // Even with the module back on and a new text queued, the number can't be texted.
  await switchFeatures(s.shopId, ["marketing"]);
  const again = await queueToCustomer(db, { shopId: s.shopId, customerId: c, kind: "ready", channels: ["sms"], content: content("after"), dedupeKey: "after", sendAfter: new Date(now.getTime() - HOUR) });
  clearKick();
  assert.deepEqual(again.skipped, [{ channel: "sms", reason: "opted_out" }]);
  ok("no Marketing for 45 days, Twilio set up: a 'please don't text me anymore' reply from day 40 is read by messageRun() and the Suppression exists before any send");
}

async function textHold() {
  reset();
  const s = await shopWith({ email: false, settings: { inboundAt: new Date(NOON_ISH.getTime() - MIN) } });
  const cm = await customer(s.shopId, { name: "Marketing", phone: "+14155550150", notifyBy: "sms", consent: true });
  const cn = await customer(s.shopId, { name: "Notice", phone: "+12125550151", notifyBy: "sms" });
  await marketing(s.shopId, cm, "held-m", "sms", new Date(NOON_ISH.getTime() - HOUR));
  await notice(s.shopId, cn, "held-n", new Date(NOON_ISH.getTime() - HOUR));
  // Three reads that couldn't finish (the deadline has already passed).
  for (let i = 1; i <= 3; i++) {
    const cfg = await sendConfig(s.shopId);
    await pollReplies(cfg, NOON_ISH, Date.now() - 1);
    const st = await settingsOf(s.shopId);
    assert.equal(st.inboundIncomplete, i);
    if (i < 3) assert.equal(st.textHoldAt, null, `no hold after ${i} incomplete read(s)`);
  }
  let st = await settingsOf(s.shopId);
  assert.ok(st.textHoldAt, "three incomplete reads set textHoldAt");
  assert.equal(st.textHoldWhy, INCOMPLETE_HOLD);
  await run(s, NOON_ISH);
  assert.equal((await rowOf(s.shopId, "held-m", "sms")).status, "QUEUED", "marketing texts are held");
  assert.equal((await rowOf(s.shopId, "held-n", "sms")).status, "SENT", "notices still go");
  assert.equal(mock.sent.length, 1);
  // A complete read clears the hold.
  await pollReplies(await sendConfig(s.shopId), NOON_ISH, Date.now() + 20_000);
  st = await settingsOf(s.shopId);
  assert.equal(st.textHoldAt, null, "a complete read clears it");
  assert.equal(st.textHoldWhy, null);
  assert.equal(st.inboundIncomplete, 0);
  await run(s, NOON_ISH);
  assert.equal((await rowOf(s.shopId, "held-m", "sms")).status, "SENT", "and the marketing text goes");
  assert.equal(mock.sent.length, 2);
  ok("3 incomplete reply reads -> textHoldAt set, marketing texts held, notices still sent; a complete read clears it");
}

async function caps() {
  // Marketing email daily cap 2 with 5 rows.
  reset();
  let s = await shopWith({ sms: false, settings: { emailDailyCap: 2 } });
  for (let i = 0; i < 5; i++) {
    const c = await customer(s.shopId, { name: `Cap ${i}`, email: `cap${i}@m.test`, notifyBy: "email" });
    await marketing(s.shopId, c, `cap${i}`, "email", new Date(NOON_ISH.getTime() - HOUR + i * 1000));
  }
  const r = await run(s, NOON_ISH);
  assert.equal(r.sent, 2);
  assert.equal(sink.messages.length, 2, "two went out");
  const rows = await db.outMessage.findMany({ where: { shopId: s.shopId }, orderBy: { sendAfter: "asc" } });
  assert.deepEqual(rows.map((x) => x.status), ["SENT", "SENT", "QUEUED", "QUEUED", "QUEUED"]);
  const tomorrow = zonedTime(addDays(ymdOf(NOON_ISH, NY), 1), 540, NY);
  for (const q of rows.slice(2)) assert.equal(+q.sendAfter, +tomorrow, `moved to ${tomorrow.toISOString()} (next shop-day at quietStart), got ${q.sendAfter.toISOString()}`);
  const head = sink.messages[0].raw.replace(/\r\n[ \t]+/g, " "); // headers unfolded
  assert.ok(head.includes("This is an advertisement from"), "marketing email carries the advertisement footer");
  assert.ok(head.includes("1 Main St, Springfield"), "and the postal address");
  assert.match(head, /List-Unsubscribe: <mailto:replies@stitchbench\.test\?subject=unsubscribe%20[\w-]{22}>/, "and a List-Unsubscribe header");
  assert.ok(!/List-Unsubscribe-Post/i.test(head), "no one-click header without a public link");
  ok("marketing email daily cap 2 with 5 rows: 2 sent, 3 moved to the next shop-day at quietStart");

  // A marketing row whose sendAfter is 49 h old is not sent until releaseHeld.
  reset();
  s = await shopWith({ sms: false });
  const c = await customer(s.shopId, { name: "Stale", email: "stale@m.test", notifyBy: "email" });
  const now = new Date();
  await marketing(s.shopId, c, "stale", "email", new Date(now.getTime() - 49 * HOUR));
  await run(s, now);
  let row = await rowOf(s.shopId, "stale", "email");
  assert.equal(row.status, "QUEUED", `${row.status} ${row.error}`);
  assert.equal(sink.messages.length, 0, "a marketing message that waited more than 48 h needs a person");
  // releaseHeld is a server action (it needs a signed-in admin); this is its update, with its filter.
  const released = await db.outMessage.updateMany({ where: { shopId: s.shopId, purpose: "marketing", status: "QUEUED", sendAfter: { lt: new Date(Date.now() - 48 * HOUR) } }, data: { sendAfter: new Date(), nextTryAt: null } });
  assert.equal(released.count, 1);
  await run(s, new Date(Date.now() + 1000));
  row = await rowOf(s.shopId, "stale", "email");
  assert.equal(row.status, "SENT", `${row.status} ${row.error}`);
  assert.equal(sink.messages.length, 1);
  ok("a marketing row whose sendAfter is 49 h old is not sent until releaseHeld");
}

async function recovery() {
  reset();
  // Held shop: recovery and tidy run for every shop, module or not; nothing is sent here.
  const s = await shopWith({ modules: [] });
  const now = new Date();
  const stale = new Date(now.getTime() - 5 * MIN);
  const base = { shopId: s.shopId, channel: "email", address: "recover@c.test", subject: "S", body: "B", status: "SENDING", claimedAt: stale, tries: 1 } as const;
  const make = (o: { purpose: string; kind: string; retryTries?: number }) => db.outMessage.create({ data: { ...base, retryTries: 0, ...o } });
  // class_notice: a notice that needs Marketing, so the recovered row stays QUEUED here (a ready one would now go).
  const notice1 = await make({ purpose: "notice", kind: "class_notice" });
  const notice2 = await make({ purpose: "notice", kind: "class_notice", retryTries: 1 });
  const market = await make({ purpose: "marketing", kind: "campaign" });
  const test = await make({ purpose: "notice", kind: "test" });
  const fresh = await db.outMessage.create({ data: { ...base, purpose: "notice", kind: "class_notice", claimedAt: new Date(now.getTime() - 30_000) } });
  await run(s, now);
  const a = await rowById(notice1.id);
  assert.equal(a.status, "QUEUED", `${a.status} ${a.error}`);
  assert.equal(a.retryTries, 1);
  assert.equal(a.error, "Interrupted; sending once more");
  assert.equal(a.claimedAt, null);
  const b = await rowById(notice2.id);
  assert.equal(b.status, "FAILED");
  assert.equal(b.error, "Interrupted twice; not sent again in case it went out");
  const m = await rowById(market.id);
  assert.equal(m.status, "FAILED");
  assert.equal(m.error, "Interrupted while sending; not sent again in case it went out");
  const t = await rowById(test.id);
  assert.equal(t.status, "FAILED");
  assert.equal(t.error, "Test interrupted");
  assert.equal((await rowById(fresh.id)).status, "SENDING", "a claim under 2 minutes old is left alone");
  ok("a SENDING row older than 2 min is recovered (notice -> QUEUED once, then FAILED; marketing -> FAILED; test -> FAILED)");

  // Test rows inserted as SENDING (queueToAddress) are never picked up by the worker.
  reset();
  const live = await shopWith({ sms: false });
  const q = await queueToAddress(db, { shopId: live.shopId, kind: "test", channel: "email", address: "me@c.test", content: { subject: "Test", body: "Hello" }, status: "SENDING" });
  clearKick();
  assert.ok(q.id, "test row queued");
  const r = await run(live, new Date());
  assert.deepEqual(r, { sent: 0, failed: 0, waiting: 0 });
  const row = await rowById(q.id);
  assert.equal(row.status, "SENDING", "the worker leaves a test row to sendOneNow");
  assert.equal(sink.messages.length, 0);
  const sent = await sendOneNow(q.id);
  assert.ok("ok" in sent, JSON.stringify(sent));
  assert.equal((await rowById(q.id)).status, "SENT", "sendOneNow sends it on its own");
  assert.equal(sink.messages.length, 1);
  ok("rows inserted with status SENDING (tests) are never picked up by the worker; sendOneNow sends them");
}

async function estimate() {
  reset();
  const s = await shopWith({ email: false });
  const prior = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = "http://127.0.0.1:39999";
  try {
    const c = await customer(s.shopId, { name: "Estimate", phone: "+12125550160", notifyBy: "sms" });
    const token = crypto.randomBytes(24).toString("base64url");
    const linkId = `chk${crypto.randomBytes(10).toString("hex")}`;
    const masked = `http://127.0.0.1:39999/e/•••${token.slice(-4)}`;
    await db.estimateLink.create({
      data: {
        id: linkId,
        shopId: s.shopId,
        tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
        tokenSealed: seal(token, s.shopId, `estimateToken:${linkId}`),
        maskedUrl: masked,
        customerId: c,
        totalCents: 14500,
        lines: [{ description: "Clean and oil", amountCents: 14500 }],
        expiresAt: new Date(NOON_ISH.getTime() + 7 * DAY),
      },
    });
    const r = await queueToCustomer(db, {
      shopId: s.shopId,
      customerId: c,
      kind: "estimate",
      channels: ["sms"],
      content: () => ({ body: `The estimate is $145.00. See it here: ${masked}` }),
      dedupeKey: "estimate-1",
      refType: "estimate",
      refId: linkId,
      sendAfter: new Date(NOON_ISH.getTime() - HOUR),
    });
    clearKick();
    assert.equal(r.queued.length, 1);
    await run(s, NOON_ISH);
    const row = await rowOf(s.shopId, "estimate-1", "sms");
    assert.equal(row.status, "SENT", `${row.status} ${row.error}`);
    assert.equal(mock.sent.length, 1);
    assert.ok(mock.sent[0].body.includes(`http://127.0.0.1:39999/e/${token}`), `the text carries the real link: ${mock.sent[0].body}`);
    assert.ok(!mock.sent[0].body.includes("•"), "no mask in the text that went out");
    assert.ok(row.body.includes(masked), "the stored body keeps the masked link");
    assert.ok(!row.body.includes(token), "and never the token");
    const link = await db.estimateLink.findUniqueOrThrow({ where: { id: linkId } });
    assert.equal(link.tokenSealed, null, "tokenSealed is cleared once nothing waits to carry it");
  } finally {
    if (prior === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = prior;
  }
  ok("an estimate row: the text carries /e/<token>, the stored body keeps the mask, tokenSealed is null after the run");
}

async function leases() {
  const host = os.hostname();
  const other = `${host}:${process.pid + 1}`;
  const names = { stale: `chk-stale-${Date.now().toString(36)}`, mine: `chk-mine-${Date.now().toString(36)}`, foreign: `chk-foreign-${Date.now().toString(36)}` };
  const until = new Date(Date.now() + HOUR);
  try {
    await db.$executeRaw`INSERT INTO "JobLease" (name, holder, until) VALUES (${names.stale}, ${other}, ${until})`;
    await db.$executeRaw`INSERT INTO "JobLease" (name, holder, until) VALUES (${names.mine}, ${LEASE_HOLDER}, ${until})`;
    await db.$executeRaw`INSERT INTO "JobLease" (name, holder, until) VALUES (${names.foreign}, ${"another-host:" + process.pid}, ${until})`;
    await clearStaleOwnLeases();
    const left = await db.$queryRaw<{ name: string }[]>`SELECT name FROM "JobLease" WHERE name IN (${names.stale}, ${names.mine}, ${names.foreign})`;
    const have = new Set(left.map((l) => l.name));
    assert.ok(!have.has(names.stale), `a lease held by ${other} is removed`);
    assert.ok(have.has(names.mine), "this process's own lease stays");
    assert.ok(have.has(names.foreign), "another host's lease stays");
  } finally {
    await db.$executeRaw`DELETE FROM "JobLease" WHERE name IN (${names.stale}, ${names.mine}, ${names.foreign})`;
  }
  ok("clearStaleOwnLeases() removes a lease held by <hostname>:<other pid> (and only that)");
}

async function main() {
  const t0 = Date.now();
  delete process.env.MESSAGES;
  try {
    sink = await withSink();
    mock = await withMock();
    await messagesOff();
    await deliveryAndRace();
    await sinkStopped();
    await smtpAnswers();
    await ambiguous();
    await twilioErrors();
    await quietHoursAndCaps();
    await held();
    await optOutWhileModuleOff();
    await textHold();
    await caps();
    await recovery();
    await estimate();
    await leases();
    console.log(`worker.check: ${steps} groups passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  clearKick();
  setTimeout(() => process.exit(1), 100).unref();
});
