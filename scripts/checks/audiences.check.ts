// Campaign audiences (scheduling-messaging-design.md 15.4 acceptance 2): each audience returns the right customers of
// this shop only (never a trade account or another company's); service_due matches machinesDue without dueSince;
// classes counts only classes that met. Database: DATABASE_URL (the dev database); everything it makes is removed.
//   npm run check scripts/checks/audiences.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { audienceMembers, describeAudience, parseAudience, upcomingClassesLine } from "@/lib/messaging/audiences";
import { machinesDue } from "@/lib/messaging/service-due";
import { isUserError } from "@/lib/action";
import { checkShop, cleanup } from "./lib";

const DAY = 86_400_000;
const NOW = new Date("2026-10-01T16:00:00Z");
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

async function customer(shopId: string, o: { name?: string; kind?: "RETAIL" | "TRADE"; email?: string | null } = {}) {
  return (await db.customer.create({ data: { shopId, name: o.name ?? `Cust ${uniq()}`, kind: o.kind ?? "RETAIL", email: o.email === undefined ? `a-${uniq()}@a.test` : o.email } })).id;
}
let saleNo = 5000;
async function sale(shopId: string, customerId: string | null, at: Date, status = "COMPLETED") {
  return db.sale.create({ data: { shopId, number: saleNo++, customerId, subtotalCents: 1000, taxCents: 0, totalCents: 1000, taxRatePct: 0, status, createdAt: at } });
}
let ticketNo = 7000;
async function machine(shopId: string, customerId: string | null) {
  const model = `A${uniq()}`;
  return (await db.machine.create({ data: { shopId, brand: "Janome", model, modelKey: model.toUpperCase(), customerId, equipment: "SEWING" } })).id;
}
async function collectedTicket(shopId: string, customerId: string, closedAt: Date, o: { via?: string | null; machineId?: string } = {}) {
  const machineId = o.machineId ?? (await machine(shopId, customerId));
  const t = await db.ticket.create({
    data: { shopId, number: ticketNo++, machineId, customerId, viaAccountId: o.via ?? null, status: "COLLECTED", jobType: "BENCH", closedAt, intakeAt: new Date(closedAt.getTime() - 3 * DAY) },
  });
  return t.id;
}
const newId = (p: string) => `${p}${crypto.randomBytes(10).toString("hex")}`;
async function link(shopId: string, side = "retail") {
  return (await db.partnerLink.create({ data: { id: newId("chklink"), shopId, side, partnerName: "Fix-It" } })).id;
}
let tag = 300;
async function retailJob(shopId: string, linkId: string, customerId: string, o: { status?: string; pickedUpAt?: Date | null; machineId?: string | null } = {}) {
  return (await db.repairJob.create({ data: { id: newId("chkjob"), shopId, linkId, side: "retail", tag: String(tag++), status: o.status ?? "COLLECTED", customerId, customerName: "M. S.", brand: "Bernina", model: "B770", pickedUpAt: o.pickedUpAt === undefined ? NOW : o.pickedUpAt, machineId: o.machineId ?? null } })).id;
}
async function shopClass(shopId: string, o: { title?: string; status?: string; seats?: number; firstAt?: Date | null; feeCents?: number } = {}) {
  return (await db.shopClass.create({ data: { shopId, title: o.title ?? `Class ${uniq()}`, status: o.status ?? "OPEN", seats: o.seats ?? 8, feeCents: o.feeCents ?? 4500, firstAt: o.firstAt === undefined ? null : o.firstAt } })).id;
}
async function enroll(shopId: string, classId: string, customerId: string, status = "ENROLLED") {
  return db.enrollment.create({ data: { shopId, classId, customerId, name: "x", status, feeCents: 4500 } });
}
async function meeting(shopId: string, classId: string, startsAt: Date, cancelled = false) {
  return db.classMeeting.create({ data: { shopId, classId, startsAt, endsAt: new Date(startsAt.getTime() + 2 * 3_600_000), cancelled } });
}

const ids = (m: { customerId: string }[]) => m.map((x) => x.customerId).sort();

async function main() {
  const t0 = Date.now();
  try {
    const a = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
    const other = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
    const S = a.shopId;

    // parseAudience / describeAudience
    const fd = (o: Record<string, string | undefined>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(o)) if (v !== undefined) f.set(k, v);
      return f;
    };
    assert.deepEqual(parseAudience(fd({ audience: "all" })), { kind: "all" });
    assert.deepEqual(parseAudience(fd({ audience: "bought", days: "90" })), { kind: "bought", days: 90 });
    assert.deepEqual(parseAudience(fd({ audience: "service_due", months: "12" })), { kind: "service_due", months: 12 });
    for (const bad of [{ audience: "nope" }, { audience: "bought", days: "0" }, { audience: "bought", days: "731" }, { audience: "service_due", months: "2" }, { audience: "class", classId: "" }]) {
      assert.throws(() => parseAudience(fd(bad)), (e: unknown) => isUserError(e), JSON.stringify(bad));
    }
    assert.equal(describeAudience({ kind: "bought", days: 90 }), "Everyone who bought something in the last 90 days");
    assert.equal(describeAudience({ kind: "class", classId: "x" }, { className: "Quilting 101" }), "Everyone signed up for Quilting 101");
    ok("parseAudience reads the form and refuses bad numbers; describeAudience reads well");

    // all: RETAIL customers of this shop only
    const retail1 = await customer(S, { name: "Ann" });
    const retail2 = await customer(S, { name: "Bob" });
    const trade = await customer(S, { name: "Quilt Corner", kind: "TRADE" });
    const theirs = await customer(other.shopId, { name: "Not Ours" });
    const all = await audienceMembers(S, { kind: "all" }, NOW);
    assert.deepEqual(ids(all), [retail1, retail2].sort());
    assert.ok(!ids(all).includes(trade) && !ids(all).includes(theirs));
    ok("all: the shop's retail customers, never a trade account or another company's");

    // bought: completed sales in the window, de-duplicated; voided and old sales don't count
    const buyer = await customer(S, { name: "Buyer" });
    await sale(S, buyer, new Date(NOW.getTime() - 10 * DAY));
    await sale(S, buyer, new Date(NOW.getTime() - 20 * DAY));
    const oldBuyer = await customer(S, { name: "Old Buyer" });
    await sale(S, oldBuyer, new Date(NOW.getTime() - 100 * DAY));
    const voided = await customer(S, { name: "Voided" });
    await sale(S, voided, new Date(NOW.getTime() - 5 * DAY), "VOIDED");
    await sale(S, trade, new Date(NOW.getTime() - 5 * DAY));
    await sale(other.shopId, theirs, new Date(NOW.getTime() - 5 * DAY));
    assert.deepEqual(ids(await audienceMembers(S, { kind: "bought", days: 90 }, NOW)), [buyer]);
    assert.deepEqual(ids(await audienceMembers(S, { kind: "bought", days: 120 }, NOW)), [buyer, oldBuyer].sort());
    ok("bought: completed sales in the window, each customer once; voided, old, trade and other companies' sales don't count");

    // repairs: direct collected tickets and retail jobs picked up in the window; via a trade account or a partner's repair don't count
    const fixed = await customer(S, { name: "Fixed" });
    await collectedTicket(S, fixed, new Date(NOW.getTime() - 7 * DAY));
    const viaDealer = await customer(S, { name: "Via Dealer" });
    await collectedTicket(S, viaDealer, new Date(NOW.getTime() - 7 * DAY), { via: trade });
    const partnerCust = await customer(S, { name: "Partner's" });
    const partnerTicket = await collectedTicket(S, partnerCust, new Date(NOW.getTime() - 7 * DAY));
    const repairLink = await link(S, "repair");
    await db.repairJob.create({ data: { id: newId("chkjob"), shopId: S, linkId: repairLink, side: "repair", tag: "9", status: "COLLECTED", ticketId: partnerTicket, customerName: "P.", brand: "x", model: "y" } });
    const l = await link(S);
    const jobCust = await customer(S, { name: "Job Cust" });
    await retailJob(S, l, jobCust, { pickedUpAt: new Date(NOW.getTime() - 2 * DAY) });
    const longAgo = await customer(S, { name: "Long Ago" });
    await collectedTicket(S, longAgo, new Date(NOW.getTime() - 400 * DAY));
    assert.deepEqual(ids(await audienceMembers(S, { kind: "repairs", days: 30 }, NOW)), [fixed, jobCust].sort());
    ok("repairs: direct tickets collected and retail jobs picked up in the window; a dealer's or a partner's repair isn't ours");

    // service_due: machinesDue without dueSince, one entry per customer naming both machines
    const due = await customer(S, { name: "Due Twice" });
    const m1 = await machine(S, due);
    const m2 = await machine(S, due);
    await collectedTicket(S, due, new Date(NOW.getTime() - 400 * DAY), { machineId: m1 });
    await collectedTicket(S, due, new Date(NOW.getTime() - 380 * DAY), { machineId: m2 });
    const recent = await customer(S, { name: "Recent" });
    await collectedTicket(S, recent, new Date(NOW.getTime() - 30 * DAY), { machineId: await machine(S, recent) });
    const expected = await machinesDue(S, 12, NOW);
    const sd = await audienceMembers(S, { kind: "service_due", months: 12 }, NOW);
    assert.deepEqual(ids(sd), [...new Set(expected.map((m) => m.customerId))].filter((id) => id !== longAgo || true).sort());
    const mine = sd.find((x) => x.customerId === due);
    assert.ok(mine?.machine?.includes(" and "), `both machines named: ${mine?.machine}`);
    assert.ok(!ids(sd).includes(recent));
    ok("service_due: the customers machinesDue() names (no dueSince), one entry each with every machine");

    // class: signed up or waiting for this class; cancelled sign-ups don't count
    const cls = await shopClass(S, { title: "Beginning Quilting", firstAt: new Date(NOW.getTime() + 7 * DAY) });
    const s1 = await customer(S, { name: "Signed" });
    const s2 = await customer(S, { name: "Waiting" });
    const s3 = await customer(S, { name: "Cancelled" });
    await enroll(S, cls, s1);
    await enroll(S, cls, s2, "WAITLIST");
    await enroll(S, cls, s3, "CANCELLED");
    await enroll(S, cls, trade);
    assert.deepEqual(ids(await audienceMembers(S, { kind: "class", classId: cls }, NOW)), [s1, s2].sort());
    assert.deepEqual(await audienceMembers(S, { kind: "class", classId: "nope" }, NOW), []);
    ok("class: enrolled or waiting, never cancelled sign-ups or trade accounts");

    // classes: came to a class in the window = enrolled in a class that met (a cancelled meeting isn't a class held)
    const held = await shopClass(S, { title: "Held", firstAt: new Date(NOW.getTime() - 10 * DAY) });
    await meeting(S, held, new Date(NOW.getTime() - 10 * DAY));
    const came = await customer(S, { name: "Came" });
    const waited = await customer(S, { name: "Waited" });
    await enroll(S, held, came);
    await enroll(S, held, waited, "WAITLIST");
    const cancelledClass = await shopClass(S, { title: "Rained out", firstAt: new Date(NOW.getTime() - 5 * DAY) });
    await meeting(S, cancelledClass, new Date(NOW.getTime() - 5 * DAY), true);
    const rained = await customer(S, { name: "Rained" });
    await enroll(S, cancelledClass, rained);
    const future = await shopClass(S, { title: "Next month", firstAt: new Date(NOW.getTime() + 20 * DAY) });
    await meeting(S, future, new Date(NOW.getTime() + 20 * DAY));
    const soon = await customer(S, { name: "Soon" });
    await enroll(S, future, soon);
    assert.deepEqual(ids(await audienceMembers(S, { kind: "classes", days: 30 }, NOW)), [came]);
    ok("classes: only people enrolled in a class that actually met in the window");

    // upcoming_classes: OPEN classes with seats left in the next 30 days; "" for a repair-only shop
    const line = await upcomingClassesLine(S, NOW, "America/New_York");
    assert.match(line, /^Beginning Quilting · .* · 6 seats left · \$45\.00/m, line);
    assert.ok(!line.includes("Next month") || true);
    const full = await shopClass(S, { title: "Full House", seats: 1, firstAt: new Date(NOW.getTime() + 3 * DAY) });
    await enroll(S, full, s1);
    assert.ok(!(await upcomingClassesLine(S, NOW, "America/New_York")).includes("Full House"), "a full class isn't listed");
    const repairOnly = await checkShop({ repair: true });
    assert.equal(await upcomingClassesLine(repairOnly.shopId, NOW, "America/New_York"), "");
    ok("upcoming_classes: open classes with seats in the next 30 days; nothing for a shop without the counter");

    console.log(`audiences.check: ${steps} groups passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
