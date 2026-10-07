// The status link for a phone-answering service (shop-features-round-2-design.md 5.6, package status-link):
//   1. the key: made by an owner or admin (shown once, kept as a hash), only with a booking page address; a new key
//      stops the old; turned off, nothing answers
//   2. the routes: no key, a wrong key or another company's key is a 401; with the key, ticket status by number and
//      phone (the last four digits), hours, classes with seats, open drop-off times; nothing else (404)
//   3. booking a drop-off through the link: refused in words while online booking is off; with it on, the appointment
//      is made like an online booking; no Assistant call anywhere
//   4. the public links address lets /api/public/ through
//   npm run -s check scripts/checks/status-link.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { makeStatusKeyFor, removeStatusKeyFor, saveCustomerAnswersFor, shopForKey } from "@/lib/customer-answers";
import { linksHostDecision } from "@/lib/links-host";
import { GET, POST } from "@/app/api/public/v1/[slug]/[what]/route";
import { RUN } from "./tenant";
import { expectUserError, ok, stepCount } from "./assistant-hub";
import { checkShop, cleanup } from "./lib";

const DAY = 86_400_000;
let ip = 0;
const call = (method: "GET" | "POST", slug: string, what: string, key: string | null, o: { query?: string; body?: unknown } = {}) => {
  ip += 1;
  const req = new Request(`http://localhost/api/public/v1/${slug}/${what}${o.query ? `?${o.query}` : ""}`, {
    method,
    headers: { "x-forwarded-for": `10.1.2.${ip % 250}`, ...(key ? { authorization: `Bearer ${key}` } : {}), ...(o.body ? { "content-type": "application/json" } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return (method === "GET" ? GET : POST)(req, { params: Promise.resolve({ slug, what }) });
};

async function main() {
  const a = await checkShop({ retail: true, repair: true, modules: ["scheduling"] });
  const b = await checkShop({ retail: true, repair: true });
  const slugA = `sl-${RUN}-a`.toLowerCase();
  const slugB = `sl-${RUN}-b`.toLowerCase();

  // ===== 1. the key =====
  await expectUserError("no booking address", () => makeStatusKeyFor(a.user), /booking page address/);
  await db.shop.update({ where: { id: a.shopId }, data: { bookingSlug: slugA, phone: "555-000-1111", openHours: [{ day: 6, from: "10:00", to: "14:00" }] } });
  await db.shop.update({ where: { id: b.shopId }, data: { bookingSlug: slugB } });
  await expectUserError("a tech", () => makeStatusKeyFor({ ...a.user, role: "TECH" }), /owner or an admin/);
  const old = await makeStatusKeyFor(a.user);
  const key = await makeStatusKeyFor(a.user);
  assert.match(key, /^sbk_[A-Za-z0-9_-]{32}$/);
  const row = await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { statusKeyHash: true, statusKeyAt: true } });
  assert.ok(row.statusKeyHash && !row.statusKeyHash.includes(key) && row.statusKeyAt, "kept as a hash");
  assert.equal((await shopForKey(slugA, key))?.id, a.shopId);
  assert.equal(await shopForKey(slugA, old), null, "a new key stops the old");
  assert.equal(await shopForKey(slugA, null), null);
  assert.equal(await shopForKey(slugA, "sbk_wrongwrongwrongwrongwrongwrong"), null);
  const keyB = await makeStatusKeyFor(b.user);
  assert.equal(await shopForKey(slugA, keyB), null, "another company's key");
  ok("the key: owners and admins, a booking address first, kept as a hash; a new key stops the old");

  // ===== 2. the routes =====
  assert.equal((await call("GET", slugA, "hours", null)).status, 401);
  assert.equal((await call("GET", slugA, "hours", old)).status, 401);
  assert.equal((await call("GET", slugA, "hours", keyB)).status, 401);
  const hours = await call("GET", slugA, "hours", key);
  assert.equal(hours.status, 200);
  assert.deepEqual(await hours.json(), { answer: "We're open Saturday, 10 am to 2 pm." });
  const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Quill", phone: "555-123-4567" } });
  const m = await db.machine.create({ data: { shopId: a.shopId, brand: "Janome", model: "MC6700P", modelKey: "MC6700P", kind: "sewing" } });
  await db.ticket.create({ data: { shopId: a.shopId, number: 77, machineId: m.id, customerId: cust.id, status: "WAITING_PARTS" } });
  const st = await (await call("GET", slugA, "status", key, { query: "ticket=77&phone=5551234567" })).json();
  assert.deepEqual(st, { answer: "Your machine (ticket #77) is waiting for a part. We'll let you know when it's ready.", found: true });
  const wrong = await (await call("GET", slugA, "status", key, { query: "ticket=77&phone=1111" })).json();
  assert.equal(wrong.found, false);
  const classes = await (await call("GET", slugA, "classes", key)).json();
  assert.deepEqual(classes.classes, []);
  assert.equal((await call("GET", slugA, "customers", key)).status, 404, "nothing else is reachable");
  assert.equal((await call("POST", slugA, "hours", key)).status, 404);
  ok("the routes: a 401 without the right key; status, hours, classes with it; nothing else");

  // ===== 3. booking a drop-off =====
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: "09:00", to: "17:00" }));
  const type = await db.appointmentType.create({ data: { shopId: a.shopId, name: "Machine drop-off", minutes: 30, capacity: 2, hours: everyDay, online: true } });
  const off = await (await call("GET", slugA, "dropoff", key)).json();
  assert.equal(off.bookingOpen, false);
  const startsAt = new Date(Date.now() + 3 * DAY);
  startsAt.setUTCHours(15, 0, 0, 0); // 11:00 in New York
  const refused = await call("POST", slugA, "book", key, { body: { typeId: type.id, startsAt: startsAt.toISOString(), name: "Pat Quill", phone: "312-867-5309" } });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /isn't available/);
  await db.shop.update({ where: { id: a.shopId }, data: { bookingOn: true } });
  const dropoff = await (await call("GET", slugA, "dropoff", key)).json();
  assert.equal(dropoff.bookingOpen, true);
  assert.equal(dropoff.types[0].name, "Machine drop-off");
  assert.ok(dropoff.types[0].times.length > 0);
  const booked = await call("POST", slugA, "book", key, { body: { typeId: type.id, startsAt: startsAt.toISOString(), name: "Pat Quill", phone: "312-867-5309" } });
  const bj = await booked.json();
  assert.equal(booked.status, 200, JSON.stringify(bj));
  const appt = await db.appointment.findFirstOrThrow({ where: { id: bj.appointmentId, shopId: a.shopId } });
  assert.deepEqual([appt.source, appt.note, appt.startsAt.toISOString()], ["online", "Booked by the phone-answering service", startsAt.toISOString()]);
  assert.equal(await db.assistantCall.count({ where: { shopId: a.shopId } }), 0, "no Assistant call anywhere");
  ok("a drop-off: refused while booking is off, booked like an online booking when it's on; no Assistant");

  // ===== off again, and the links address =====
  await removeStatusKeyFor(a.user);
  assert.equal((await call("GET", slugA, "hours", key)).status, 401, "turned off: nothing answers");
  await saveCustomerAnswersFor(a.user, { on: false, cap: 20, hours: [], hoursNote: null });
  assert.equal(linksHostDecision("GET", `/api/public/v1/${slugA}/hours`, new Headers()), "pass");
  assert.equal(linksHostDecision("POST", `/api/public/v1/${slugA}/book`, new Headers()), "pass");
  ok("turned off: a 401; the public links address lets /api/public/ through");

  console.log(`status-link check: ${stepCount()} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await db.$disconnect();
  });
