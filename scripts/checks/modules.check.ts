// The gating API against the database (modules-design.md section 13.2, modules-foundation acceptance item 4), as 1.8
// has it (free-software-design.md): the Assistant follows its license key (on, renew, grace, lapsed; an edited key or
// another company's switches nothing on; the Windows clock floor), the five trade modules follow Settings → Features
// (requireModule's words, work that came in before a switch-off can be finished), development keys count only where
// allowed, and loadModulesMany equals one loadModules per company. features.check.ts has the move to 1.8 and the
// read-only rule.
//   npx tsx --conditions=react-server scripts/checks/modules.check.ts
// Uses throwaway companies "Check <run>" (and " B", " C") and removes them at the end, whatever happened. Exit code
// non-zero on the first failing assertion. Runs with the dev database in .env; nothing it does outlives its cleanup.
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { TicketStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { canWorkOn, machineWorkable, ticketWorkable } from "@/lib/equipment/gate";
import { modelKey } from "@/lib/format";
import { acceptScope, addDaysYmd, dayStartIn, encodeLicense, newKeyId, verifyLicense, type LicensePayload, type PublicKeys } from "@/lib/license";
import { LICENSE_PUBLIC_KEYS } from "@/lib/license-keys";
import { devKeysAllowed, hasModule, loadModules, loadModulesMany, requireModule, shopsWithModule, verifyFor } from "@/lib/modules";
import { todayIn } from "@/lib/time-zone";
import { devLicenseKey, grantDevLicense } from "../license/dev";
import { switchFeatures } from "./lib";
import { makeCompany, removeCompany, RUN } from "./tenant";

const DAY = 86_400_000;
const payloadOf = (key: string) => JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")) as LicensePayload;

/** The same key with one character of its payload changed: the signature no longer matches. */
function flipPayloadChar(key: string) {
  const [h, p, s] = key.split(".");
  const i = Math.floor(p.length / 2);
  return `${h}.${p.slice(0, i)}${p[i] === "A" ? "B" : "A"}${p.slice(i + 1)}.${s}`;
}

// devKeysAllowed and isDesktop read these on every call, so the truth table is run by setting them in-process.
const ENV = ["NODE_ENV", "STITCH_TEST_BUILD", "DATABASE_URL", "STITCH_DESKTOP"] as const;
type EnvName = (typeof ENV)[number];
async function withEnv<T>(vars: Partial<Record<EnvName, string | undefined>>, fn: () => Promise<T> | T): Promise<T> {
  const env = process.env as Record<string, string | undefined>; // Next's types make NODE_ENV read-only; this script sets it on purpose
  const saved = ENV.map((k) => [k, env[k]] as const);
  try {
    for (const k of ENV) {
      if (!(k in vars)) continue;
      const v = vars[k];
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

let steps = 0;
const ok = (label: string) => {
  steps += 1;
  console.log(`  ok  ${label}`);
};

const gate = (intakeAt: Date, status: TicketStatus = "ON_BENCH") => ({ intakeAt, status });

async function main() {
  const a = await makeCompany(`Check ${RUN}`);
  const companies = [a.shopId];
  try {
    const shop = await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { name: true, timeZone: true } });
    const tz = shop.timeZone;
    const at = (ymd: string) => dayStartIn(ymd, tz);
    const noon = (ymd: string) => new Date(+at(ymd) + 12 * 3_600_000);
    const today = todayIn(tz);
    const real = new Date();

    // 1. The Assistant's yearly dev key at fixed nows: off (before), on, renew, grace, lapsed; endedAt is the end of grace.
    const key1 = await grantDevLicense(a.shopId, ["assistant"], { from: "2026-01-01", until: "2026-12-31", grace: 14, plan: "y", issuedAt: "2025-12-20T12:00:00Z" });
    const p1 = payloadOf(key1);
    let m = await loadModules(a.shopId, { now: noon("2026-06-15") });
    assert.equal(m.states.assistant.status, "on");
    assert.equal(m.states.assistant.active, true);
    assert.equal(m.states.assistant.lastDay, "2026-12-31");
    assert.equal(m.states.assistant.graceLastDay, "2027-01-14");
    assert.equal(m.states.assistant.source, "key");
    assert.equal(m.states.assistant.keyId, p1.id);
    assert.equal(m.states.assistant.endedAt, null);
    m = await loadModules(a.shopId, { now: noon("2026-12-01") });
    assert.equal(m.states.assistant.status, "on", "30.5 days left: not yet the yearly 30-day notice");
    m = await loadModules(a.shopId, { now: noon("2026-12-15") });
    assert.equal(m.states.assistant.status, "renew");
    assert.equal(m.states.assistant.active, true);
    m = await loadModules(a.shopId, { now: noon("2027-01-05") });
    assert.equal(m.states.assistant.status, "grace");
    assert.equal(m.states.assistant.active, true);
    m = await loadModules(a.shopId, { now: noon("2027-02-01") });
    assert.equal(m.states.assistant.status, "lapsed");
    assert.equal(m.states.assistant.active, false);
    assert.equal(m.states.assistant.switchedOff, false);
    assert.equal(m.states.assistant.endedAt?.getTime(), at(addDaysYmd("2026-12-31", 1 + 14)).getTime(), "endedAt is the end of grace");
    m = await loadModules(a.shopId, { now: noon("2025-12-01") });
    assert.equal(m.states.assistant.status, "off");
    assert.equal(m.states.assistant.startsOn, "2026-01-01");
    ok("the Assistant's yearly key: off before, on, renew, grace, lapsed with endedAt at the end of grace");

    // 2. The stored key text edited with SQL: not valid, and the Assistant off.
    const row1 = await db.license.findFirstOrThrow({ where: { shopId: a.shopId }, select: { id: true } });
    await db.$executeRaw`UPDATE "License" SET key = ${flipPayloadChar(key1)} WHERE id = ${row1.id}`;
    m = await loadModules(a.shopId, { now: noon("2026-06-15") });
    assert.equal(m.states.assistant.status, "off");
    assert.equal(m.states.assistant.active, false);
    await db.$executeRaw`UPDATE "License" SET key = ${key1} WHERE id = ${row1.id}`;
    m = await loadModules(a.shopId, { now: noon("2026-06-15") });
    assert.equal(m.states.assistant.status, "on", "the original text verifies again");
    ok("an edited key text switches nothing on");

    // 3. Another company's key in this company's rows: ignored here, and not the other company's either.
    const b = await makeCompany(`Check ${RUN} B`);
    companies.push(b.shopId);
    await db.license.deleteMany({ where: { shopId: a.shopId } });
    const foreign = devLicenseKey({ shopId: b.shopId, modules: ["assistant"], from: "2026-01-01", until: "2026-12-31" });
    await db.license.create({ data: { shopId: a.shopId, keyId: payloadOf(foreign).id, key: foreign, addedBy: "check" } });
    m = await loadModules(a.shopId, { now: noon("2026-06-15") });
    assert.equal(m.states.assistant.status, "off", "the other company's key switches nothing on here");
    const mb = await loadModules(b.shopId, { now: noon("2026-06-15") });
    assert.equal(mb.states.assistant.status, "off", "and it isn't the other company's either: it was never stored there");
    await db.license.deleteMany({ where: { shopId: a.shopId } });
    ok("another company's key is ignored");

    // 4. A feature: never switched on (off), on, switched off (read-only from that moment, nothing deleted).
    m = await loadModules(a.shopId);
    for (const id of ["vac", "appliance", "scheduling", "marketing", "maker"] as const) {
      assert.equal(m.states[id].status, "off", `${id} starts off`);
      assert.equal(m.states[id].source, "feature");
    }
    await switchFeatures(a.shopId, ["vac"]);
    m = await loadModules(a.shopId);
    assert.ok(m.states.vac.status === "on" && m.states.vac.active && !m.states.vac.switchedOff && m.states.vac.lastDay === null);
    const offAt = new Date(+real - 60_000);
    await switchFeatures(a.shopId, ["vac"], false, offAt);
    m = await loadModules(a.shopId);
    assert.ok(m.states.vac.status === "lapsed" && !m.states.vac.active && m.states.vac.switchedOff);
    assert.equal(m.states.vac.endedAt?.getTime(), offAt.getTime(), "new work stopped when it was switched off");
    ok("a feature: off until switched on, then on; switched off it is read-only from that moment");

    // 5. devKeysAllowed truth table.
    const base = { NODE_ENV: undefined, STITCH_TEST_BUILD: undefined, STITCH_DESKTOP: undefined, DATABASE_URL: "postgresql://u:p@localhost:5433/x" };
    assert.equal(await withEnv(base, devKeysAllowed), true, "NODE_ENV unset");
    assert.equal(await withEnv({ ...base, NODE_ENV: "production" }, devKeysAllowed), false, "production");
    const testBuild = { ...base, NODE_ENV: "production", STITCH_TEST_BUILD: "1" };
    assert.equal(await withEnv(testBuild, devKeysAllowed), true, "a test build on a localhost database");
    assert.equal(await withEnv({ ...testBuild, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/x" }, devKeysAllowed), true, "127.0.0.1 is this machine too");
    assert.equal(await withEnv({ ...testBuild, DATABASE_URL: "postgresql://u:p@db.example.com:5432/x" }, devKeysAllowed), false, "a remote database");
    assert.equal(await withEnv({ ...testBuild, STITCH_DESKTOP: "1" }, devKeysAllowed), false, "the Windows program");
    assert.equal(await withEnv({ ...base, STITCH_DESKTOP: "1" }, devKeysAllowed), false, "the Windows program, even outside production");
    ok("devKeysAllowed truth table");

    // 6. verifyFor and acceptScope: an "any" key is never the administrator's switch; a dev key counts only where allowed;
    // no server holds a hosting key any more, so a "hosted" key never counts.
    assert.equal(acceptScope("any", "grant", { devAllowed: true, hostedHeld: true }), false);
    assert.equal(acceptScope("any", "pasted", { devAllowed: false, hostedHeld: false }), true);
    assert.equal(acceptScope("hosted", "pasted", { devAllowed: true, hostedHeld: true }), false);
    assert.equal(acceptScope("hosted", "grant", { devAllowed: true, hostedHeld: false }), false);
    assert.equal(acceptScope("dev", "grant", { devAllowed: false, hostedHeld: true }), false);
    assert.equal(acceptScope("dev", "pasted", { devAllowed: true, hostedHeld: false }), true);
    // No "any" kid is compiled in, so sign one with a throwaway pair.
    const anyPair = crypto.generateKeyPairSync("ed25519");
    const anyX = (anyPair.publicKey.export({ format: "jwk" }) as { x: string }).x;
    const anyKeys: PublicKeys = { t9: { x: anyX, scope: "any" } };
    const anyKey = encodeLicense({ v: 1, k: "t9", id: newKeyId(), s: a.shopId, n: shop.name, m: ["assistant"], p: "y", f: today, u: addDaysYmd(today, 364), g: 14, t: real.toISOString() }, anyPair.privateKey);
    const av = verifyLicense(anyKey, anyKeys);
    assert.ok(av.ok && av.scope === "any");
    assert.equal(acceptScope(av.scope, "grant", { devAllowed: true, hostedHeld: true }), false, "an any key as a grant is refused");
    const unknownKid = verifyFor(anyKey, "pasted");
    assert.ok(!unknownKid.ok && /newer version/.test(unknownKid.reason), "its kid isn't compiled in: needs a newer version");
    const yearly = await grantDevLicense(a.shopId, ["assistant"], { from: addDaysYmd(today, -30), until: addDaysYmd(today, 335), grace: 14, plan: "y", issuedAt: new Date(+real - 30 * DAY) });
    assert.equal(verifyFor(yearly, "pasted").ok, true, "a dev key counts on a development server");
    assert.equal(verifyFor(yearly, "grant").ok, true, "and served as the switch there");
    await withEnv({ NODE_ENV: "production", STITCH_TEST_BUILD: undefined }, () => {
      assert.equal(devKeysAllowed(), false);
      const r = verifyFor(yearly, "pasted");
      assert.ok(!r.ok && /test key/.test(r.reason), "a dev key is refused when devKeysAllowed() is false");
      assert.equal(verifyFor(yearly, "grant").ok, false);
    });
    ok("verifyFor / acceptScope: any keys never grant; dev keys only where allowed");

    // 7. The Windows clock floor: a key issued 5 days from now moves the program's "now" up to 48 hours before it. Dev
    // keys don't count on the Windows program and no "any" kid is compiled in, so the throwaway kid is lent to the registry.
    const lateKey = encodeLicense(
      { v: 1, k: "t9", id: newKeyId(), s: a.shopId, n: shop.name, m: ["assistant"], p: "y", f: addDaysYmd(today, -10), u: addDaysYmd(today, 354), g: 14, t: new Date(+real + 5 * DAY).toISOString() },
      anyPair.privateKey,
    );
    LICENSE_PUBLIC_KEYS.t9 = { x: anyX, scope: "any" };
    try {
      const lateRow = await db.license.create({ data: { shopId: a.shopId, keyId: payloadOf(lateKey).id, key: lateKey, addedBy: "check" }, select: { id: true } });
      await withEnv({ STITCH_DESKTOP: "1" }, async () => {
        const d = await loadModules(a.shopId);
        assert.ok(+d.now - +real > 2 * DAY, "now is the key's issue time less 48 hours: 3 days ahead");
        assert.equal(d.states.assistant.status, "on");
        assert.equal(d.states.assistant.keyId, payloadOf(lateKey).id, "the dev key doesn't count on the Windows program");
      });
      const h = await loadModules(a.shopId);
      assert.ok(Math.abs(+h.now - Date.now()) < 60_000, "no floor off the Windows program");
      await db.license.delete({ where: { id: lateRow.id } });
    } finally {
      delete LICENSE_PUBLIC_KEYS.t9;
    }
    assert.equal(verifyFor(anyKey, "pasted").ok, false, "the lent kid is gone again");
    ok("STITCH_DESKTOP=1: a key issued 5 days ahead moves the clock floor");

    // 8. requireModule: a feature switched off, a feature never switched on, and the Assistant (bought on the hub).
    const expect = (who: string, head: RegExp, tail: string) => (e: unknown) => {
      assert.ok(isUserError(e), `requireModule threw ${String(e)}`);
      const msg = (e as Error).message;
      assert.match(msg, head, `${who}: ${msg}`);
      assert.ok(msg.endsWith(tail), `${who}: ${msg}`);
      return true;
    };
    const offWords = /^Vac Shop was switched off for this company on .*finish work that came in before then\./;
    await assert.rejects(requireModule({ shopId: a.shopId, role: "OWNER" }, "vac"), expect("OWNER", offWords, "To start new work, switch it on again in Settings → Features."));
    await assert.rejects(requireModule({ shopId: a.shopId, role: "ADMIN" }, "vac"), expect("ADMIN", offWords, "To start new work, switch it on again in Settings → Features."));
    await assert.rejects(requireModule(a.shopId, "vac"), expect("worker", offWords, "To start new work, switch it on again in Settings → Features."));
    await assert.rejects(requireModule({ shopId: a.shopId, role: "TECH" }, "vac"), expect("TECH", offWords, "Ask the shop owner or an admin to switch it on again."));
    await assert.rejects(requireModule({ shopId: a.shopId, role: "OWNER" }, "appliance"), expect("never on", /^Small Appliance Repair isn't switched on for this company\./, "It's free: switch it on in Settings → Features."));
    await assert.rejects(requireModule({ shopId: a.shopId, role: "TECH" }, "maker"), expect("never on, tech", /^Maker Shop isn't switched on/, "Ask the shop owner or an admin to switch it on in Settings → Features."));
    await db.license.deleteMany({ where: { shopId: a.shopId } });
    await assert.rejects(requireModule({ shopId: a.shopId, role: "OWNER" }, "assistant"), expect("assistant", /^Assistant isn't on for this company\./, "Add it on your StitchHub account (Settings → Account)."));
    assert.equal(await hasModule(a.shopId, "vac"), false);
    ok("requireModule: switched off, never switched on, and the Assistant, in each role's words");

    // 9. canWorkOn after a switch-off: work that came in before it can be finished; nothing new, nothing closed, nothing unknown.
    const endedAt = offAt;
    const machine = await db.machine.create({ data: { shopId: a.shopId, brand: "Hoover", model: "UH70120", modelKey: modelKey("UH70120"), equipment: "VACUUM", kind: "vacuum" }, select: { id: true } });
    const before = new Date(+endedAt - DAY);
    const after = new Date(+endedAt + 30_000);
    assert.equal(await canWorkOn(a.shopId, "VACUUM", gate(before)), true, "an open ticket opened before the switch-off");
    assert.equal(await canWorkOn(a.shopId, "VACUUM", gate(after)), false, "one opened after");
    assert.equal(await canWorkOn(a.shopId, "VACUUM", gate(before, "COLLECTED")), false, "a Collected one");
    assert.equal(await canWorkOn(a.shopId, "ROBOT"), false, "unknown equipment");
    assert.equal(await canWorkOn(a.shopId, "ROBOT", gate(before)), false);
    assert.equal(await canWorkOn(a.shopId, "VACUUM"), false, "no new vacuum work");
    assert.equal(await canWorkOn(a.shopId, "SEWING"), true, "sewing is always there");
    const [tOpen, tLate, tDone] = await Promise.all([
      db.ticket.create({ data: { shopId: a.shopId, number: 1, machineId: machine.id, intakeAt: before }, select: { id: true } }),
      db.ticket.create({ data: { shopId: a.shopId, number: 2, machineId: machine.id, intakeAt: after }, select: { id: true } }),
      db.ticket.create({ data: { shopId: a.shopId, number: 3, machineId: machine.id, intakeAt: before, status: "COLLECTED" }, select: { id: true } }),
    ]);
    assert.equal(await ticketWorkable(a.shopId, tOpen.id), true);
    assert.equal(await ticketWorkable(a.shopId, tLate.id), false);
    assert.equal(await ticketWorkable(a.shopId, tDone.id), false);
    assert.equal(await machineWorkable(a.shopId, machine.id), true, "through its open workable ticket");
    await db.ticket.update({ where: { id: tOpen.id }, data: { status: "COLLECTED" } });
    assert.equal(await machineWorkable(a.shopId, machine.id), false, "once that ticket is closed too");
    await switchFeatures(a.shopId, ["vac"]);
    assert.equal(await ticketWorkable(a.shopId, tLate.id), true, "switched on again: everything works");
    ok("canWorkOn / ticketWorkable / machineWorkable after a switch-off, and again once switched on");

    // 10. shopsWithModule only while active; loadModulesMany equals one loadModules per company.
    await switchFeatures(a.shopId, ["vac"], false);
    assert.deepEqual(await shopsWithModule("vac", [a.shopId]), []);
    await switchFeatures(a.shopId, ["vac"]);
    assert.deepEqual(await shopsWithModule("vac", [a.shopId]), [a.shopId]);
    assert.deepEqual(await shopsWithModule("appliance", [a.shopId]), []);
    const c = await makeCompany(`Check ${RUN} C`);
    companies.push(c.shopId);
    await switchFeatures(c.shopId, ["appliance", "scheduling"]);
    await grantDevLicense(c.shopId, ["assistant"], { from: addDaysYmd(today, -1), until: addDaysYmd(today, 100) });
    assert.deepEqual((await shopsWithModule("vac", [a.shopId, b.shopId, c.shopId])).sort(), [a.shopId]);
    assert.deepEqual((await shopsWithModule("appliance", [c.shopId, b.shopId, a.shopId])).sort(), [c.shopId]);
    assert.deepEqual(await shopsWithModule("assistant", [a.shopId, b.shopId, c.shopId]), [c.shopId]);
    assert.deepEqual(await shopsWithModule("marketing", [a.shopId, b.shopId, c.shopId]), []);
    const fixed = new Date();
    const many = await loadModulesMany([a.shopId, b.shopId, c.shopId], { now: fixed });
    assert.equal(many.size, 3);
    for (const id of [a.shopId, b.shopId, c.shopId]) {
      const one = await loadModules(id, { now: fixed });
      assert.equal(JSON.stringify(many.get(id)), JSON.stringify(one), `loadModulesMany differs from loadModules for ${id}`);
    }
    assert.equal(many.get(a.shopId)?.states.vac.status, "on");
    assert.equal(many.get(c.shopId)?.states.appliance.status, "on");
    assert.equal(many.get(c.shopId)?.states.assistant.status, "on");
    assert.equal(many.get(b.shopId)?.states.vac.status, "off");
    ok("shopsWithModule only while active; loadModulesMany matches loadModules");

    console.log(`modules.check: ${steps} steps passed (run ${RUN})`);
  } finally {
    for (const id of companies) await removeCompany(id).catch((e) => console.error(`cleanup of ${id} failed:`, e));
    const left = await db.shop.count({ where: { name: { startsWith: `Check ${RUN}` } } });
    if (left) console.error(`cleanup: ${left} "Check ${RUN}" companies left behind`);
    await db.$disconnect();
    if (left) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
