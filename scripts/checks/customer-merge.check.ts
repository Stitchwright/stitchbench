// Merging and deleting customers and machines (round 3 L126, batch F): the reference lists against the schema (every
// relation to Customer or Machine and every plain customerId / machineId / accountId column is handled); a customer
// merge moves every reference, fills blanks, notes the merge, carries marketing-text consent only for the same number
// and keeps the consent history as it was; a customer delete is refused while work is open or money owed, then keeps
// money records without the person's details, keeps consent records and opt-outs (privacy-policy-DRAFT.md 6.3, 8),
// cancels queued messages and deletes what nothing needs; machines likewise; owner or admin only, the typed name;
// tenant: company B's owner can't read, merge or delete A's records, nor merge B's into A's.
//   npm run check scripts/checks/customer-merge.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { modelKey } from "@/lib/format";
import type { Customer, Machine, VacCare } from "@/generated/prisma/client";
import {
  CUSTOMER_LISTS,
  CUSTOMER_REFS,
  customerDeletePlan,
  customerFill,
  customerMergeCandidates,
  customerMergePlan,
  DELETED_NAME,
  deleteCustomerFor,
  deleteMachineFor,
  MACHINE_REFS,
  machineDeletePlan,
  machineFill,
  machineMergeCandidates,
  machineMergePlan,
  mergeCustomersFor,
  mergeMachinesFor,
  refCount,
  vacCombine,
  type Ref,
} from "@/lib/merge";
import type { CurrentUser } from "@/lib/session";
import { checkShop, cleanup, clearKick } from "./lib";
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

const key = (r: { model: string; field: string }) => `${r.model}.${r.field}`;
const token = () => crypto.randomBytes(16).toString("hex");
const DAY = 86_400_000;

/** From prisma/schema.prisma: every relation scalar pointing at `target`, and every column named in `names` (plain ids). */
function schemaRefs(target: string, names: string[]): string[] {
  const text = fs.readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
  const out = new Set<string>();
  for (const m of text.matchAll(/^model (\w+) \{\n([\s\S]*?)\n\}/gm)) {
    // A column that is the key of a relation to another model (AccountEntry.accountId -> HouseAccount) isn't a plain customer id.
    const keyed = new Set([...m[2].matchAll(/@relation\([^)]*fields:\s*\[(\w+)\]/g)].map((x) => x[1]));
    for (const line of m[2].split("\n")) {
      const f = /^\s+(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/.exec(line);
      if (!f) continue;
      const [, name, type, , rest] = f;
      if (type === target) {
        const fields = /@relation\([^)]*fields:\s*\[(\w+)\]/.exec(rest);
        if (fields) out.add(`${m[1]}.${fields[1]}`);
      } else if (type === "String" && names.includes(name) && m[1] !== target && !keyed.has(name)) {
        out.add(`${m[1]}.${name}`);
      }
    }
  }
  return [...out].sort();
}

/** Json columns whose comment says they hold customer ids. */
function schemaCustomerLists(): string[] {
  const text = fs.readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
  const out: string[] = [];
  for (const m of text.matchAll(/^model (\w+) \{\n([\s\S]*?)\n\}/gm)) {
    for (const line of m[2].split("\n")) {
      const f = /^\s+(\w+)\s+Json\??\s.*\/\/.*customer ids/i.exec(line);
      if (f) out.push(`${m[1]}.${f[1]}`);
    }
  }
  return out.sort();
}

async function counts(refs: readonly Ref[], id: string, shopId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of refs) out[key(r)] = await refCount(db, r, id, shopId);
  return out;
}

let n = 9100;
const nextNo = () => n++;

async function main() {
  const a = await checkShop({ retail: true, repair: true });
  const b = await checkShop({ retail: true, repair: true });
  const A = a.shopId;
  const tech: CurrentUser = { ...a.user, role: "TECH" };
  try {
    // ---------- 0. the pure parts ----------
    const base: Customer = {
      id: "x",
      shopId: A,
      kind: "RETAIL",
      name: "Kept",
      phone: null,
      email: null,
      address: null,
      code: null,
      commissionPct: null,
      routeDay: null,
      notes: null,
      notifyBy: "",
      smsConsentAt: null,
      smsConsentPhone: null,
      smsConsentSource: null,
      smsConsentText: null,
      lastReviewAskAt: null,
      longarmCertifiedAt: null,
      taxExemptId: null,
      taxExemptUntil: null,
      createdAt: new Date(),
    };
    const consentAt = new Date("2026-05-01T15:00:00Z");
    const dupC: Customer = {
      ...base,
      id: "y",
      name: "Dup",
      phone: "212-555-0199",
      email: "d@example.test",
      address: "9 Oak Ave",
      notes: "Calls after 5",
      notifyBy: "sms",
      smsConsentAt: consentAt,
      smsConsentPhone: "+12125550199",
      smsConsentSource: "counter",
      smsConsentText: "Yes to texts",
    };
    let f = customerFill(dupC, { ...base, address: "1 Elm St", notes: "Likes Tuesdays" }, "Oct 3, 2026");
    assert.equal(f.data.phone, "212-555-0199");
    assert.equal(f.data.email, "d@example.test");
    assert.equal(f.data.address, undefined, "the kept address stays");
    assert.equal(f.data.notifyBy, "sms");
    assert.equal(f.consent, true);
    assert.equal(f.data.smsConsentPhone, "+12125550199");
    assert.equal(f.data.notes, "Likes Tuesdays\nMerged from Dup on Oct 3, 2026: address 9 Oak Ave. Their notes: Calls after 5");
    f = customerFill(dupC, { ...base, phone: "(212) 555-0142" }, "Oct 3, 2026");
    assert.equal(f.consent, false, "consent for another number doesn't carry over");
    assert.equal(f.data.smsConsentAt, undefined);
    assert.match(String(f.data.notes), /phone 212-555-0199/);
    const m0: Machine = {
      id: "m",
      shopId: A,
      brand: "Janome",
      model: "MC6700P",
      modelKey: "MC6700P",
      serial: null,
      machineType: null,
      customerId: null,
      notes: null,
      equipment: "SEWING",
      kind: "sewing",
      details: { a: 1 },
      serviceNoticeFor: null,
      createdAt: new Date(),
    };
    const mf = machineFill({ ...m0, serial: "S1", customerId: "c1", notes: "Bent needle bar", details: { a: 2, b: 3 } }, m0, "Oct 3, 2026");
    assert.deepEqual([mf.data.serial, mf.data.customerId, mf.data.details], ["S1", "c1", { a: 1, b: 3 }]);
    assert.equal(mf.line, "Merged from Janome MC6700P SN S1 on Oct 3, 2026. Its notes: Bent needle bar");
    const vc = (o: Partial<VacCare>): VacCare => ({
      machineId: "m",
      shopId: A,
      contactedAt: null,
      contactedBy: null,
      contactNote: null,
      snoozedUntil: null,
      stopped: false,
      updatedAt: new Date(),
      ...o,
    });
    const v = vacCombine(
      vc({ contactedAt: new Date(2026, 8, 2), contactedBy: "Ann", snoozedUntil: new Date(2026, 9, 1), stopped: true }),
      vc({ contactedAt: new Date(2026, 8, 1), contactedBy: "Bob", snoozedUntil: new Date(2026, 10, 1) }),
    );
    assert.deepEqual([v.contactedBy, (v.snoozedUntil as Date).getMonth(), v.stopped], ["Ann", 10, true]);
    ok("customerFill fills blanks, carries text consent only for the same number, notes the rest; machineFill and vacCombine");

    // ---------- 1. the reference lists against the schema ----------
    const custSchema = schemaRefs("Customer", ["customerId", "accountId", "consignorId"]);
    assert.deepEqual(custSchema, CUSTOMER_REFS.map(key).sort(), "CUSTOMER_REFS is every column that points at a customer");
    const machSchema = schemaRefs("Machine", ["machineId"]);
    assert.deepEqual(
      machSchema,
      MACHINE_REFS.filter((r) => !r.tag)
        .map(key)
        .sort(),
      "MACHINE_REFS (untagged) is every column that points at a machine",
    );
    assert.deepEqual(schemaCustomerLists(), CUSTOMER_LISTS.map(key).sort(), "CUSTOMER_LISTS is every Json list of customer ids");
    ok(`the lists match the schema: ${CUSTOMER_REFS.length} customer references, ${MACHINE_REFS.length} machine references (one tagged), ${CUSTOMER_LISTS.length} id list`);

    // ---------- 2. customer merge ----------
    const keep = await db.customer.create({ data: { shopId: A, name: "Jane Doe", address: "1 Elm St", notes: "Likes Tuesday pickups" } });
    const dup = await db.customer.create({
      data: {
        shopId: A,
        name: "Jane  Doe (dup)",
        phone: "212-555-0199",
        email: "jane@example.test",
        address: "9 Oak Ave",
        notes: "From check-in",
        notifyBy: "sms",
        smsConsentAt: consentAt,
        smsConsentPhone: "+12125550199",
        smsConsentSource: "counter",
        smsConsentText: "Yes to texts",
      },
    });
    const other = await db.customer.create({ data: { shopId: A, name: "Someone Else" } });
    const keepM = await db.machine.create({ data: { shopId: A, customerId: keep.id, brand: "Bernina", model: "B 570", modelKey: modelKey("B 570") } });
    const dupM = await db.machine.create({ data: { shopId: A, customerId: dup.id, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
    await db.ticket.create({ data: { shopId: A, number: nextNo(), machineId: keepM.id, customerId: keep.id, status: "COLLECTED" } });
    await db.ticket.create({ data: { shopId: A, number: nextNo(), machineId: dupM.id, customerId: dup.id, status: "ON_BENCH" } });
    await db.ticket.create({ data: { shopId: A, number: nextNo(), machineId: keepM.id, customerId: keep.id, viaAccountId: dup.id, status: "COLLECTED" } });
    await db.sale.create({ data: { shopId: A, number: nextNo(), customerId: dup.id, subtotalCents: 1000, taxCents: 0, totalCents: 1000, taxRatePct: 0 } });
    await db.repairJob.create({ data: { id: `rj${token()}`, shopId: A, linkId: "l1", side: "retail", tag: "T1", customerId: dup.id, customerName: "Jane D.", brand: "Singer", model: "201" } });
    await db.outMessage.createMany({
      data: [
        { shopId: A, channel: "email", purpose: "notice", kind: "ready", customerId: dup.id, address: "jane@example.test", body: "Ready", status: "SENT", sentAt: new Date() },
        { shopId: A, channel: "email", purpose: "notice", kind: "ready", customerId: dup.id, address: "jane@example.test", body: "Ready again", status: "QUEUED" },
      ],
    });
    const ev1 = await db.consentEvent.create({
      data: { shopId: A, customerId: dup.id, channel: "sms", event: "marketing_yes", address: "+12125550199", source: "counter", detail: "Yes to texts", at: consentAt },
    });
    const ev2 = await db.consentEvent.create({
      data: { shopId: A, customerId: dup.id, channel: "any", event: "notify_pref", source: "intake", detail: "sms", at: new Date(consentAt.getTime() + 1000) },
    });
    await db.suppression.create({ data: { shopId: A, channel: "email", address: "jane@example.test", scope: "marketing", source: "unsubscribe_link" } });
    const pastClass = await db.shopClass.create({
      data: { shopId: A, title: "Quilting 101", seats: 8, meetings: { create: { shopId: A, startsAt: new Date(Date.now() - 10 * DAY), endsAt: new Date(Date.now() - 10 * DAY + 7_200_000) } } },
    });
    await db.enrollment.create({ data: { shopId: A, classId: pastClass.id, customerId: dup.id, name: "Jane Doe", feeCents: 0 } });
    await db.appointment.create({
      data: { shopId: A, customerId: dup.id, name: "Jane Doe", title: "Lesson", startsAt: new Date(Date.now() - 5 * DAY), endsAt: new Date(Date.now() - 5 * DAY + 3_600_000), status: "DONE" },
    });
    await db.bookingLink.create({ data: { shopId: A, customerId: dup.id, tokenHash: token(), expiresAt: new Date(Date.now() + DAY) } });
    await db.webOrder.create({ data: { shopId: A, number: nextNo(), customerId: dup.id, name: "Jane Doe", subtotalCents: 500, taxCents: 0, totalCents: 500, tokenHash: token(), status: "DONE" } });
    await db.giftCard.create({ data: { shopId: A, number: `CHK${token()}`.toUpperCase().slice(0, 20), customerId: dup.id, balanceCents: 0 } });
    await db.inboundText.create({ data: { shopId: A, sid: `SM${token()}`, fromNumber: "+12125550199", body: "Thanks!", receivedAt: new Date(), customerId: dup.id } });
    await db.estimateLink.create({ data: { shopId: A, customerId: dup.id, tokenHash: token(), maskedUrl: "https://x/e/•••abcd", totalCents: 4500, lines: [], expiresAt: new Date(Date.now() + DAY) } });
    await db.partnerLink.create({ data: { id: `chk${token()}`, shopId: A, side: "repair", partnerName: "Quilt Shop", accountId: dup.id } });
    await db.longarmOrder.create({ data: { shopId: A, number: 1, customerId: dup.id, name: "Jane Doe", status: "COLLECTED", widthIn: 40, lengthIn: 50, quiltCents: 5000, totalCents: 5000 } });
    await db.makeJob.create({ data: { shopId: A, number: 1, customerId: dup.id, name: "Jane Doe", status: "COLLECTED", title: "Name tags" } });
    await db.layaway.create({ data: { shopId: A, number: 1, customerId: dup.id, status: "COMPLETED", dueBy: "2026-12-31", terms: "Terms" } });
    await db.softwareLicense.create({ data: { shopId: A, customerId: dup.id, description: "PE-Design 11", code: "ABC-123", startsOn: new Date() } });
    await db.certification.create({ data: { shopId: A, customerId: dup.id, equipment: "Laser" } });
    await db.appraisal.create({ data: { shopId: A, number: 1, customerId: dup.id, name: "Jane Doe" } });
    await db.giftRegistry.create({ data: { shopId: A, customerId: dup.id, name: "Jane Doe", title: "Jane's list", token: `t${token()}`.slice(0, 30) } });
    await db.houseAccount.create({ data: { shopId: A, customerId: dup.id } });
    const consM = await db.machine.create({ data: { shopId: A, brand: "Bernina", model: "830", modelKey: modelKey("830") } });
    const consU = await db.stockUnit.create({ data: { shopId: A, machineId: consM.id, status: "SOLD", consignorId: dup.id } });
    await db.consignPayout.create({ data: { shopId: A, unitId: consU.id, customerId: dup.id, saleLineId: "x", soldCents: 1000, pct: 25, amountCents: 750, paidAt: new Date(), method: "CASH" } });
    const srdup = await db.kitSeries.create({ data: { shopId: A, name: "Merge BOM dup", months: 3 } });
    await db.kitSeriesMember.create({ data: { shopId: A, seriesId: srdup.id, customerId: dup.id } });
    const cldup = await db.club.create({ data: { shopId: A, name: "Merge club dup", monthlyCents: 1000 } });
    await db.clubMember.create({ data: { shopId: A, clubId: cldup.id, customerId: dup.id } });
    const camp = await db.campaign.create({ data: { shopId: A, name: "Fall sale", channel: "email", body: "Hi", audience: {}, status: "SENT", members: [other.id, dup.id, keep.id] } });

    const beforeDup = await counts(CUSTOMER_REFS, dup.id, A);
    const beforeKeep = await counts(CUSTOMER_REFS, keep.id, A);
    for (const r of CUSTOMER_REFS) assert.ok(beforeDup[key(r)] > 0, `the check seeds a row for ${key(r)}`);
    const supBefore = await db.suppression.count({ where: { shopId: A } });

    // The plan, candidates and refusals first (nothing changes).
    const plan = await customerMergePlan(a.user, dup.id, keep.id);
    assert.equal(plan.blockers.length, 0);
    assert.equal(plan.confirm, dup.name);
    assert.ok(plan.rows.some((r) => /consent records?/.test(r.what) && /unchanged/.test(r.then)));
    assert.ok(plan.rows.some((r) => /campaign list/.test(r.what)));
    assert.ok(plan.notes.some((x) => /carries over/.test(x)));
    const cands = await customerMergeCandidates(a.user, dup.id, "jane");
    assert.ok(cands.some((c) => c.id === keep.id) && !cands.some((c) => c.id === dup.id));
    await expectError("into itself", () => mergeCustomersFor(a.user, dup.id, dup.id, dup.name), /merged into itself/);
    await expectError("wrong name typed", () => mergeCustomersFor(a.user, dup.id, keep.id, "Jane Doe"), /Type Jane {2}Doe \(dup\) to confirm/);
    await expectError("a tech", () => mergeCustomersFor(tech, dup.id, keep.id, dup.name), /Only the shop owner or an admin/);
    await expectError("a tech's preview", () => customerMergePlan(tech, dup.id, keep.id), /Only the shop owner or an admin/);
    const trade = await db.customer.create({ data: { shopId: A, kind: "TRADE", name: "Quilt Shop", code: "QS1" } });
    await expectError("retail into a shop account", () => mergeCustomersFor(a.user, dup.id, trade.id, dup.name), /shop account/);
    assert.deepEqual(await counts(CUSTOMER_REFS, dup.id, A), beforeDup, "a refused merge moves nothing");

    // The merge (the typed name in another case and spacing).
    assert.equal(await mergeCustomersFor(a.user, dup.id, keep.id, "  jane doe (DUP) "), keep.id);
    assert.equal(await db.customer.count({ where: { id: dup.id } }), 0, "the duplicate is gone");
    const afterDup = await counts(CUSTOMER_REFS, dup.id, A);
    const afterKeep = await counts(CUSTOMER_REFS, keep.id, A);
    for (const r of CUSTOMER_REFS) {
      assert.equal(afterDup[key(r)], 0, `${key(r)}: nothing points at the duplicate`);
      assert.equal(afterKeep[key(r)], beforeKeep[key(r)] + beforeDup[key(r)], `${key(r)}: every row moved to the kept customer`);
    }
    const kept = await db.customer.findUniqueOrThrow({ where: { id: keep.id } });
    assert.equal(kept.phone, "212-555-0199");
    assert.equal(kept.email, "jane@example.test");
    assert.equal(kept.address, "1 Elm St");
    assert.equal(kept.notifyBy, "sms");
    assert.match(kept.notes ?? "", /^Likes Tuesday pickups\nMerged from Jane {2}Doe \(dup\) on \w{3} \d+, \d{4}: address 9 Oak Ave\. Their notes: From check-in$/);
    assert.equal(kept.smsConsentAt?.getTime(), consentAt.getTime(), "text consent carried: it is for the kept customer's number now");
    assert.equal(kept.smsConsentPhone, "+12125550199");
    const evs = await db.consentEvent.findMany({ where: { id: { in: [ev1.id, ev2.id] } }, orderBy: { at: "asc" } });
    assert.deepEqual(
      evs.map((e) => [e.id, e.customerId, e.at.getTime(), e.event, e.address, e.detail]),
      [
        [ev1.id, keep.id, ev1.at.getTime(), "marketing_yes", "+12125550199", "Yes to texts"],
        [ev2.id, keep.id, ev2.at.getTime(), "notify_pref", null, "sms"],
      ],
      "the consent history moved as it was",
    );
    assert.equal(await db.suppression.count({ where: { shopId: A } }), supBefore, "opt-outs are by address: untouched");
    assert.deepEqual((await db.campaign.findUniqueOrThrow({ where: { id: camp.id } })).members, [other.id, keep.id, keep.id], "campaign list: replaced in place");
    ok("customer merge: every reference moves (14 columns and the campaign list), blanks filled, the note, consent carried, the consent history and opt-outs kept; refusals change nothing");

    // ---------- 3. customer delete ----------
    const del = await db.customer.create({
      data: {
        shopId: A,
        name: "Del Person",
        phone: "(212) 555-0177",
        email: "del@example.test",
        notifyBy: "both",
        smsConsentAt: consentAt,
        smsConsentPhone: "+12125550177",
        smsConsentSource: "counter",
        smsConsentText: "Yes",
      },
    });
    const dm1 = await db.machine.create({ data: { shopId: A, customerId: del.id, brand: "Brother", model: "CS6000i", modelKey: modelKey("CS6000i"), notes: "Wobbly handwheel" } });
    const dm2 = await db.machine.create({ data: { shopId: A, customerId: del.id, brand: "Kenmore", model: "158", modelKey: modelKey("158"), equipment: "VACUUM", kind: "vacuum" } });
    await db.machinePhoto.create({ data: { shopId: A, machineId: dm2.id, mime: "image/jpeg", data: Buffer.from([1, 2, 3]) } });
    await db.vacCare.create({ data: { machineId: dm2.id, shopId: A } });
    const dm3 = await db.machine.create({ data: { shopId: A, customerId: del.id, brand: "Oreck", model: "XL", modelKey: modelKey("XL"), equipment: "VACUUM", kind: "vacuum" } });
    const bagSale = await db.sale.create({
      data: {
        shopId: A,
        number: nextNo(),
        customerId: del.id,
        subtotalCents: 900,
        taxCents: 0,
        totalCents: 900,
        taxRatePct: 0,
        lines: { create: { description: "Bags", qty: 1, unitPriceCents: 900, machineId: dm3.id } },
      },
    });
    const dt = await db.ticket.create({
      data: {
        shopId: A,
        number: nextNo(),
        machineId: dm1.id,
        customerId: del.id,
        status: "ON_BENCH",
        jobType: "SITE",
        lines: { create: { kind: "SERVICE", description: "Install", unitPriceCents: 5000, taxable: false } },
      },
    });
    await db.ticketSite.create({ data: { ticketId: dt.id, shopId: A, address: "12 Home St", contactName: "Del", contactPhone: "212-555-0177", accessNotes: "Gate 1234" } });
    const appt = await db.appointment.create({
      data: { shopId: A, customerId: del.id, name: "Del Person", title: "Lesson", startsAt: new Date(Date.now() + 2 * DAY), endsAt: new Date(Date.now() + 2 * DAY + 3_600_000), note: "Bring fabric" },
    });
    const order = await db.webOrder.create({
      data: {
        shopId: A,
        number: nextNo(),
        customerId: del.id,
        name: "Del Person",
        phone: "212-555-0177",
        email: "del@example.test",
        fulfil: "ship",
        address: "5 Ship Rd",
        subtotalCents: 2000,
        taxCents: 120,
        totalCents: 2120,
        tokenHash: token(),
        linkSealed: "sealed",
        status: "PAID",
      },
    });
    const pickup = await db.webOrder.create({
      data: {
        shopId: A,
        number: nextNo(),
        customerId: del.id,
        name: "Del Person",
        email: "del@example.test",
        fulfil: "pickup",
        address: "typed anyway",
        subtotalCents: 300,
        taxCents: 0,
        totalCents: 300,
        tokenHash: token(),
        status: "DONE",
      },
    });
    const future = await db.shopClass.create({
      data: { shopId: A, title: "Free-motion quilting", seats: 6, meetings: { create: { shopId: A, startsAt: new Date(Date.now() + 7 * DAY), endsAt: new Date(Date.now() + 7 * DAY + 7_200_000) } } },
    });
    const seat = await db.enrollment.create({
      data: { shopId: A, classId: future.id, customerId: del.id, name: "Del Person", attendee: "Del's daughter", feeCents: 4000, paidCents: 4000, paidAt: new Date(), note: "Left-handed" },
    });
    const job = await db.repairJob.create({
      data: { id: `rj${token()}`, shopId: A, linkId: "l1", side: "retail", tag: "T9", customerId: del.id, customerName: "Del P.", brand: "Singer", model: "301", status: "ON_BENCH" },
    });
    const delLink = await db.partnerLink.create({ data: { id: `chk${token()}`, shopId: A, side: "repair", partnerName: "Old partner", accountId: del.id, status: "ACTIVE" } });
    const sent = await db.outMessage.create({
      data: { shopId: A, channel: "sms", purpose: "notice", kind: "ready", customerId: del.id, address: "+12125550177", body: "Your machine is ready", status: "SENT", sentAt: new Date() },
    });
    const queued = await db.outMessage.create({
      data: { shopId: A, channel: "email", purpose: "marketing", kind: "campaign", customerId: del.id, address: "del@example.test", body: "Sale!", status: "QUEUED" },
    });
    const dEv = await db.consentEvent.create({
      data: { shopId: A, customerId: del.id, channel: "sms", event: "marketing_yes", address: "+12125550177", source: "counter", detail: "Yes", at: consentAt },
    });
    await db.suppression.create({ data: { shopId: A, channel: "email", address: "del@example.test", scope: "marketing", source: "unsubscribe_link" } });
    await db.bookingLink.create({ data: { shopId: A, customerId: del.id, appointmentId: appt.id, tokenHash: token(), expiresAt: new Date(Date.now() + DAY) } });
    const reply = await db.inboundText.create({ data: { shopId: A, sid: `SM${token()}`, fromNumber: "+12125550177", body: "OK", receivedAt: new Date(), customerId: del.id } });
    const est = await db.estimateLink.create({
      data: {
        shopId: A,
        ticketId: dt.id,
        customerId: del.id,
        tokenHash: token(),
        tokenSealed: "sealed",
        maskedUrl: "https://x/e/•••wxyz",
        totalCents: 5000,
        lines: [],
        expiresAt: new Date(Date.now() + DAY),
        answer: "APPROVED",
        answeredAt: new Date(),
      },
    });
    await db.longarmOrder.create({ data: { shopId: A, number: 2, customerId: del.id, name: "Jane Doe", status: "COLLECTED", widthIn: 40, lengthIn: 50, quiltCents: 5000, totalCents: 5000 } });
    const delLayaway = await db.layaway.create({ data: { shopId: A, number: 2, customerId: del.id, status: "OPEN", dueBy: "2026-12-31", terms: "Terms" } });
    await db.softwareLicense.create({ data: { shopId: A, customerId: del.id, description: "PE-Design 11", code: "DEL-1", startsOn: new Date() } });
    await db.certification.create({ data: { shopId: A, customerId: del.id, equipment: "Longarm" } });
    await db.makeJob.create({ data: { shopId: A, number: 2, customerId: del.id, name: "Del Person", status: "COLLECTED", title: "Keychain" } });
    await db.appraisal.create({ data: { shopId: A, number: 2, customerId: del.id, name: "Del Person" } });
    await db.giftRegistry.create({ data: { shopId: A, customerId: del.id, name: "Del Person", title: "Del's list", token: `d${token()}`.slice(0, 30) } });
    await db.houseAccount.create({ data: { shopId: A, customerId: del.id } });
    const delConsM = await db.machine.create({ data: { shopId: A, brand: "Bernina", model: "740", modelKey: modelKey("740") } });
    const delConsU = await db.stockUnit.create({ data: { shopId: A, machineId: delConsM.id, status: "SOLD", consignorId: del.id } });
    await db.consignPayout.create({ data: { shopId: A, unitId: delConsU.id, customerId: del.id, saleLineId: "y", soldCents: 1000, pct: 25, amountCents: 750, paidAt: new Date(), method: "CASH" } });
    const srdel = await db.kitSeries.create({ data: { shopId: A, name: "Merge BOM del", months: 3 } });
    await db.kitSeriesMember.create({ data: { shopId: A, seriesId: srdel.id, customerId: del.id } });
    const cldel = await db.club.create({ data: { shopId: A, name: "Merge club del", monthlyCents: 1000 } });
    await db.clubMember.create({ data: { shopId: A, clubId: cldel.id, customerId: del.id } });
    await db.giftCard.create({ data: { shopId: A, number: `CHD${token()}`.toUpperCase().slice(0, 20), customerId: del.id, balanceCents: 0 } });
    const camp2 = await db.campaign.create({ data: { shopId: A, name: "Spring", channel: "email", body: "Hi", audience: {}, status: "SENT", members: [del.id, other.id] } });
    for (const r of CUSTOMER_REFS) {
      if (r.field !== "viaAccountId") assert.ok((await refCount(db, r, del.id, A)) > 0, `the check seeds a row for ${key(r)} on the deleted customer`);
    }

    const dplan = await customerDeletePlan(a.user, del.id);
    const why = dplan.blockers.join(" ");
    for (const re of [
      /Ticket #\d+ is still open/,
      /Online order #\d+ isn't finished \(paid, not packed\)/,
      /Lesson on .* is still booked/,
      /seat in Free-motion quilting/,
      /Partner repair tag T9/,
      /partnership with Old partner/,
      /Layaway #2 is still being paid for/,
    ]) {
      assert.match(why, re);
    }
    assert.equal(dplan.blockers.length, 7);
    await expectError("delete while open", () => deleteCustomerFor(a.user, del.id, del.name), /Del Person can't be deleted yet\. Ticket #\d+ is still open\..*\(and 4 more\)/);
    await db.layaway.update({ where: { id: delLayaway.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    // Close each: the ticket collected but unpaid is still refused (money owed).
    await db.ticket.update({ where: { id: dt.id }, data: { status: "COLLECTED", closedAt: new Date() } });
    await db.webOrder.update({ where: { id: order.id }, data: { status: "DONE" } });
    await db.appointment.update({ where: { id: appt.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await db.enrollment.update({ where: { id: seat.id }, data: { status: "CANCELLED", refundedCents: 4000, refundedAt: new Date() } });
    await db.repairJob.update({ where: { shopId_id: { shopId: A, id: job.id } }, data: { status: "COLLECTED", pickedUpAt: new Date() } });
    await db.partnerLink.update({ where: { shopId_id: { shopId: A, id: delLink.id } }, data: { status: "ENDED", endedAt: new Date() } });
    assert.deepEqual((await customerDeletePlan(a.user, del.id)).blockers, [`Ticket #${String(dt.number).padStart(4, "0")} has $50.00 owed.`]);
    await db.payment.create({ data: { ticketId: dt.id, method: "CARD", amountCents: 5000 } });
    // A shop account with tickets through it stays (its commission is in the books).
    const tradeTicket = await db.ticket.create({ data: { shopId: A, number: nextNo(), machineId: keepM.id, customerId: keep.id, viaAccountId: trade.id, status: "COLLECTED" } });
    assert.match((await customerDeletePlan(a.user, trade.id)).blockers.join(" "), /1 ticket came in through this shop account/);
    void tradeTicket;
    const plan2 = await customerDeletePlan(a.user, del.id);
    assert.deepEqual(plan2.blockers, []);
    assert.ok(plan2.rows.some((r) => r.what === "1 machine" && /deleted/.test(r.then)) && plan2.rows.some((r) => r.what === "2 machines" && /kept without an owner/.test(r.then)));
    assert.ok(plan2.rows.some((r) => /consent record/.test(r.what) && /law expects/.test(r.then)));
    assert.ok(plan2.rows.some((r) => r.what === "1 opt-out"));
    await expectError("wrong name typed", () => deleteCustomerFor(a.user, del.id, "Del"), /Type Del Person to confirm/);
    await expectError("a tech", () => deleteCustomerFor(tech, del.id, del.name), /Only the shop owner or an admin/);

    await deleteCustomerFor(a.user, del.id, "del person");
    assert.equal(await db.customer.count({ where: { id: del.id } }), 0);
    for (const r of CUSTOMER_REFS) assert.equal(await refCount(db, r, del.id, A), 0, `${key(r)}: nothing points at the deleted customer`);
    assert.deepEqual((await db.campaign.findUniqueOrThrow({ where: { id: camp2.id } })).members, ["", other.id], "campaign list: the id is blanked in place");
    // Money records kept, without the person.
    const t = await db.ticket.findUniqueOrThrow({ where: { id: dt.id }, include: { lines: true, payments: true, site: true } });
    assert.deepEqual([t.customerId, t.lines.length, t.payments.length, t.machineId], [null, 1, 1, dm1.id]);
    assert.deepEqual([t.site?.address, t.site?.contactName, t.site?.contactPhone, t.site?.accessNotes], ["12 Home St", null, null, null]);
    assert.equal((await db.sale.findUniqueOrThrow({ where: { id: bagSale.id } })).customerId, null);
    const j = await db.repairJob.findUniqueOrThrow({ where: { shopId_id: { shopId: A, id: job.id } } });
    assert.deepEqual([j.customerId, j.customerName], [null, "Del P."]);
    const o1 = await db.webOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.deepEqual([o1.customerId, o1.name, o1.phone, o1.email, o1.address, o1.linkSealed, o1.totalCents], [null, DELETED_NAME, null, null, "5 Ship Rd", null, 2120]);
    const o2 = await db.webOrder.findUniqueOrThrow({ where: { id: pickup.id } });
    assert.deepEqual([o2.name, o2.address, o2.email], [DELETED_NAME, null, null]);
    const s2 = await db.enrollment.findUniqueOrThrow({ where: { id: seat.id } });
    assert.deepEqual([s2.customerId, s2.name, s2.attendee, s2.note, s2.paidCents, s2.refundedCents], [null, DELETED_NAME, null, null, 4000, 4000]);
    const a2 = await db.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    assert.deepEqual([a2.customerId, a2.name, a2.note], [null, DELETED_NAME, null]);
    // Machines: the one with a ticket and the one bags were bought for stay without an owner; the bare one is gone.
    assert.equal((await db.machine.findUniqueOrThrow({ where: { id: dm1.id } })).customerId, null);
    assert.equal((await db.machine.findUniqueOrThrow({ where: { id: dm3.id } })).customerId, null);
    assert.equal(await db.machine.count({ where: { id: dm2.id } }), 0);
    assert.equal(await db.machinePhoto.count({ where: { machineId: dm2.id } }), 0);
    assert.equal(await db.vacCare.count({ where: { machineId: dm2.id } }), 0);
    // Messages: queued cancelled, sent kept as sent.
    const q2 = await db.outMessage.findUniqueOrThrow({ where: { id: queued.id } });
    assert.deepEqual([q2.status, q2.cancelledById, q2.customerId], ["CANCELLED", a.user.id, null]);
    const s3 = await db.outMessage.findUniqueOrThrow({ where: { id: sent.id } });
    assert.deepEqual([s3.status, s3.address, s3.body, s3.customerId], ["SENT", "+12125550177", "Your machine is ready", null]);
    // Consent: the earlier record unchanged but for the link; a "consent ended" record added; the opt-out kept.
    const e1 = await db.consentEvent.findUniqueOrThrow({ where: { id: dEv.id } });
    assert.deepEqual([e1.customerId, e1.event, e1.address, e1.detail, e1.at.getTime()], [null, "marketing_yes", "+12125550177", "Yes", consentAt.getTime()]);
    const ended = await db.consentEvent.findMany({ where: { shopId: A, address: "+12125550177", event: "marketing_no" } });
    assert.equal(ended.length, 1);
    assert.deepEqual([ended[0].detail, ended[0].byUserId, ended[0].customerId], ["Customer record deleted", a.user.id, null]);
    assert.equal(await db.suppression.count({ where: { shopId: A, address: "del@example.test" } }), 1);
    // The rest: booking links gone, the reply kept, the estimate link switched off, the ended partnership unlinked.
    assert.equal(await db.bookingLink.count({ where: { shopId: A, appointmentId: appt.id } }), 0);
    assert.equal((await db.inboundText.findUniqueOrThrow({ where: { shopId_sid: { shopId: A, sid: reply.sid } } })).customerId, null);
    const e2 = await db.estimateLink.findUniqueOrThrow({ where: { id: est.id } });
    assert.ok(e2.revokedAt && e2.tokenSealed === null && e2.customerId === null && e2.answer === "APPROVED");
    assert.equal((await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: A, id: delLink.id } } })).accountId, null);
    ok(
      "customer delete: refused while a ticket, order, booking, class seat, partner repair or partnership is open and while money is owed; then money records kept without the person, consent records and opt-outs kept, queued messages cancelled, bare machines deleted",
    );

    // ---------- 4. machine merge ----------
    const owner = await db.customer.create({ data: { shopId: A, name: "Mo Owner" } });
    const mk = await db.machine.create({ data: { shopId: A, customerId: owner.id, brand: "Janome", model: "HD3000", modelKey: modelKey("HD3000") } });
    const md = await db.machine.create({
      data: { shopId: A, customerId: owner.id, brand: "Janome", model: "HD 3000", modelKey: modelKey("HD 3000"), serial: "SN-77", notes: "Bent needle bar", details: { year: 2019 } },
    });
    await db.ticket.create({ data: { shopId: A, number: nextNo(), machineId: md.id, customerId: owner.id, status: "COLLECTED" } });
    await db.machinePhoto.create({ data: { shopId: A, machineId: md.id, mime: "image/jpeg", data: Buffer.from([4, 5, 6]) } });
    await db.repairJob.create({
      data: {
        id: `rj${token()}`,
        shopId: A,
        linkId: "l1",
        side: "retail",
        tag: "T3",
        customerName: "Mo O.",
        brand: "Janome",
        model: "HD3000",
        machineId: md.id,
        pickedUpAt: new Date(),
        status: "COLLECTED",
      },
    });
    await db.sale.create({
      data: {
        shopId: A,
        number: nextNo(),
        subtotalCents: 100,
        taxCents: 0,
        totalCents: 100,
        taxRatePct: 0,
        lines: { create: { description: "Needles", qty: 1, unitPriceCents: 100, machineId: md.id } },
      },
    });
    await db.stockUnit.create({ data: { shopId: A, machineId: md.id, status: "SOLD" } });
    await db.assistantCall.create({ data: { shopId: A, feature: "likely_causes", machineId: md.id, model: "check", request: {}, response: "" } });
    await db.softwareLicense.create({ data: { shopId: A, machineId: md.id, description: "Hatch", startsOn: new Date() } });
    await db.warrantyClaim.create({ data: { shopId: A, number: 1, machineId: md.id, maker: "Janome" } });
    await db.suppliesCare.create({ data: { shopId: A, machineId: md.id, calledAt: new Date(), calledBy: "Ann" } });
    await db.machinePlan.create({ data: { shopId: A, machineId: md.id, name: "Free yearly cleaning", visits: 3, startsAt: new Date(2026, 0, 1), endsAt: new Date(2029, 0, 1) } });
    await db.vacCare.createMany({
      data: [
        { machineId: md.id, shopId: A, contactedAt: new Date(2026, 8, 20), contactedBy: "Ann", stopped: true },
        { machineId: mk.id, shopId: A, contactedAt: new Date(2026, 8, 1), contactedBy: "Bob" },
      ],
    });
    await db.outMessage.create({
      data: { shopId: A, channel: "email", purpose: "marketing", kind: "service_due", customerId: owner.id, address: "mo@example.test", body: "Due", status: "SENT", refType: "machine", refId: md.id },
    });
    const mBeforeDup = await counts(MACHINE_REFS, md.id, A);
    const mBeforeKeep = await counts(MACHINE_REFS, mk.id, A);
    for (const r of MACHINE_REFS) assert.ok(mBeforeDup[key(r)] > 0, `the check seeds a row for ${key(r)}`);

    const mplan = await machineMergePlan(a.user, md.id, mk.id);
    assert.deepEqual(mplan.blockers, []);
    assert.ok(mplan.rows.some((r) => r.what === "Bag reminder settings" && /combined/.test(r.then)));
    assert.equal(mplan.confirm, "Janome HD 3000");
    assert.ok(
      (await machineMergeCandidates(a.user, md.id, null)).some((m) => m.id === mk.id),
      "the owner's other machine is offered",
    );
    const vac = await db.machine.create({ data: { shopId: A, brand: "Janome", model: "HD3000", modelKey: modelKey("HD3000"), equipment: "VACUUM", kind: "vacuum" } });
    await expectError("different equipment", () => mergeMachinesFor(a.user, md.id, vac.id, "Janome HD 3000"), /aren't the same kind of thing/);
    const stockA = await db.machine.create({ data: { shopId: A, brand: "Miele", model: "C3", modelKey: modelKey("C3"), equipment: "VACUUM", kind: "vacuum", stock: { create: { shopId: A } } } });
    const stockB = await db.machine.create({ data: { shopId: A, brand: "Miele", model: "C3", modelKey: modelKey("C3"), equipment: "VACUUM", kind: "vacuum", stock: { create: { shopId: A } } } });
    assert.match((await machineMergePlan(a.user, stockA.id, stockB.id)).blockers.join(" "), /Both are machines-for-sale stock/);
    await expectError("both for sale", () => mergeMachinesFor(a.user, stockA.id, stockB.id, "Miele C3"), /Both are machines-for-sale stock/);
    await expectError("wrong name typed", () => mergeMachinesFor(a.user, md.id, mk.id, "Janome"), /Type Janome HD 3000 to confirm/);
    await expectError("a tech", () => mergeMachinesFor(tech, md.id, mk.id, "Janome HD 3000"), /Only the shop owner or an admin/);
    assert.deepEqual(await counts(MACHINE_REFS, md.id, A), mBeforeDup, "a refused merge moves nothing");

    assert.equal(await mergeMachinesFor(a.user, md.id, mk.id, "janome hd 3000"), mk.id);
    assert.equal(await db.machine.count({ where: { id: md.id } }), 0);
    for (const r of MACHINE_REFS) {
      assert.equal(await refCount(db, r, md.id, A), 0, `${key(r)}: nothing points at the duplicate`);
      const want = r.model === "VacCare" ? 1 : mBeforeKeep[key(r)] + mBeforeDup[key(r)];
      assert.equal(await refCount(db, r, mk.id, A), want, `${key(r)}: moved to the kept machine`);
    }
    const mk2 = await db.machine.findUniqueOrThrow({ where: { id: mk.id } });
    assert.equal(mk2.serial, "SN-77");
    assert.deepEqual(mk2.details, { year: 2019 });
    assert.match(mk2.notes ?? "", /^Merged from Janome HD 3000 SN SN-77 on \w{3} \d+, \d{4}\. Its notes: Bent needle bar$/);
    const care = await db.vacCare.findUniqueOrThrow({ where: { machineId: mk.id } });
    assert.deepEqual([care.contactedBy, care.stopped], ["Ann", true], "bag reminders combined: the later contact, stopped if either was");
    ok(
      "machine merge: tickets, photos, partner repairs, sale lines, the stock record, bag reminders and messages move; refused across equipment, for two stock records, without the typed name, for a tech",
    );

    // ---------- 5. machine delete ----------
    await expectError("has tickets", () => deleteMachineFor(a.user, mk.id, "Janome HD3000"), /It has 1 ticket:/);
    await expectError("stock record", () => deleteMachineFor(a.user, stockA.id, "Miele C3"), /machine-for-sale stock record/);
    const gone = await db.machine.create({ data: { shopId: A, customerId: owner.id, brand: "Eureka", model: "Mighty Mite", modelKey: modelKey("Mighty Mite"), equipment: "VACUUM", kind: "vacuum" } });
    const openJob = await db.repairJob.create({
      data: { id: `rj${token()}`, shopId: A, linkId: "l1", side: "retail", tag: "T4", customerName: "Mo O.", brand: "Eureka", model: "Mighty Mite", machineId: gone.id, status: "ON_BENCH" },
    });
    assert.match((await machineDeletePlan(a.user, gone.id)).blockers.join(" "), /Partner repair tag T4 isn't picked up yet/);
    await db.repairJob.update({ where: { shopId_id: { shopId: A, id: openJob.id } }, data: { status: "COLLECTED", pickedUpAt: new Date() } });
    await db.machinePhoto.create({ data: { shopId: A, machineId: gone.id, mime: "image/jpeg", data: Buffer.from([7]) } });
    await db.vacCare.create({ data: { machineId: gone.id, shopId: A } });
    const bags = await db.sale.create({
      data: {
        shopId: A,
        number: nextNo(),
        subtotalCents: 100,
        taxCents: 0,
        totalCents: 100,
        taxRatePct: 0,
        lines: { create: { description: "Bags", qty: 1, unitPriceCents: 100, machineId: gone.id } },
      },
      include: { lines: true },
    });
    const mq = await db.outMessage.create({
      data: {
        shopId: A,
        channel: "email",
        purpose: "marketing",
        kind: "bags_due",
        customerId: owner.id,
        address: "mo@example.test",
        body: "Bags",
        status: "QUEUED",
        refType: "machine",
        refId: gone.id,
      },
    });
    const ms = await db.outMessage.create({
      data: {
        shopId: A,
        channel: "email",
        purpose: "marketing",
        kind: "bags_due",
        customerId: owner.id,
        address: "mo@example.test",
        body: "Bags before",
        status: "SENT",
        refType: "machine",
        refId: gone.id,
      },
    });
    const gplan = await machineDeletePlan(a.user, gone.id);
    assert.deepEqual(gplan.blockers, []);
    assert.ok(gplan.rows.some((r) => r.what === "1 queued message about it" && r.then === "cancelled"));
    await expectError("a tech", () => deleteMachineFor(tech, gone.id, "Eureka Mighty Mite"), /Only the shop owner or an admin/);
    await deleteMachineFor(a.user, gone.id, "Eureka Mighty Mite");
    assert.equal(await db.machine.count({ where: { id: gone.id } }), 0);
    for (const r of MACHINE_REFS) assert.equal(await refCount(db, r, gone.id, A), 0, `${key(r)}: nothing points at the deleted machine`);
    assert.equal((await db.saleLine.findUniqueOrThrow({ where: { id: bags.lines[0].id } })).machineId, null, "the sale line stays in the books");
    const oj = await db.repairJob.findUniqueOrThrow({ where: { shopId_id: { shopId: A, id: openJob.id } } });
    assert.deepEqual([oj.machineId, oj.brand, oj.model], [null, "Eureka", "Mighty Mite"]);
    assert.equal((await db.outMessage.findUniqueOrThrow({ where: { id: mq.id } })).status, "CANCELLED");
    assert.equal((await db.outMessage.findUniqueOrThrow({ where: { id: ms.id } })).status, "SENT");
    ok("machine delete: refused with tickets, a stock record or an open partner repair; then photos and bag reminders go, sale lines and partner repairs stay unlinked, queued messages are cancelled");

    // ---------- 6. tenant ----------
    const t1 = await db.customer.create({ data: { shopId: A, name: "Tenant One" } });
    const t2 = await db.customer.create({ data: { shopId: A, name: "Tenant Two" } });
    const tm = await db.machine.create({ data: { shopId: A, customerId: t1.id, brand: "Singer", model: "Featherweight", modelKey: modelKey("Featherweight") } });
    const tm2 = await db.machine.create({ data: { shopId: A, customerId: t1.id, brand: "Singer", model: "Featherweight", modelKey: modelKey("Featherweight") } });
    const bc = await db.customer.create({ data: { shopId: b.shopId, name: "Tenant One" } });
    const bm = await db.machine.create({ data: { shopId: b.shopId, brand: "Singer", model: "Featherweight", modelKey: modelKey("Featherweight") } });
    const tables = ["Customer", "Machine", "Ticket", "OutMessage", "ConsentEvent", "Campaign", "Enrollment", "Appointment", "WebOrder", "MachinePhoto", "StockUnit"];
    const before = await snapshot(A, tables);
    await expectNotFound("customerMergePlan(B, A's)", () => customerMergePlan(b.user, t1.id, t2.id));
    await expectNotFound("customerDeletePlan(B, A's)", () => customerDeletePlan(b.user, t1.id));
    await expectNotFound("mergeCustomersFor(B, A's into A's)", () => mergeCustomersFor(b.user, t1.id, t2.id, "Tenant One"));
    await expectNotFound("mergeCustomersFor(B, B's into A's)", () => mergeCustomersFor(b.user, bc.id, t1.id, "Tenant One"));
    await expectNotFound("mergeCustomersFor(B, A's into B's)", () => mergeCustomersFor(b.user, t1.id, bc.id, "Tenant One"));
    await expectNotFound("deleteCustomerFor(B, A's)", () => deleteCustomerFor(b.user, t1.id, "Tenant One"));
    await expectNotFound("customerMergeCandidates(B, A's)", () => customerMergeCandidates(b.user, t1.id, "tenant"));
    await expectNotFound("machineMergePlan(B, A's)", () => machineMergePlan(b.user, tm.id, tm2.id));
    await expectNotFound("machineDeletePlan(B, A's)", () => machineDeletePlan(b.user, tm.id));
    await expectNotFound("mergeMachinesFor(B, B's into A's)", () => mergeMachinesFor(b.user, bm.id, tm.id, "Singer Featherweight"));
    await expectNotFound("mergeMachinesFor(B, A's into A's)", () => mergeMachinesFor(b.user, tm.id, tm2.id, "Singer Featherweight"));
    await expectNotFound("deleteMachineFor(B, A's)", () => deleteMachineFor(b.user, tm.id, "Singer Featherweight"));
    await expectNotFound("machineMergeCandidates(B, A's)", () => machineMergeCandidates(b.user, tm.id, null));
    // B's own search never offers A's records.
    assert.ok(!(await customerMergeCandidates(b.user, bc.id, "tenant")).some((c) => c.id === t1.id || c.id === t2.id));
    assert.ok(!(await machineMergeCandidates(b.user, bm.id, null)).some((m) => m.id === tm.id || m.id === tm2.id));
    assertUnchanged("tenant", before, await snapshot(A, tables));
    assert.equal(await db.customer.count({ where: { id: bc.id } }), 1);
    ok("tenant: B's owner can't preview, merge or delete A's customers and machines, nor merge across companies; A's rows unchanged");
  } finally {
    clearKick();
    await cleanup();
  }
  console.log(`customer-merge.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
