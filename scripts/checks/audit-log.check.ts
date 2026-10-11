// Audit log (later-round-1-design.md section 4): every listed action writes one entry with the right category, subject and
// change; a refused one writes none; the log refuses edits and deletes; pruning keeps 7 years (sign-ins 1); a lapsed
// company still logs; one company never sees another's entries.
//   npm run check scripts/checks/audit-log.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { actorOf, audit, auditEntries, diff, pruneAudit } from "@/lib/audit";
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, type AuditAction } from "@/lib/audit-list";
import { addPaymentFor, removePaymentFor } from "@/lib/payments";
import { completeSaleAs, voidSaleAs } from "@/lib/register-sale";
import { countStock } from "@/lib/parts";
import { addPersonAs, setPersonActiveAs } from "@/lib/people";
import { checkSignIn } from "@/lib/sign-in";
import { modelKey } from "@/lib/format";
import { MOVE_TABLES } from "@/lib/move/format";
import { grantDevLicense } from "../license/dev";
import { checkShop, cleanup } from "./lib";
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

let n = 9600;
async function ticket(shopId: string) {
  const m = await db.machine.create({ data: { shopId, customerId: null, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P") } });
  return db.ticket.create({ data: { shopId, number: n++, status: "ON_BENCH", machineId: m.id, customerId: null, intake: {} } });
}

const entries = (shopId: string, action?: string) => db.auditEntry.findMany({ where: { shopId, ...(action ? { action } : {}) }, orderBy: [{ at: "asc" }, { id: "asc" }] });
const count = (shopId: string) => db.auditEntry.count({ where: { shopId } });

async function main() {
  const a = await checkShop({ repair: true, retail: true });
  const b = await checkShop({ repair: true, retail: true });
  const owner = a.user;
  const tech = { ...a.user, role: "TECH" as const };
  try {
    // ---------- the list itself ----------
    for (const [name, meta] of Object.entries(AUDIT_ACTIONS)) {
      assert.ok((AUDIT_CATEGORIES as readonly string[]).includes(meta.category), `${name} has a known category`);
      assert.match(name, /^[a-z]+\.[a-z_]+$/);
    }
    // audit() throws a plain Error for a typo (not a UserError): check that directly.
    await assert.rejects(() => audit(db, actorOf(owner), { action: "sale.oops" as AuditAction, subjectType: "Sale" }), /Unknown audit action/);
    assert.equal(await count(a.shopId), 0, "a refused name writes nothing");
    ok("every name has a category; an unknown name is refused and writes nothing");

    // ---------- every name has a call site ----------
    const roots = ["src", "desktop"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "generated" || e.name === "test") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs)$/.test(e.name) && !p.endsWith("audit-list.ts")) files.push(p);
      }
    };
    roots.forEach(walk);
    const sources = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    for (const name of Object.keys(AUDIT_ACTIONS)) assert.ok(sources.includes(`"${name}"`) || sources.includes(`'${name}'`), `${name} has a call site`);
    ok("every action in the list has a call site (and the list holds nothing without one)");

    // ---------- payments ----------
    const t = await ticket(a.shopId);
    await addPaymentFor(owner, t.id, { amountCents: 4500, method: "CARD", note: "check #1" });
    let e = (await entries(a.shopId, "payment.add"))[0];
    assert.ok(e, "payment.add written");
    assert.equal(e.category, "money");
    assert.equal(e.subjectType, "Ticket");
    assert.equal(e.subjectId, t.id);
    assert.equal(e.amountCents, 4500);
    assert.equal(e.userId, owner.id);
    assert.equal(e.userName, owner.name);
    assert.equal(e.role, "OWNER");
    assert.equal(e.reason, "check #1");
    assert.deepEqual((e.changes as Record<string, unknown[]>).method, [null, "CARD"]);
    const before = await count(a.shopId);
    await expectError("tech refund", () => addPaymentFor(tech, t.id, { amountCents: -100, method: "CASH", note: null }), /owner or an admin/);
    await expectError("no amount", () => addPaymentFor(owner, t.id, { amountCents: 0, method: "CASH", note: null }), /amount/);
    await expectNotFound("another company's ticket", () => addPaymentFor(b.user, t.id, { amountCents: 100, method: "CASH", note: null }));
    assert.equal(await count(a.shopId), before, "a refused payment leaves no entry");
    assert.equal(await count(b.shopId), 0);
    const pay = await db.payment.findFirstOrThrow({ where: { ticketId: t.id } });
    await removePaymentFor(owner, pay.id);
    e = (await entries(a.shopId, "payment.remove"))[0];
    assert.ok(e, "payment.remove written");
    assert.equal(e.amountCents, 4500);
    assert.equal(e.subjectId, t.id);
    await expectError("removed twice", () => removePaymentFor(owner, pay.id), /already removed/);
    assert.equal((await entries(a.shopId, "payment.remove")).length, 1, "the refused second removal wrote nothing");
    ok("payment.add and payment.remove: right category, subject, amount; refusals write none");

    // ---------- the register ----------
    const part = await db.part.create({ data: { shopId: a.shopId, partNumber: "AUD-1", description: "Audit needle", priceCents: 1000, qtyOnHand: 20, numberKeys: [] } });
    const sale = await completeSaleAs(owner, {
      lines: [{ partId: part.id, description: "x", qty: 2, unitPriceCents: 900, discountCents: 100, taxable: true }],
      orderDiscountCents: 50,
      tenders: [{ method: "CASH", amountCents: 5000 }],
    });
    const over = (await entries(a.shopId, "sale.price_override"))[0];
    assert.ok(over, "price override logged");
    assert.deepEqual((over.changes as Record<string, unknown[]>)["AUD-1"], [1000, 900]);
    assert.equal(over.subjectLabel, `Sale #${sale.number}`);
    const disc = (await entries(a.shopId, "sale.discount"))[0];
    assert.ok(disc, "discount logged");
    assert.equal(disc.amountCents, 150, "line 100 + sale 50");
    assert.equal((await entries(a.shopId, "sale.return")).length, 0, "an ordinary sale is not logged as a return");
    const ret = await completeSaleAs(owner, { lines: [{ partId: part.id, description: "x", qty: -1, unitPriceCents: 900, taxable: true }], tenders: [{ method: "CASH", amountCents: -900 }], note: "wrong colour" });
    const rr = (await entries(a.shopId, "sale.return"))[0];
    assert.ok(rr, "return logged");
    assert.equal(rr.amountCents, -900);
    assert.equal(rr.subjectLabel, `Sale #${ret.number}`);
    assert.equal(rr.reason, "wrong colour");
    // an unremarkable sale (the item's own price, no discount): nothing logged
    const plain = await count(a.shopId);
    await completeSaleAs(owner, { lines: [{ partId: part.id, description: "x", qty: 1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "CASH", amountCents: 1000 }] });
    assert.equal(await count(a.shopId), plain, "an ordinary sale writes no entry");
    // a failed sale leaves none
    await expectError("tender short", () => completeSaleAs(owner, { lines: [{ partId: part.id, description: "x", qty: 1, unitPriceCents: 1000, taxable: true }], tenders: [{ method: "CASH", amountCents: 10 }] }), /Still due/);
    assert.equal(await count(a.shopId), plain);
    // void: entry and void commit together; a second void is refused and writes nothing
    await voidSaleAs(owner, sale.saleId, "rung up twice");
    const v = (await entries(a.shopId, "sale.void"))[0];
    assert.ok(v, "void logged");
    assert.equal(v.reason, "rung up twice");
    assert.equal(v.subjectId, sale.saleId);
    assert.deepEqual(v.changes, { status: ["COMPLETED", "VOIDED"] });
    await expectError("void twice", () => voidSaleAs(owner, sale.saleId, "again"), /already void/);
    assert.equal((await entries(a.shopId, "sale.void")).length, 1);
    await expectNotFound("void another company's sale", () => voidSaleAs(b.user, ret.saleId, "x"));
    assert.equal(await count(b.shopId), 0);
    ok("sale.return, sale.discount, sale.price_override, sale.void: written once, with the figures; ordinary and refused sales write none");

    // ---------- stock, people, sign-in ----------
    await countStock(a.shopId, part.id, 7, owner.id, "Shelf count");
    const sc = (await entries(a.shopId, "stock.count"))[0];
    assert.ok(sc);
    assert.equal(sc.category, "stock");
    assert.equal(sc.subjectLabel, "AUD-1");
    const qtyBefore = (await db.stockMove.findMany({ where: { partId: part.id } })).reduce((s, m) => s + m.qty, 0);
    assert.ok(qtyBefore !== 0);
    assert.deepEqual((sc.changes as Record<string, unknown[]>).qtyOnHand?.[1], 7);
    await countStock(a.shopId, part.id, 7, owner.id, "same again");
    assert.equal((await entries(a.shopId, "stock.count")).length, 1, "a count that matched changes nothing and logs nothing");

    const fd = new FormData();
    fd.set("email", `staff-${Date.now()}@stitchbench.test`);
    fd.set("name", "New Tech");
    fd.set("password", "long-enough-pass");
    fd.set("role", "TECH");
    await addPersonAs(owner, fd);
    const ua = (await entries(a.shopId, "user.add"))[0];
    assert.ok(ua);
    assert.equal(ua.category, "people");
    assert.ok(ua.subjectLabel?.startsWith("New Tech"));
    const newUser = await db.user.findFirstOrThrow({ where: { shopId: a.shopId, name: "New Tech" } });
    await setPersonActiveAs(owner, newUser.id, false);
    const act = (await entries(a.shopId, "user.active"))[0];
    assert.ok(act);
    assert.deepEqual(act.changes, { active: [true, false] });
    await expectNotFound("another company's login", () => setPersonActiveAs(b.user, newUser.id, true));
    assert.equal(await count(b.shopId), 0);

    const wrong = await checkSignIn({ email: owner.email, password: "not-the-password" }, undefined);
    assert.equal(wrong, null);
    // Written without holding the answer up: give it a moment.
    for (let i = 0; i < 50 && !(await entries(a.shopId, "signin.fail")).length; i++) await new Promise((r) => setTimeout(r, 100));
    const fail = (await entries(a.shopId, "signin.fail"))[0];
    assert.ok(fail, "a wrong password for a real login is logged");
    assert.equal(fail.subjectId, owner.id);
    await checkSignIn({ email: owner.email, password: "not-the-password-2" }, undefined);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await entries(a.shopId, "signin.fail")).length, 1, "a flood of wrong passwords is logged once a minute");
    assert.equal(await checkSignIn({ email: "nobody-here@stitchbench.test", password: "x" }, undefined), null);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await db.auditEntry.count({ where: { subjectLabel: { contains: "nobody-here" } } }), 0, "an unknown email belongs to no company: not logged");
    const good = await checkSignIn({ email: owner.email, password: "check-pass-1234" }, undefined);
    assert.ok(good);
    assert.equal((await entries(a.shopId, "signin.ok")).length, 1);
    ok("stock.count, user.add, user.active, signin.fail (throttled), signin.ok");

    // ---------- diff ----------
    assert.deepEqual(diff({ x: 1, y: 2 }, { x: 1, y: 3 }, ["x", "y"]), { y: [2, 3] });
    assert.equal(diff({ x: 1 }, { x: 1 }, ["x"]), null);
    ok("diff lists only what changed");

    // ---------- append-only ----------
    const some = (await entries(a.shopId))[0];
    await assert.rejects(() => db.auditEntry.update({ where: { id: some.id }, data: { reason: "edited" } }), /cannot be changed or deleted/);
    await assert.rejects(() => db.auditEntry.delete({ where: { id: some.id } }), /cannot be changed or deleted/);
    await assert.rejects(() => db.auditEntry.deleteMany({ where: { shopId: a.shopId } }), /cannot be changed or deleted/);
    await assert.rejects(() => db.$executeRawUnsafe(`UPDATE "AuditEntry" SET "userName" = 'x' WHERE id = $1`, some.id), /cannot be changed or deleted/);
    await assert.rejects(() => db.$executeRawUnsafe(`TRUNCATE "AuditEntry"`), /cannot be changed or deleted/);
    const same = await db.auditEntry.findUniqueOrThrow({ where: { id: some.id } });
    assert.equal(same.reason, some.reason);
    assert.ok(await count(a.shopId) > 10);
    ok("an entry can't be updated, deleted or truncated (the database refuses), by the client or raw SQL");

    // ---------- pruning ----------
    const old = (years: number) => new Date(Date.now() - years * 365.25 * 86_400_000);
    const mk = (action: string, at: Date) => db.auditEntry.create({ data: { shopId: a.shopId, at, userName: "old", category: "money", action, subjectType: "X" } });
    const [sevenPlus, signinOld, signinNew, sixYears] = await Promise.all([mk("sale.void", old(7.1)), mk("signin.ok", old(1.2)), mk("signin.ok", old(0.5)), mk("sale.void", old(6))]);
    const gone = await pruneAudit();
    assert.ok(gone >= 2);
    const left = new Set((await db.auditEntry.findMany({ where: { id: { in: [sevenPlus.id, signinOld.id, signinNew.id, sixYears.id] } } })).map((x) => x.id));
    assert.deepEqual([...left].sort(), [signinNew.id, sixYears.id].sort(), "past 7 years and sign-ins past 1 year go; the rest stays");
    ok("pruning removes entries past 7 years and sign-ins past 1, nothing else");

    // ---------- lapsed company still logs ----------
    const lapsed = await checkShop({ repair: true });
    // Read-only happens only where the owner's hosting is billed (HOSTING_BILLING=on, src/lib/modules.ts).
    process.env.HOSTING_BILLING = "on";
    await grantDevLicense(lapsed.shopId, ["base"], { from: new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10), until: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10), grace: 14, plan: "m", issuedAt: new Date(Date.now() - 60 * 86_400_000) });
    const lt = await ticket(lapsed.shopId);
    await addPaymentFor(lapsed.user, lt.id, { amountCents: 2500, method: "CASH", note: null });
    assert.equal((await entries(lapsed.shopId, "payment.add")).length, 1);
    delete process.env.HOSTING_BILLING;
    ok("a lapsed company still logs a payment (the money actions most need a trail)");

    // ---------- tenant ----------
    const mine = await auditEntries(a.shopId, {}, { take: 500 });
    const theirs = await auditEntries(b.shopId, {}, { take: 500 });
    assert.ok(mine.total > 10);
    assert.equal(theirs.total, 0, "B sees none of A's entries");
    assert.ok(mine.rows.every((r) => r.shopId === a.shopId));
    const filtered = await auditEntries(b.shopId, { subjectType: "Ticket", subjectId: t.id }, { take: 50 });
    assert.equal(filtered.total, 0, "B can't reach A's ticket history by id");
    assert.ok(MOVE_TABLES.some((x) => x.t === "AuditEntry"), "AuditEntry travels in the company move");
    ok("tenant: every entry and filter is by company; the move carries the table");
  } finally {
    await cleanup();
  }
  console.log(`\naudit log check: ${steps} steps passed`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
