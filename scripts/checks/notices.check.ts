// The automatic notices against the database (scheduling-messaging-design.md section 9, notices acceptance item 3):
// ready, retail "it's back", reminders, uncollected-machine notices, service due, review requests and stillWanted. A
// company with Marketing and one without; clocks are injected. Sink and mock run in this process; every scenario has its
// own throwaway company "Check <run> ..." (all removed at the end).
//   npm run check scripts/checks/notices.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { OutMessage, Ticket } from "@/generated/prisma/client";
import type { TicketStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { changeTicketStatus } from "@/lib/ticket-status";
import { messageRun, type MessageRunResult } from "@/lib/messaging/worker";
import { clearKick, checkShop, cleanup, linkPair, messagingFor, withMock, withSink, type CheckShop, type MessagingOverrides } from "./lib";
import { expectNotFound, assertUnchanged, snapshot } from "./tenant";
import { hookContext } from "@/lib/notices/context";
import { onJobStatus, recordBack, recordManual, sendNow, stillWanted } from "@/lib/notices/hooks";
import { abandonStages, stageKey } from "@/lib/notices/abandon";
import { runSchedulers } from "@/lib/notices/scheduler";
import { scheduleFor, stageRows } from "@/lib/notices/vars";
import { moduleOn, requireOn } from "@/lib/module-gate";
import { addDays, zonedTime } from "@/lib/zoned";

const NY = "America/New_York";
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (ymd: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return zonedTime(ymd, h * 60 + m, NY);
};

let steps = 0;
const ok = (label: string) => {
  steps += 1;
  console.log(`  ok  ${label}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fromCounter = 0;
const nextFrom = () => `+1212555${String(3100 + fromCounter++)}`;
let phoneCounter = 0;
const nextPhone = () => `+1212556${String(1000 + phoneCounter++)}`;
let emailCounter = 0;
const nextEmail = () => `n${emailCounter++}-${Date.now().toString(36)}@a.test`;
let ticketNumber = 100;
let saleNumber = 5000;
let modelCounter = 0;

type Shop = CheckShop & { from: string };

async function shopWith(o: { marketing?: boolean; settings?: MessagingOverrides; retail?: boolean } = {}): Promise<Shop> {
  const s = await checkShop({ retail: o.retail ?? true, repair: true, modules: o.marketing === false ? [] : ["marketing"], tz: NY });
  const from = nextFrom();
  await messagingFor(s.shopId, { email: true, sms: { from }, settings: o.settings });
  return { ...s, from };
}
const setMs = (shopId: string, data: Record<string, unknown>) => db.messagingSettings.update({ where: { shopId }, data: data as never });

async function customer(shopId: string, o: { name?: string; notifyBy?: string; phone?: string | null; email?: string | null; kind?: "RETAIL" | "TRADE" } = {}) {
  return (
    await db.customer.create({
      data: {
        shopId,
        name: o.name ?? "Mary Smith",
        kind: o.kind ?? "RETAIL",
        notifyBy: o.notifyBy ?? "both",
        phone: o.phone === undefined ? nextPhone() : o.phone,
        email: o.email === undefined ? nextEmail() : o.email,
        address: "12 Elm St\nSpringfield",
      },
    })
  ).id;
}

async function machine(shopId: string, customerId: string | null, o: { brand?: string; model?: string; equipment?: string } = {}) {
  const model = o.model ?? `M${modelCounter++}X`;
  return (await db.machine.create({ data: { shopId, brand: o.brand ?? "Janome", model, modelKey: model.toUpperCase(), customerId, equipment: o.equipment ?? "SEWING" } })).id;
}

type TicketOpts = { customerId?: string | null; via?: string | null; status?: TicketStatus; jobType?: string; machineId?: string; pickupReadyAt?: Date | null; closedAt?: Date | null; intakeAt?: Date; brand?: string; model?: string; equipment?: string };
async function ticket(shopId: string, o: TicketOpts = {}) {
  const machineId = o.machineId ?? (await machine(shopId, o.customerId ?? null, { brand: o.brand, model: o.model, equipment: o.equipment }));
  const t = await db.ticket.create({
    data: {
      shopId,
      number: ticketNumber++,
      machineId,
      customerId: o.customerId ?? null,
      viaAccountId: o.via ?? null,
      status: o.status ?? "ON_BENCH",
      jobType: o.jobType ?? "BENCH",
      pickupReadyAt: o.pickupReadyAt ?? null,
      closedAt: o.closedAt ?? null,
      ...(o.intakeAt ? { intakeAt: o.intakeAt } : {}),
    },
  });
  return t.id;
}

/** changeTicketStatus as setStatus runs it: the ticket read first, the hook context before the transaction. */
async function change(shopId: string, ticketId: string, status: TicketStatus, when: Date, stale?: Ticket) {
  const t = stale ?? (await db.ticket.findFirstOrThrow({ where: { id: ticketId, shopId } }));
  const ctx = await hookContext(shopId, "Check");
  const r = await db.$transaction((tx) => changeTicketStatus(tx, t, status, when, 90, ctx));
  clearKick();
  return r;
}

async function job(shopId: string, linkId: string, o: { customerId: string | null; status?: string; tag?: string; backAt?: Date | null; pickedUpAt?: Date | null; totalCents?: number | null }) {
  const id = `chkjob${crypto.randomBytes(8).toString("hex")}`;
  await db.repairJob.create({
    data: {
      id,
      shopId,
      linkId,
      side: "retail",
      tag: o.tag ?? String(100 + modelCounter++),
      status: o.status ?? "READY_FOR_PICKUP",
      customerId: o.customerId,
      customerName: "Mary S.",
      brand: "Bernina",
      model: `B${modelCounter++}`,
      backAt: o.backAt ?? null,
      pickedUpAt: o.pickedUpAt ?? null,
      totalCents: o.totalCents ?? null,
    },
  });
  return id;
}

const rowsOf = (shopId: string, where: Record<string, unknown>) => db.outMessage.findMany({ where: { shopId, ...where } as never, orderBy: [{ createdAt: "asc" }, { channel: "asc" }] });

async function run(shopId: string, now: Date): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const r: MessageRunResult = await messageRun({ now, shopIds: [shopId] });
    if ("busy" in r) {
      await sleep(500);
      continue;
    }
    return;
  }
  throw new Error("messageRun stayed busy for a minute: another process holds the lease");
}

// ---------------------------------------------------------------------------------------------------------------

async function ready(m: Shop, n: Shop) {
  const T0 = at("2026-10-14", "10:42");
  const mary = await customer(m.shopId, { notifyBy: "both" });
  const t1 = await ticket(m.shopId, { customerId: mary, status: "ON_BENCH" });

  const r1 = await change(m.shopId, t1, "READY_FOR_PICKUP", T0);
  assert.ok(r1.changed);
  const rows = await rowsOf(m.shopId, { ticketId: t1, kind: "ready" });
  assert.deepEqual(rows.map((r) => r.channel).sort(), ["email", "sms"], "one ready row per allowed channel");
  for (const r of rows) {
    assert.equal(r.status, "QUEUED");
    assert.equal(+r.sendAfter, +T0 + 120_000, "sendAfter = the status change + READY_NOTICE_DELAY_SECONDS");
    assert.equal(r.purpose, "notice");
  }
  assert.match(r1.note ?? "", /^Ready\. A text and an email go to Mary Smith at 10:44 am\. Change the status back before then to stop it\.$/, `toast: ${r1.note}`);

  // Back to the bench: waiting rows are cancelled.
  await change(m.shopId, t1, "ON_BENCH", new Date(+T0 + 30_000));
  const cancelled = await rowsOf(m.shopId, { ticketId: t1, kind: "ready" });
  assert.ok(cancelled.every((r) => r.status === "CANCELLED" && /moved on/.test(r.error ?? "")), JSON.stringify(cancelled.map((r) => [r.status, r.error])));

  // Ready again a week later: a new pickupReadyAt, so a new key and a new row per channel.
  const T1 = new Date(+T0 + 7 * DAY);
  const r2 = await change(m.shopId, t1, "READY_FOR_PICKUP", T1);
  const all = await rowsOf(m.shopId, { ticketId: t1, kind: "ready" });
  assert.equal(all.length, 4, "a NEW row per channel for the second ready call");
  assert.equal(all.filter((r) => r.status === "QUEUED").length, 2);
  assert.equal(new Set(all.map((r) => r.dedupeKey)).size, 4);
  assert.match(r2.note ?? "", /^Ready\. A text and an email go to Mary Smith at /);

  // A double call with the same stale ticket: one row.
  const em = await customer(m.shopId, { name: "Ed Email", notifyBy: "email" });
  const t2 = await ticket(m.shopId, { customerId: em });
  const stale = await db.ticket.findFirstOrThrow({ where: { id: t2, shopId: m.shopId } });
  const [a, b] = [await change(m.shopId, t2, "READY_FOR_PICKUP", T0, stale), await change(m.shopId, t2, "READY_FOR_PICKUP", T0, stale)];
  assert.ok(a.changed && !b.changed, "the second call with the stale ticket changes nothing");
  assert.match(a.note ?? "", /^Ready\. An email goes to Ed Email at /);
  assert.equal((await rowsOf(m.shopId, { ticketId: t2, kind: "ready" })).length, 1, "a double call of changeTicketStatus -> one row");

  // Trade account, partner and SITE tickets: nothing.
  const trade = await customer(m.shopId, { name: "Quilt Shop", kind: "TRADE", notifyBy: "email" });
  const tTrade = await ticket(m.shopId, { customerId: mary, via: trade });
  const rTrade = await change(m.shopId, tTrade, "READY_FOR_PICKUP", T0);
  assert.equal(rTrade.note, null);
  const tPartner = await ticket(m.shopId, { customerId: mary });
  await db.repairJob.create({ data: { id: `chkp${crypto.randomBytes(6).toString("hex")}`, shopId: m.shopId, linkId: "x", side: "repair", tag: "9", customerName: "Mary S.", brand: "A", model: "B", ticketId: tPartner } });
  const rPartner = await change(m.shopId, tPartner, "READY_FOR_PICKUP", T0);
  assert.equal(rPartner.note, null);
  const tSite = await ticket(m.shopId, { customerId: mary, jobType: "SITE" });
  const rSite = await change(m.shopId, tSite, "READY_FOR_PICKUP", T0);
  assert.equal(rSite.note, null);
  assert.equal(await db.outMessage.count({ where: { shopId: m.shopId, ticketId: { in: [tTrade, tPartner, tSite] } } }), 0, "trade-account, partner and SITE tickets -> nothing");

  // Nothing queued and why: the toast names the reason and tells staff to call.
  const nomail = await customer(m.shopId, { name: "Nora None", notifyBy: "", email: null, phone: "+12125557777" });
  const t3 = await ticket(m.shopId, { customerId: nomail });
  const r3 = await change(m.shopId, t3, "READY_FOR_PICKUP", T0);
  assert.match(r3.note ?? "", /^Ready\. No message: no email or mobile number on file\. Call Nora at \(212\) 555-7777\.$/, `toast: ${r3.note}`);

  // Switch off: nothing and no toast line (the status still changes).
  await setMs(m.shopId, { readyNotice: false });
  const t4 = await ticket(m.shopId, { customerId: mary });
  const r4 = await change(m.shopId, t4, "READY_FOR_PICKUP", T0);
  assert.equal(r4.note, null);
  assert.equal(await db.outMessage.count({ where: { shopId: m.shopId, ticketId: t4 } }), 0);
  await setMs(m.shopId, { readyNotice: true });

  // The company without Marketing: nothing and no toast line.
  const cn = await customer(n.shopId, { notifyBy: "both" });
  const tn = await ticket(n.shopId, { customerId: cn });
  await messagingFor(n.shopId, { email: true, sms: { from: n.from } });
  const rn = await change(n.shopId, tn, "READY_FOR_PICKUP", T0);
  assert.equal(rn.note, null);
  assert.equal(await db.outMessage.count({ where: { shopId: n.shopId, ticketId: tn } }), 0, "the company without Marketing queues nothing");
  // ... but leaving the shelf still cancels (here: nothing queued to cancel; the call must not fail).
  await change(n.shopId, tn, "ON_BENCH", T0);
  ok("ready: one row per channel with sendAfter +delay and the toast line; back to the bench cancels; ready again a week later -> new rows; a double call -> one row; trade / partner / SITE / switch off / no Marketing -> nothing");
}

async function retail(m: Shop, n: Shop, linkId: string, nLinkId: string) {
  const T = at("2026-10-14", "11:00");
  const ctx = await hookContext(m.shopId, "Check");
  const c1 = await customer(m.shopId, { name: "Rita Retail", notifyBy: "email" });
  const j1 = await job(m.shopId, linkId, { customerId: c1, status: "ON_BENCH" });

  // The repair shop says it's ready: nothing goes out.
  await db.repairJob.updateMany({ where: { shopId: m.shopId, id: j1 }, data: { status: "READY_FOR_PICKUP" } });
  await db.$transaction((tx) => onJobStatus(tx, { id: j1, shopId: m.shopId, linkId, customerId: c1, status: "READY_FOR_PICKUP", backAt: null, pickedUpAt: null }, "READY_FOR_PICKUP", T, ctx));
  assert.equal(await db.outMessage.count({ where: { shopId: m.shopId, repairJobId: j1 } }), 0, "onJobStatus to a ready state sends nothing");

  // "It's back": one row, sent now; a second call is refused.
  const back1 = await recordBack(m.user, [j1], { single: true, now: T });
  clearKick();
  assert.match(back1.note, /^Recorded\. Emails go to 1 customer now\.$/, back1.note);
  assert.equal(back1.callThem, false, "nothing for staff to do");
  const rows = await rowsOf(m.shopId, { repairJobId: j1, kind: "ready" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, "email");
  assert.equal(+rows[0].sendAfter, +T, "a person confirmed it is here: no delay");
  assert.equal(rows[0].dedupeKey?.startsWith(`ready:j:${j1}:`), true);
  const j = await db.repairJob.findUniqueOrThrow({ where: { shopId_id: { shopId: m.shopId, id: j1 } } });
  assert.equal(+j.backAt!, +T);
  assert.ok((j.events as { note?: string }[]).some((e) => /Back at the counter \(/.test(e.note ?? "")), "a job event says who");
  await assert.rejects(recordBack(m.user, [j1], { single: true, now: T }), (e: unknown) => isUserError(e) && /^Already recorded\.$/.test((e as Error).message));
  assert.equal(await db.outMessage.count({ where: { shopId: m.shopId, repairJobId: j1 } }), 1, "no second row");
  // Not back from the repair shop yet / picked up.
  const jBench = await job(m.shopId, linkId, { customerId: c1, status: "ON_BENCH" });
  await assert.rejects(recordBack(m.user, [jBench], { single: true, now: T }), (e: unknown) => isUserError(e) && /isn't back from the repair shop yet/.test((e as Error).message));

  // markManyBack with 3 jobs -> 3 rows.
  const three: string[] = [];
  for (let i = 0; i < 3; i++) three.push(await job(m.shopId, linkId, { customerId: await customer(m.shopId, { name: `Cust ${i}`, notifyBy: "email" }), status: i === 2 ? "READY_IN_TRUCK" : "READY_FOR_PICKUP" }));
  const noAddr = await job(m.shopId, linkId, { customerId: await customer(m.shopId, { name: "No Address", notifyBy: "email", email: null }) });
  const many = await recordBack(m.user, [...three, noAddr, j1], { single: false, now: T });
  clearKick();
  assert.match(many.note, /^Recorded\. Emails go to 3 customers now; 1 has no mobile number or email: call them\.$/, many.note);
  assert.equal(many.callThem, true, "someone must be called: shown as a warning");
  assert.equal(await db.outMessage.count({ where: { shopId: m.shopId, repairJobId: { in: three }, kind: "ready", status: "QUEUED" } }), 3, "3 jobs -> 3 rows");
  assert.equal((await db.repairJob.findMany({ where: { shopId: m.shopId, id: { in: [...three, noAddr] }, backAt: { not: null } } })).length, 4);
  await assert.rejects(recordBack(m.user, [j1, ...three], { single: false, now: T }), (e: unknown) => isUserError(e) && /Nothing to record/.test((e as Error).message));

  // The job moves on (back to the repair shop): its waiting rows are cancelled.
  await db.$transaction((tx) => onJobStatus(tx, { id: three[0], shopId: m.shopId, linkId, customerId: null, status: "ON_BENCH", backAt: null, pickedUpAt: null }, "ON_BENCH", T, ctx));
  assert.equal((await rowsOf(m.shopId, { repairJobId: three[0], kind: "ready" }))[0].status, "CANCELLED");
  assert.equal((await rowsOf(m.shopId, { repairJobId: three[1], kind: "ready" }))[0].status, "QUEUED", "other jobs' rows are left alone");

  // Messages off: only backAt is recorded.
  const cn = await customer(n.shopId, { notifyBy: "email" });
  const jn = await job(n.shopId, nLinkId, { customerId: cn });
  const noteOff = await recordBack(n.user, [jn], { single: true, now: T });
  assert.equal(noteOff.note, "Recorded. Messages are off: call the customer.");
  assert.equal(noteOff.callThem, true, "Messages off: the toast is a warning, not an error and not a quiet Recorded");
  assert.equal(await db.outMessage.count({ where: { shopId: n.shopId } }), 0, "no message without Marketing");
  assert.ok((await db.repairJob.findUniqueOrThrow({ where: { shopId_id: { shopId: n.shopId, id: jn } } })).backAt, "backAt is recorded without Marketing");
  ok("retail: ready state sends nothing; \"It's back\" -> one row, a second call -> \"Already recorded.\"; 3 jobs -> 3 rows; leaving the counter cancels; Messages off only records backAt");
}

async function reminders(m: Shop, n: Shop) {
  const NOW = at("2026-10-14", "09:00"); // Wed
  const tomorrow = "2026-10-15";
  const start = at(tomorrow, "18:00");
  const cls = await db.shopClass.create({ data: { shopId: m.shopId, title: "Beginning Quilting", location: "Back room", supplies: "Rotary cutter", seats: 8, remind: "every", status: "OPEN" } });
  const meeting = await db.classMeeting.create({ data: { shopId: m.shopId, classId: cls.id, startsAt: start, endsAt: new Date(+start + 2 * HOUR) } });
  const a = await customer(m.shopId, { name: "Ann Enrolled", notifyBy: "email" });
  const b = await customer(m.shopId, { name: "Bea Enrolled", notifyBy: "email" });
  const late = await customer(m.shopId, { name: "Lee Late", notifyBy: "email" });
  const cancelledE = await customer(m.shopId, { name: "Cy Cancelled", notifyBy: "email" });
  const en = (customerId: string, extra: Record<string, unknown> = {}) => db.enrollment.create({ data: { shopId: m.shopId, classId: cls.id, customerId, name: "x", feeCents: 0, status: "ENROLLED", ...extra } as never });
  const eA = await en(a);
  const eB = await en(b, { attendee: "Her daughter" });
  await en(late, { createdAt: new Date(+start - 10 * HOUR) }); // signed up 10 h before: staff just told them
  await en(cancelledE, { status: "CANCELLED" });

  await runSchedulers(NOW, [m.shopId]);
  clearKick();
  const rems = await rowsOf(m.shopId, { kind: "reminder", refType: "meeting" });
  assert.equal(rems.length, 2, `a meeting tomorrow queues one per enrolled customer, not for the late sign-up: ${rems.length}`);
  assert.deepEqual(new Set(rems.map((r) => r.customerId)), new Set([a, b]));
  for (const r of rems) {
    assert.equal(r.status, "QUEUED");
    assert.equal(r.refId, meeting.id);
    assert.equal(+r.sendAfter, +at("2026-10-14", "10:00"), "tomorrow's items go at reminderHour today");
    assert.equal(+r.notAfter!, +start - 2 * HOUR);
    assert.ok(r.dedupeKey?.startsWith(`remind:m:${meeting.id}:`) && r.dedupeKey.includes(`:${+start}:`), r.dedupeKey ?? "");
    assert.doesNotMatch(r.body, /tomorrow/i, "nothing says tomorrow");
    assert.match(r.body, /Beginning Quilting/);
  }
  const bBody = rems.find((r) => r.customerId === b)!.body;
  assert.match(bBody, /Beginning Quilting for Her daughter/);
  assert.match(bBody, /Thu, Oct 15 at 6:00 pm/);
  assert.match(bBody, /Back room/);
  assert.equal(rems.find((r) => r.customerId === a)!.dedupeKey?.includes(eA.id), true);
  assert.equal(rems.find((r) => r.customerId === b)!.dedupeKey?.includes(eB.id), true);

  // A second run queues nothing.
  await runSchedulers(new Date(+NOW + 10 * MIN), [m.shopId]);
  assert.equal((await rowsOf(m.shopId, { kind: "reminder" })).length, 2, "a second scheduler run queues nothing");

  // remind "first": only the class's first meeting. Class F's first meeting was yesterday; tomorrow's is its second.
  const first = await db.shopClass.create({ data: { shopId: m.shopId, title: "Garment Sewing", seats: 8, remind: "first", status: "OPEN" } });
  await db.classMeeting.create({ data: { shopId: m.shopId, classId: first.id, startsAt: at("2026-10-13", "18:00"), endsAt: at("2026-10-13", "20:00") } });
  const second = await db.classMeeting.create({ data: { shopId: m.shopId, classId: first.id, startsAt: at(tomorrow, "18:00"), endsAt: at(tomorrow, "20:00") } });
  const f = await customer(m.shopId, { name: "Fay First", notifyBy: "email" });
  await db.enrollment.create({ data: { shopId: m.shopId, classId: first.id, customerId: f, name: "Fay", feeCents: 0, status: "ENROLLED" } });
  const only = await db.shopClass.create({ data: { shopId: m.shopId, title: "Knitting", seats: 8, remind: "first", status: "OPEN" } });
  const onlyM = await db.classMeeting.create({ data: { shopId: m.shopId, classId: only.id, startsAt: at(tomorrow, "11:00"), endsAt: at(tomorrow, "12:00") } });
  await db.classMeeting.create({ data: { shopId: m.shopId, classId: only.id, startsAt: at("2026-10-22", "11:00"), endsAt: at("2026-10-22", "12:00") } });
  await db.enrollment.create({ data: { shopId: m.shopId, classId: only.id, customerId: f, name: "Fay", feeCents: 0, status: "ENROLLED" } });
  const never = await db.shopClass.create({ data: { shopId: m.shopId, title: "Never", seats: 8, remind: "never", status: "OPEN" } });
  await db.classMeeting.create({ data: { shopId: m.shopId, classId: never.id, startsAt: at(tomorrow, "13:00"), endsAt: at(tomorrow, "14:00") } });
  await db.enrollment.create({ data: { shopId: m.shopId, classId: never.id, customerId: f, name: "Fay", feeCents: 0, status: "ENROLLED" } });
  await runSchedulers(new Date(+NOW + 20 * MIN), [m.shopId]);
  clearKick();
  assert.equal((await rowsOf(m.shopId, { kind: "reminder", refId: second.id })).length, 0, "remind first: the second meeting isn't reminded");
  assert.equal((await rowsOf(m.shopId, { kind: "reminder", refId: onlyM.id })).length, 1, "remind first: the first meeting is");
  assert.equal((await rowsOf(m.shopId, { kind: "reminder", customerId: f })).length, 1, "remind never: nothing");

  // An appointment tomorrow (and a blocked one).
  const appt = await db.appointment.create({ data: { shopId: m.shopId, customerId: a, name: "Ann", title: "Longarm rental", startsAt: at(tomorrow, "15:00"), endsAt: at(tomorrow, "16:00"), status: "BOOKED" } });
  await db.appointment.create({ data: { shopId: m.shopId, name: "", title: "Blocked", blocked: true, startsAt: at(tomorrow, "09:00"), endsAt: at(tomorrow, "10:00"), status: "BOOKED" } });
  await runSchedulers(new Date(+NOW + 30 * MIN), [m.shopId]);
  clearKick();
  const ar = await rowsOf(m.shopId, { kind: "reminder", refType: "appointment" });
  assert.equal(ar.length, 1);
  assert.equal(ar[0].refId, appt.id);
  assert.match(ar[0].body, /Longarm rental/);

  // Moving the meeting: the old row is cancelled by stillWanted, a fresh one is queued.
  const moved = at(tomorrow, "19:00");
  await db.classMeeting.update({ where: { id: meeting.id }, data: { startsAt: moved, endsAt: new Date(+moved + 2 * HOUR) } });
  const old = (await rowsOf(m.shopId, { kind: "reminder", refId: meeting.id }))[0];
  assert.equal(await stillWanted(old), "The time changed");
  await runSchedulers(new Date(+NOW + 40 * MIN), [m.shopId]);
  clearKick();
  const afterMove = await rowsOf(m.shopId, { kind: "reminder", refId: meeting.id });
  assert.equal(afterMove.length, 4, "a moved meeting gets fresh reminders for each enrolled customer");
  await run(m.shopId, at("2026-10-14", "10:05"));
  clearKick();
  const oldNow = await db.outMessage.findUniqueOrThrow({ where: { id: old.id } });
  assert.equal(oldNow.status, "CANCELLED");
  assert.equal(oldNow.error, "The time changed", "cancelled by stillWanted when the worker came to it");
  const fresh = afterMove.filter((r) => r.dedupeKey?.includes(`:${+moved}:`));
  assert.equal(fresh.length, 2);
  for (const r of fresh) assert.equal((await db.outMessage.findUniqueOrThrow({ where: { id: r.id } })).status, "SENT", "the new reminders go out");

  // The booking changed: meeting cancelled, enrollment cancelled, appointment cancelled.
  const toCheck = (await rowsOf(m.shopId, { kind: "reminder", refId: meeting.id })).find((r) => r.dedupeKey?.includes(`:${+moved}:`) && r.customerId === b)!;
  const r2 = { ...toCheck, status: "QUEUED" };
  assert.equal(await stillWanted(r2), null, "an unchanged booking is still wanted");
  await db.enrollment.update({ where: { id: eB.id }, data: { status: "CANCELLED" } });
  assert.equal(await stillWanted(r2), "The booking changed");
  await db.enrollment.update({ where: { id: eB.id }, data: { status: "ENROLLED" } });
  await db.classMeeting.update({ where: { id: meeting.id }, data: { cancelled: true } });
  assert.equal(await stillWanted(r2), "The booking changed");
  await db.classMeeting.update({ where: { id: meeting.id }, data: { cancelled: false } });
  await db.shopClass.update({ where: { id: cls.id }, data: { status: "CANCELLED" } });
  assert.equal(await stillWanted(r2), "The booking changed");
  await db.shopClass.update({ where: { id: cls.id }, data: { status: "OPEN" } });
  const ap = { ...ar[0], status: "QUEUED" };
  assert.equal(await stillWanted(ap), null);
  await db.appointment.update({ where: { id: appt.id }, data: { startsAt: at(tomorrow, "16:00"), endsAt: at(tomorrow, "17:00") } });
  assert.equal(await stillWanted(ap), "The time changed");
  await db.appointment.update({ where: { id: appt.id }, data: { status: "CANCELLED" } });
  assert.equal(await stillWanted(ap), "The booking changed");

  // Reminders switched off, and a company without Marketing: nothing.
  await setMs(m.shopId, { reminders: false });
  const cls2 = await db.shopClass.create({ data: { shopId: m.shopId, title: "Off", seats: 8, remind: "every", status: "OPEN" } });
  await db.classMeeting.create({ data: { shopId: m.shopId, classId: cls2.id, startsAt: at(tomorrow, "10:00"), endsAt: at(tomorrow, "11:00") } });
  await db.enrollment.create({ data: { shopId: m.shopId, classId: cls2.id, customerId: a, name: "Ann", feeCents: 0, status: "ENROLLED" } });
  await runSchedulers(at("2026-10-14", "10:20"), [m.shopId]);
  assert.equal((await rowsOf(m.shopId, { kind: "reminder", refType: "meeting" })).filter((r) => r.body.includes("Off")).length, 0, "reminders off -> nothing");
  await setMs(m.shopId, { reminders: true });

  const cn = await customer(n.shopId, { notifyBy: "email" });
  const cn2 = await db.shopClass.create({ data: { shopId: n.shopId, title: "Nope", seats: 8, remind: "every", status: "OPEN" } });
  await db.classMeeting.create({ data: { shopId: n.shopId, classId: cn2.id, startsAt: at(tomorrow, "10:00"), endsAt: at(tomorrow, "11:00") } });
  await db.enrollment.create({ data: { shopId: n.shopId, classId: cn2.id, customerId: cn, name: "N", feeCents: 0, status: "ENROLLED" } });
  await runSchedulers(NOW, [n.shopId]);
  assert.equal(await db.outMessage.count({ where: { shopId: n.shopId } }), 0, "no Marketing -> the scheduler skips the company");
  ok("reminders: one per enrolled customer (not a sign-up under 24 h before), a second run queues nothing, remind first / never, appointments, a moved meeting is cancelled by stillWanted and re-queued, booking-changed reasons, nothing says tomorrow");
}

async function uncollected(m: Shop, n: Shop, linkId: string) {
  await setMs(m.shopId, { abandonNotices: true, abandonDays: [7, 30], finalNoticeDays: 7 });
  const R = at("2026-08-03", "14:00");
  const day = (k: number, hm = "10:30") => at(addDays("2026-08-03", k), hm);
  const c = await customer(m.shopId, { name: "Una Uncollected", notifyBy: "both" });
  const t = await ticket(m.shopId, { customerId: c, status: "READY_FOR_PICKUP", pickupReadyAt: R });
  const abandonRows = () => rowsOf(m.shopId, { ticketId: t, kind: "abandon" });

  await runSchedulers(day(6), [m.shopId]);
  assert.equal((await abandonRows()).length, 0, "nothing before day 7");
  await runSchedulers(day(7), [m.shopId]);
  clearKick();
  let rows = await abandonRows();
  assert.deepEqual(rows.map((r) => r.channel).sort(), ["email", "sms"], "every allowed channel");
  const stages = abandonStages(R, [7, 30], 60, 7, 10, NY);
  assert.ok(rows.every((r) => r.refType === "stage" && r.refId === stageKey(R, stages[0]) && r.status === "QUEUED"));
  assert.match(rows.find((r) => r.channel === "email")!.body, /ready to pick up since Mon, Aug 3/);
  assert.match(rows.find((r) => r.channel === "email")!.body, /Please pick it up by Fri, Oct 2, 2026/, "the abandon date carries its year");
  assert.match(rows.find((r) => r.channel === "email")!.body, /\$45\.00/);
  await runSchedulers(day(7, "10:50"), [m.shopId]);
  assert.equal((await abandonRows()).length, 2, "day 7 once");
  await runSchedulers(day(30), [m.shopId]);
  clearKick();
  rows = await abandonRows();
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((r) => r.refId === stageKey(R, stages[1])).length, 2, "day 30 once per channel");
  await runSchedulers(day(30, "11:30"), [m.shopId]);
  await runSchedulers(day(53), [m.shopId]);
  clearKick();
  rows = await abandonRows();
  assert.equal(rows.length, 6);
  const fin = rows.filter((r) => r.refId === stageKey(R, stages[2]));
  assert.equal(fin.length, 2, "day 53 once per channel");
  assert.match(fin.find((r) => r.channel === "sms")!.body, /FINAL NOTICE/);
  assert.match(fin.find((r) => r.channel === "email")!.subject ?? "", /^Final notice/);
  await runSchedulers(day(54), [m.shopId]);
  await runSchedulers(day(59), [m.shopId]);
  assert.equal((await abandonRows()).length, 6, "rows at day 7, 30 and 53, once each");

  // The ticket page's view of it.
  const sched = scheduleFor(R, 60, NY, await db.messagingSettings.findUniqueOrThrow({ where: { shopId: m.shopId } }), day(54), await stageRows(db, m.shopId, { ticketId: t }));
  assert.deepEqual(sched.stages.map((s) => s.state), ["waiting", "waiting", "waiting"]);

  // A notice recorded by hand for the "second" stage stops the automatic second.
  const R2 = at("2026-08-10", "14:00");
  const t2 = await ticket(m.shopId, { customerId: c, status: "READY_FOR_PICKUP", pickupReadyAt: R2 });
  const D = (k: number, hm = "10:30") => at(addDays("2026-08-10", k), hm);
  await assert.rejects(recordManual(m.user, { ticketId: t2 }, { stage: "second", how: "certified_mail", date: null, text: "Mailed it", tracking: "" }, D(29)), (e: unknown) => isUserError(e) && /Enter the tracking number\./.test((e as Error).message));
  await recordManual(m.user, { ticketId: t2 }, { stage: "second", how: "certified_mail", date: addDays("2026-08-10", 29), text: "Mailed the second notice", tracking: "7021 0000 1111" }, D(30, "08:00"));
  await runSchedulers(D(30), [m.shopId]);
  const manual = await rowsOf(m.shopId, { ticketId: t2, kind: "abandon" });
  assert.equal(manual.length, 1, "a notice recorded by hand for the second stage stops the automatic second");
  assert.equal(manual[0].channel, "certified_mail");
  assert.equal(manual[0].status, "SENT");
  assert.equal(manual[0].providerId, "7021 0000 1111");
  assert.equal(manual[0].byUserId, m.user.id);
  assert.match(manual[0].dedupeKey ?? "", /^byhand:ticket:/, "a by-hand record is marked so the staff cap and the worker leave it alone");
  assert.equal(manual[0].address, "12 Elm St\nSpringfield".trim(), "the customer's postal address");
  assert.equal(+manual[0].sentAt!, +zonedTime(addDays("2026-08-10", 29), 12 * 60, NY), "given on the date entered, at noon");
  const sched2 = scheduleFor(R2, 60, NY, await db.messagingSettings.findUniqueOrThrow({ where: { shopId: m.shopId } }), D(30), await stageRows(db, m.shopId, { ticketId: t2 }));
  assert.deepEqual(sched2.stages.map((s) => s.state), ["replaced", "sent", "coming"]);
  // Dates: not in the future; 14 days back needs an admin.
  await assert.rejects(recordManual(m.user, { ticketId: t2 }, { stage: "first", how: "letter", date: addDays("2026-08-10", 31), text: "x", tracking: null }, D(30)), /future/);
  await assert.rejects(recordManual({ ...m.user, role: "TECH" }, { ticketId: t2 }, { stage: "first", how: "letter", date: addDays("2026-08-10", 10), text: "x", tracking: null }, D(30)), /Only an owner or admin can record a notice more than 14 days back\./);
  await recordManual({ ...m.user, role: "TECH" }, { ticketId: t2 }, { stage: "first", how: "phone", date: addDays("2026-08-10", 20), text: "Called, left a message", tracking: null }, D(30));
  assert.equal((await rowsOf(m.shopId, { ticketId: t2, kind: "abandon" })).length, 2, "a phone call recorded by a counter user, within 14 days");

  // Switching on for a ticket ready 200 days ago queues nothing; the slot says decide by hand.
  const R3 = new Date(+day(30) - 200 * DAY);
  const t3 = await ticket(m.shopId, { customerId: c, status: "READY_FOR_PICKUP", pickupReadyAt: R3 });
  await runSchedulers(day(30, "12:00"), [m.shopId]);
  assert.equal((await rowsOf(m.shopId, { ticketId: t3, kind: "abandon" })).length, 0, "past the window: nothing queued");
  const sched3 = scheduleFor(R3, 60, NY, await db.messagingSettings.findUniqueOrThrow({ where: { shopId: m.shopId } }), day(30, "12:00"), []);
  assert.deepEqual(sched3.stages.map((s) => s.state), ["replaced", "replaced", "past"], "the last due stage says: decide by hand");

  // Not direct / SITE / not ready: nothing.
  const trade = await customer(m.shopId, { name: "Quilt Shop", kind: "TRADE", notifyBy: "email" });
  const tv = await ticket(m.shopId, { customerId: c, via: trade, status: "READY_FOR_PICKUP", pickupReadyAt: R });
  const ts = await ticket(m.shopId, { customerId: c, jobType: "SITE", status: "READY_FOR_PICKUP", pickupReadyAt: R });
  await runSchedulers(day(7, "11:00"), [m.shopId]);
  assert.equal(await db.outMessage.count({ where: { shopId: m.shopId, ticketId: { in: [tv, ts] } } }), 0);

  // A retail job back at the counter: the partnership's own abandon rule (30 days: stages 7 and final at 23).
  await db.partnerLink.update({ where: { shopId_id: { shopId: m.shopId, id: linkId } }, data: { terms: { abandonedAfterDays: 30 } } });
  const jb = await job(m.shopId, linkId, { customerId: c, status: "READY_FOR_PICKUP", backAt: R });
  await runSchedulers(day(23), [m.shopId]);
  clearKick();
  const jrows = await rowsOf(m.shopId, { repairJobId: jb, kind: "abandon" });
  assert.equal(jrows.length, 2);
  assert.equal(jrows[0].refId, `${+R}:final`, "the final stage comes at abandon-after minus 7 days (terms: 30)");
  assert.match(jrows.find((r) => r.channel === "sms")!.body, /FINAL NOTICE/);
  // Picked up: nothing more.
  const jp = await job(m.shopId, linkId, { customerId: c, status: "COLLECTED", backAt: R, pickedUpAt: day(2) });
  await runSchedulers(day(7), [m.shopId]);
  assert.equal(await db.outMessage.count({ where: { shopId: m.shopId, repairJobId: jp } }), 0);

  // The company without Marketing: nothing.
  const cn = await customer(n.shopId, { notifyBy: "both" });
  await ticket(n.shopId, { customerId: cn, status: "READY_FOR_PICKUP", pickupReadyAt: R });
  await runSchedulers(day(7), [n.shopId]);
  assert.equal(await db.outMessage.count({ where: { shopId: n.shopId } }), 0);
  ok("uncollected: rows at day 7, 30 and 53 once each (both channels); a notice recorded by hand stops the automatic stage; a ticket ready 200 days ago -> nothing queued, decide by hand; partner terms; SITE / trade / picked up / no Marketing -> nothing");
}

async function stillWantedAbandon(m: Shop, linkId: string) {
  // The clock is the real one here (stillWanted asks "now"): stages are laid out around it.
  await setMs(m.shopId, { abandonNotices: true, abandonDays: [7, 30], finalNoticeDays: 7 });
  await db.partnerLink.update({ where: { shopId_id: { shopId: m.shopId, id: linkId } }, data: { terms: {} } });
  const c = await customer(m.shopId, { notifyBy: "email" });
  const row = (over: Partial<OutMessage> & { ticketId?: string; repairJobId?: string; refId: string }) =>
    ({ id: "x", shopId: m.shopId, kind: "abandon", refType: "stage", status: "QUEUED", channel: "email", customerId: c, dedupeKey: `abandon:t:x:${over.refId}:email`, address: "a@b.test", createdAt: new Date(), ...over }) as unknown as OutMessage;
  const startOf = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);

  const S = startOf(33); // day 30's stage fell due 3 days ago; day 7's long before
  const t = await ticket(m.shopId, { customerId: c, status: "READY_FOR_PICKUP", pickupReadyAt: S });
  const st = abandonStages(S, [7, 30], 60, 7, 10, NY);
  assert.equal(await stillWanted(row({ ticketId: t, refId: stageKey(S, st[0]) })), "A later notice replaced it");
  assert.equal(await stillWanted(row({ ticketId: t, refId: stageKey(S, st[1]) })), null, "the current stage is wanted");
  assert.equal(await stillWanted(row({ ticketId: t, refId: stageKey(S, st[1]), dedupeKey: `manual:abandon:${t}:1:email` })), null, "a by-hand send ignores the window");
  assert.equal(await stillWanted(row({ ticketId: t, refId: stageKey(startOf(34), st[1]) })), "It was picked up or moved on", "a different ready date (it was ready again)");
  const old = startOf(45);
  const t2 = await ticket(m.shopId, { customerId: c, status: "READY_FOR_PICKUP", pickupReadyAt: old });
  const st2 = abandonStages(old, [7, 30], 60, 7, 10, NY);
  assert.equal(await stillWanted(row({ ticketId: t2, refId: stageKey(old, st2[1]) })), "Too late to send: decide by hand");
  assert.equal(await stillWanted(row({ ticketId: t2, refId: stageKey(old, st2[1]), dedupeKey: `manual:abandon:${t2}:2:email` })), null, "by hand");
  await db.ticket.update({ where: { id: t }, data: { status: "COLLECTED", pickupReadyAt: null } });
  assert.equal(await stillWanted(row({ ticketId: t, refId: stageKey(S, st[1]) })), "It was picked up or moved on");
  // A retail job.
  const j = await job(m.shopId, linkId, { customerId: c, status: "READY_FOR_PICKUP", backAt: S });
  assert.equal(await stillWanted(row({ repairJobId: j, refId: stageKey(S, st[1]) })), null);
  await db.repairJob.update({ where: { shopId_id: { shopId: m.shopId, id: j } }, data: { pickedUpAt: new Date(), status: "COLLECTED" } });
  assert.equal(await stillWanted(row({ repairJobId: j, refId: stageKey(S, st[1]) })), "It was picked up or moved on");
  ok("stillWanted abandon: a later notice replaced it; too late to send; picked up or moved on; by-hand sends ignore the window");
}

async function stillWantedReady(m: Shop, linkId: string) {
  const c = await customer(m.shopId, { notifyBy: "email" });
  const T = at("2026-10-14", "10:00");
  const t = await ticket(m.shopId, { customerId: c, status: "ON_BENCH" });
  await change(m.shopId, t, "READY_FOR_PICKUP", T);
  const r = (await rowsOf(m.shopId, { ticketId: t, kind: "ready" }))[0];
  assert.equal(await stillWanted(r), null, "still ready");
  await db.ticket.update({ where: { id: t }, data: { pickupReadyAt: new Date(+T + DAY) } });
  assert.equal(await stillWanted(r), "It was picked up or moved on", "ready again with another date");
  await db.ticket.update({ where: { id: t }, data: { pickupReadyAt: T } });
  assert.equal(await stillWanted(r), null);
  await db.ticket.update({ where: { id: t }, data: { status: "COLLECTED" } });
  assert.equal(await stillWanted(r), "It was picked up or moved on");
  // A job.
  const j = await job(m.shopId, linkId, { customerId: c, status: "READY_FOR_PICKUP" });
  await recordBack(m.user, [j], { single: true, now: T });
  clearKick();
  const jr = (await rowsOf(m.shopId, { repairJobId: j, kind: "ready" }))[0];
  assert.equal(await stillWanted(jr), null);
  await db.repairJob.updateMany({ where: { shopId: m.shopId, id: j }, data: { backAt: new Date(+T + DAY) } });
  assert.equal(await stillWanted(jr), "It was picked up or moved on", "its backAt isn't the one in the key");
  await db.repairJob.updateMany({ where: { shopId: m.shopId, id: j }, data: { backAt: T, pickedUpAt: T, status: "COLLECTED" } });
  assert.equal(await stillWanted(jr), "It was picked up or moved on");
  ok("stillWanted ready: another pickupReadyAt / backAt, picked up, or moved on -> cancelled");
}

async function stillWantedOthers(m: Shop, other: Shop) {
  const c = await customer(m.shopId, { notifyBy: "sms", phone: "+12125558888" });
  const base = (over: Partial<OutMessage>) => ({ id: "x", shopId: m.shopId, status: "QUEUED", channel: "email", customerId: c, address: "a@b.test", createdAt: new Date(), ...over }) as unknown as OutMessage;

  // estimate
  const t = await ticket(m.shopId, { customerId: c, status: "WAITING_CUSTOMER_OK" });
  const link = await db.estimateLink.create({
    data: { shopId: m.shopId, tokenHash: crypto.randomBytes(16).toString("hex"), maskedUrl: "https://x.test/e/•••abcd", ticketId: t, customerId: c, totalCents: 1000, lines: [], expiresAt: new Date(Date.now() + DAY) },
  });
  const est = base({ kind: "estimate", refType: "estimate", refId: link.id, ticketId: t });
  assert.equal(await stillWanted(est), null);
  await db.ticket.update({ where: { id: t }, data: { status: "ON_BENCH" } });
  assert.equal(await stillWanted(est), "The ticket isn't waiting for the customer's OK any more");
  await db.ticket.update({ where: { id: t }, data: { status: "WAITING_CUSTOMER_OK" } });
  await db.estimateLink.update({ where: { id: link.id }, data: { answeredAt: new Date(), answer: "APPROVED" } });
  assert.equal(await stillWanted(est), "The customer already answered");
  await db.estimateLink.update({ where: { id: link.id }, data: { answeredAt: null, answer: null, revokedAt: new Date() } });
  assert.equal(await stillWanted(est), "The estimate link was stopped or replaced");
  await db.estimateLink.update({ where: { id: link.id }, data: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await stillWanted(est), "The estimate link expired");
  await db.estimateLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() + DAY) } });
  // another company's link id: not found -> not wanted
  assert.equal(await stillWanted({ ...est, shopId: other.shopId }), "The estimate link was stopped or replaced", "a link of another company is not found");
  // Answered by phone (the ticket keeps its status when declined): the queued message is not wanted, link or no link.
  await db.ticket.update({ where: { id: t }, data: { estimateAnswer: "DECLINED", estimateAnsweredAt: new Date() } });
  assert.equal(await stillWanted(est), "The ticket isn't waiting for the customer's OK any more", "declined by phone");
  const noLink = base({ kind: "estimate", refType: "estimate", refId: null, ticketId: t });
  assert.equal(await stillWanted(noLink), "The ticket isn't waiting for the customer's OK any more", "a 'they call or reply' row (no link) is checked too");
  await db.ticket.update({ where: { id: t }, data: { estimateAnswer: null, estimateAnsweredAt: null } });
  assert.equal(await stillWanted(noLink), null);

  // service due: a newer ticket for a listed machine
  const mid = await machine(m.shopId, c);
  const done = await ticket(m.shopId, { customerId: c, machineId: mid, status: "COLLECTED", closedAt: new Date(Date.now() - 400 * DAY), intakeAt: new Date(Date.now() - 401 * DAY) });
  await db.machine.update({ where: { id: mid }, data: { serviceNoticeFor: new Date(Date.now() - 400 * DAY) } });
  const svc = base({ kind: "service_due", refType: "machine", refId: mid, createdAt: new Date(Date.now() - 1000) });
  assert.equal(await stillWanted(svc), null);
  await ticket(m.shopId, { customerId: c, machineId: mid, intakeAt: new Date(Date.now() + 5000) });
  assert.equal(await stillWanted(svc), "The machine came back in");
  assert.ok(done);

  // consent_confirm
  const cc = base({ kind: "consent_confirm", channel: "sms", address: "+12125558888" });
  assert.equal(await stillWanted(cc), "Consent withdrawn", "no consent on the record");
  await db.customer.update({ where: { id: c }, data: { smsConsentAt: new Date(), smsConsentPhone: "+12125558888" } });
  assert.equal(await stillWanted(cc), null);
  await db.customer.update({ where: { id: c }, data: { smsConsentAt: null, smsConsentPhone: null } });
  assert.equal(await stillWanted(cc), "Consent withdrawn");

  // everything else: never
  for (const kind of ["review", "campaign", "class_notice", "booking_notice", "help_reply", "test", "bags_due"]) {
    assert.equal(await stillWanted(base({ kind })), null, `${kind}: never cancelled here`);
  }
  ok("stillWanted for every kind of 9.4: ready, abandon, reminder, estimate, service_due, consent_confirm, and \"others: never\"");
}

async function serviceDue(m: Shop, n: Shop) {
  const NOW = at("2026-10-14", "10:30");
  const ago = (months: number, extraDays = 0) => new Date(+NOW - months * 30.4 * DAY - extraDays * DAY);
  await setMs(m.shopId, { serviceDue: true, serviceDueMonths: 12, serviceDueSince: new Date(+NOW - 2 * 365 * DAY), serviceDueDay: null });

  const one = await customer(m.shopId, { name: "Sam Service", notifyBy: "email" });
  const mOne = await machine(m.shopId, one, { brand: "Janome", model: "MC6700P" });
  await ticket(m.shopId, { customerId: one, machineId: mOne, status: "COLLECTED", closedAt: ago(13), intakeAt: ago(13, 3) });
  const two = await customer(m.shopId, { name: "Tia Two", notifyBy: "email" });
  const mA = await machine(m.shopId, two, { brand: "Janome", model: "MC6700P" });
  const mB = await machine(m.shopId, two, { brand: "Singer", model: "401A" });
  await ticket(m.shopId, { customerId: two, machineId: mA, status: "COLLECTED", closedAt: ago(13), intakeAt: ago(13, 3) });
  await ticket(m.shopId, { customerId: two, machineId: mB, status: "COLLECTED", closedAt: ago(13, 12), intakeAt: ago(13, 15) });
  // Not due: before the cut-off, a vacuum without its module, a machine that came back in.
  const old = await customer(m.shopId, { name: "Olly Old", notifyBy: "email" });
  await ticket(m.shopId, { customerId: old, status: "COLLECTED", closedAt: ago(30), intakeAt: ago(30, 3) });
  const vac = await customer(m.shopId, { name: "Vic Vac", notifyBy: "email" });
  await ticket(m.shopId, { customerId: vac, status: "COLLECTED", closedAt: ago(13), intakeAt: ago(13, 3), equipment: "VACUUM" });
  const back = await customer(m.shopId, { name: "Bo Back", notifyBy: "email" });
  const mBack = await machine(m.shopId, back);
  await ticket(m.shopId, { customerId: back, machineId: mBack, status: "COLLECTED", closedAt: ago(13), intakeAt: ago(13, 3) });
  await ticket(m.shopId, { customerId: back, machineId: mBack, intakeAt: ago(1) });
  // A SITE install isn't a service.
  const site = await customer(m.shopId, { name: "Sid Site", notifyBy: "email" });
  await ticket(m.shopId, { customerId: site, status: "COLLECTED", closedAt: ago(13), intakeAt: ago(13, 3), jobType: "SITE" });

  await runSchedulers(NOW, [m.shopId]);
  clearKick();
  const rows = await rowsOf(m.shopId, { kind: "service_due" });
  assert.equal(rows.length, 2, `one per customer: ${rows.map((r) => r.customerId)}`);
  const r1 = rows.find((r) => r.customerId === one)!;
  assert.equal(r1.purpose, "marketing");
  assert.equal(r1.channel, "email");
  assert.equal(r1.refType, "machine");
  assert.equal(r1.refId, mOne);
  assert.match(r1.body, /about 1[34] months since we serviced your Janome MC6700P/);
  assert.match(r1.body, /advertisement/, "marketing footer");
  const r2 = rows.find((r) => r.customerId === two)!;
  assert.match(r2.body, /Janome MC6700P and Singer 401A|Singer 401A and Janome MC6700P/, "one row naming both machines");
  assert.equal(r2.dedupeKey, `svc:${two}:2026-10-14:email`);
  for (const id of [mOne, mA, mB]) assert.ok((await db.machine.findUniqueOrThrow({ where: { id } })).serviceNoticeFor, "serviceNoticeFor is set");
  assert.equal((await db.messagingSettings.findUniqueOrThrow({ where: { shopId: m.shopId } })).serviceDueDay, "2026-10-14", "once per shop-day");
  assert.equal((await rowsOf(m.shopId, { customerId: { in: [old, vac, back, site] }, kind: "service_due" })).length, 0, "before the cut-off / no vacuum module / came back in / SITE: nothing");

  // Same day: not again. Next day (day field cleared): the notified machines are dropped.
  await runSchedulers(new Date(+NOW + HOUR), [m.shopId]);
  await setMs(m.shopId, { serviceDueDay: null });
  await runSchedulers(new Date(+NOW + DAY), [m.shopId]);
  assert.equal((await rowsOf(m.shopId, { kind: "service_due" })).length, 2, "a machine isn't noticed twice for the same service");

  // A newer ticket for the machine cancels it at send time.
  await ticket(m.shopId, { customerId: one, machineId: mOne, intakeAt: new Date(Date.now() + 5000) });
  assert.equal(await stillWanted({ ...r1, createdAt: new Date(Date.now() - 1000) }), "The machine came back in");

  // The daily cap counts only QUEUED / SENDING / SENT.
  const X = at("2026-10-20", "10:30");
  const day = (k: number) => at(addDays("2026-10-20", k), "10:30");
  const mk = async (i: number, status: string) =>
    db.outMessage.create({ data: { shopId: m.shopId, channel: "email", purpose: "marketing", kind: "service_due", address: "z@z.test", body: "x", status, createdAt: X, dedupeKey: `capfill:${i}:${status}` } });
  for (let i = 0; i < 49; i++) await mk(i, i % 3 === 0 ? "QUEUED" : i % 3 === 1 ? "SENDING" : "SENT");
  for (let i = 0; i < 10; i++) await mk(100 + i, ["CANCELLED", "SKIPPED", "FAILED", "EXPIRED"][i % 4]);
  const cust: string[] = [];
  for (let i = 0; i < 2; i++) {
    const cu = await customer(m.shopId, { name: `Cap ${i}`, notifyBy: "email" });
    cust.push(cu);
    await ticket(m.shopId, { customerId: cu, status: "COLLECTED", closedAt: new Date(+X - 13 * 30.4 * DAY), intakeAt: new Date(+X - 13 * 30.4 * DAY - 3 * DAY) });
  }
  await setMs(m.shopId, { serviceDueDay: null });
  await runSchedulers(X, [m.shopId]);
  clearKick();
  const capped = await rowsOf(m.shopId, { kind: "service_due", customerId: { in: cust } });
  assert.equal(capped.length, 1, "49 counted rows (the 10 cancelled / skipped / failed / expired don't count) leave room for exactly one");
  await setMs(m.shopId, { serviceDueDay: null });
  await runSchedulers(day(1), [m.shopId]);
  clearKick();
  assert.equal((await rowsOf(m.shopId, { kind: "service_due", customerId: { in: cust } })).length, 2, "the rest are still due the next day");

  // Switch off / no Marketing: nothing.
  await setMs(m.shopId, { serviceDue: false, serviceDueDay: null });
  const off = await customer(m.shopId, { name: "Off Olive", notifyBy: "email" });
  await ticket(m.shopId, { customerId: off, status: "COLLECTED", closedAt: ago(13), intakeAt: ago(13, 3) });
  await runSchedulers(NOW, [m.shopId]);
  assert.equal((await rowsOf(m.shopId, { kind: "service_due", customerId: off })).length, 0);
  const cn = await customer(n.shopId, { notifyBy: "email" });
  await ticket(n.shopId, { customerId: cn, status: "COLLECTED", closedAt: ago(13), intakeAt: ago(13, 3) });
  await messagingFor(n.shopId, { email: true, settings: { serviceDue: true, serviceDueSince: new Date(+NOW - 2 * 365 * DAY) } });
  await runSchedulers(NOW, [n.shopId]);
  assert.equal(await db.outMessage.count({ where: { shopId: n.shopId } }), 0);
  ok("service due: one service_due per customer naming both machines; before the cut-off / no vac module / came back / SITE -> nothing; once per shop-day; a newer ticket cancels it at send time; the daily cap counts only QUEUED / SENDING / SENT");
}

async function review(m: Shop) {
  const NOW = at("2026-10-14", "10:30");
  await setMs(m.shopId, { reviewRequest: true, reviewUrl: "https://example.test/review", reviewDelayHours: 24, reviewEveryDays: 180, reviewAfterSales: false });
  const inWindow = new Date(+NOW - 30 * HOUR);
  const r1 = await customer(m.shopId, { name: "Rey Review", notifyBy: "email" });
  await ticket(m.shopId, { customerId: r1, status: "COLLECTED", closedAt: inWindow, intakeAt: new Date(+inWindow - 3 * DAY) });
  await ticket(m.shopId, { customerId: r1, status: "COLLECTED", closedAt: new Date(+inWindow - HOUR), intakeAt: new Date(+inWindow - 3 * DAY) });
  const r2 = await customer(m.shopId, { name: "Sid Site", notifyBy: "email" });
  await ticket(m.shopId, { customerId: r2, status: "COLLECTED", closedAt: inWindow, jobType: "SITE" });
  const r3 = await customer(m.shopId, { name: "Ray Recent", notifyBy: "email" });
  await db.customer.update({ where: { id: r3 }, data: { lastReviewAskAt: new Date(+NOW - 10 * DAY) } });
  await ticket(m.shopId, { customerId: r3, status: "COLLECTED", closedAt: inWindow });
  const r4 = await customer(m.shopId, { name: "Sal Sale", notifyBy: "email" });
  await db.sale.create({ data: { shopId: m.shopId, number: saleNumber++, customerId: r4, subtotalCents: 1000, taxCents: 0, totalCents: 1000, taxRatePct: 0, createdAt: inWindow } });
  const r5 = await customer(m.shopId, { name: "Too Soon", notifyBy: "email" });
  await ticket(m.shopId, { customerId: r5, status: "COLLECTED", closedAt: new Date(+NOW - 5 * HOUR) });
  const r6 = await customer(m.shopId, { name: "Too Old", notifyBy: "email" });
  await ticket(m.shopId, { customerId: r6, status: "COLLECTED", closedAt: new Date(+NOW - 90 * HOUR) });

  await runSchedulers(NOW, [m.shopId]);
  clearKick();
  let rows = await rowsOf(m.shopId, { kind: "review" });
  assert.deepEqual(rows.map((r) => r.customerId), [r1], "one per customer; SITE never; asked recently never; sales ignored while reviewAfterSales is off; only inside the window");
  assert.equal(rows[0].purpose, "marketing");
  assert.match(rows[0].body, /https:\/\/example\.test\/review/);
  assert.equal(rows[0].dedupeKey, `review:${r1}:2026-10-14:email`);
  assert.equal(+(await db.customer.findUniqueOrThrow({ where: { id: r1 } })).lastReviewAskAt!, +NOW, "lastReviewAskAt is set");
  await runSchedulers(new Date(+NOW + HOUR), [m.shopId]);
  assert.equal((await rowsOf(m.shopId, { kind: "review" })).length, 1, "a second run asks nobody again");

  await setMs(m.shopId, { reviewAfterSales: true });
  await runSchedulers(new Date(+NOW + 2 * HOUR), [m.shopId]);
  clearKick();
  rows = await rowsOf(m.shopId, { kind: "review" });
  assert.deepEqual(new Set(rows.map((r) => r.customerId)), new Set([r1, r4]), "reviewAfterSales on: a completed sale counts");
  // All-return sales don't.
  const rr = await customer(m.shopId, { name: "Ret Urn", notifyBy: "email" });
  await db.sale.create({ data: { shopId: m.shopId, number: saleNumber++, customerId: rr, subtotalCents: -500, taxCents: 0, totalCents: -500, taxRatePct: 0, createdAt: inWindow } });
  await runSchedulers(new Date(+NOW + 3 * HOUR), [m.shopId]);
  assert.equal((await rowsOf(m.shopId, { kind: "review", customerId: rr })).length, 0);

  // No link set: nothing.
  await setMs(m.shopId, { reviewUrl: null });
  const r7 = await customer(m.shopId, { name: "No Link", notifyBy: "email" });
  await ticket(m.shopId, { customerId: r7, status: "COLLECTED", closedAt: inWindow });
  await runSchedulers(new Date(+NOW + 4 * HOUR), [m.shopId]);
  assert.equal((await rowsOf(m.shopId, { kind: "review", customerId: r7 })).length, 0);
  ok("review: one per customer inside reviewEveryDays; SITE never; reviewAfterSales off -> sales ignored; returns ignored; needs the review link");
}

async function tenant(a: Shop, b: Shop, linkIdA: string) {
  const c = await customer(a.shopId, { notifyBy: "email" });
  const t = await ticket(a.shopId, { customerId: c, status: "READY_FOR_PICKUP", pickupReadyAt: new Date(Date.now() - 10 * DAY) });
  const j = await job(a.shopId, linkIdA, { customerId: c, status: "READY_FOR_PICKUP", backAt: new Date(Date.now() - 10 * DAY) });
  const tables = ["Ticket", "RepairJob", "OutMessage", "Customer"];
  const before = await snapshot(a.shopId, tables);
  const text = { stage: "first", how: "letter", date: null, text: "x", tracking: null };
  await expectNotFound("recordManual ticket", () => recordManual(b.user, { ticketId: t }, text));
  await expectNotFound("recordManual job", () => recordManual(b.user, { jobId: j }, text));
  await expectNotFound("sendNow ready ticket", () => sendNow(b.user, { ticketId: t }, "ready"));
  await expectNotFound("sendNow abandon job", () => sendNow(b.user, { jobId: j }, "abandon"));
  await expectNotFound("recordBack single", () => recordBack(b.user, [j], { single: true }));
  await assert.rejects(recordBack(b.user, [j], { single: false }), (e: unknown) => isUserError(e), "recordBack many: nothing of another company's");
  await expectNotFound("stillWanted ready (another company's ticket)", async () => ((await stillWanted({ id: "x", shopId: b.shopId, kind: "ready", ticketId: t, dedupeKey: `ready:t:${t}:1:email` } as OutMessage)) === "It was picked up or moved on" ? null : "leak"));
  assertUnchanged("company A after company B's calls", before, await snapshot(a.shopId, tables));
  ok("tenant: company B can't record, send or mark back company A's ticket or job; A's rows are unchanged");
}

async function gates(n: Shop, m: Shop) {
  assert.equal(await moduleOn(n.shopId, "marketing"), false);
  await assert.rejects(requireOn(n.user, "marketing"), (e: unknown) => isUserError(e));
  await requireOn(m.user, "marketing");
  ok("sendNoticeNow's gate: a company without Marketing is refused, one with it passes (the other actions have no gate)");
}

async function main() {
  const t0 = Date.now();
  delete process.env.MESSAGES;
  delete process.env.READY_NOTICE_DELAY_SECONDS;
  try {
    await withSink();
    await withMock();
    const m = await shopWith();
    const n = await shopWith({ marketing: false });
    const other = await shopWith();
    const repair = await checkShop({});
    const linkM = await linkPair(repair.shopId, m.shopId);
    const linkN = await linkPair(repair.shopId, n.shopId);
    const linkO = await linkPair(repair.shopId, other.shopId);
    await ready(m, n);
    await retail(m, n, linkM, linkN);
    await reminders(m, n);
    await uncollected(m, n, linkM);
    await stillWantedAbandon(m, linkM);
    await stillWantedReady(m, linkM);
    await stillWantedOthers(m, other);
    await serviceDue(m, n);
    await review(m);
    await tenant(m, other, linkM);
    await gates(n, m);
    void linkO;
    console.log(`notices.check: ${steps} groups passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
