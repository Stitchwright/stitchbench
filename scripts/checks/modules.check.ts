// The gating API against the database (modules-design.md section 13.2, modules-foundation acceptance item 4):
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
import { hostedSigner, signGrant } from "@/lib/license-signing";
import { fmtYmd } from "@/lib/module-info";
import { devKeysAllowed, hasModule, loadModules, loadModulesMany, requireModule, shopsWithModule, verifyFor } from "@/lib/modules";
import { todayIn } from "@/lib/time-zone";
import { devLicenseKey, grantDevLicense } from "../license/dev";
import { makeCompany, removeCompany, RUN } from "./tenant";

const DAY = 86_400_000;
const payloadOf = (key: string) => JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")) as LicensePayload;

/** The same key with one character of its payload changed: the signature no longer matches. */
function flipPayloadChar(key: string) {
  const [h, p, s] = key.split(".");
  const i = Math.floor(p.length / 2);
  return `${h}.${p.slice(0, i)}${p[i] === "A" ? "B" : "A"}${p.slice(i + 1)}.${s}`;
}

// devKeysAllowed, isDesktop and hostedSigner read these on every call, so the truth table is run by setting them in-process.
const ENV = ["NODE_ENV", "STITCH_TEST_BUILD", "DATABASE_URL", "LICENSE_HOSTED_KEY", "STITCH_DESKTOP"] as const;
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
  const byEmail = `check-${RUN}@stitchbench.test`;
  try {
    const shop = await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { name: true, timeZone: true } });
    const tz = shop.timeZone;
    const at = (ymd: string) => dayStartIn(ymd, tz);
    const noon = (ymd: string) => new Date(+at(ymd) + 12 * 3_600_000);
    const today = todayIn(tz);
    const real = new Date();
    const clearRows = async () => {
      await db.license.deleteMany({ where: { shopId: a.shopId } });
      await db.moduleGrant.deleteMany({ where: { shopId: a.shopId } });
    };

    // 1. A yearly dev key at fixed nows: off (before), on, renew, grace, lapsed; endedAt is the end of grace.
    const key1 = await grantDevLicense(a.shopId, ["vac"], { from: "2026-01-01", until: "2026-12-31", grace: 14, plan: "y", issuedAt: "2025-12-20T12:00:00Z" });
    const p1 = payloadOf(key1);
    let m = await loadModules(a.shopId, { now: noon("2026-06-15") });
    assert.equal(m.states.vac.status, "on");
    assert.equal(m.states.vac.active, true);
    assert.equal(m.states.vac.lastDay, "2026-12-31");
    assert.equal(m.states.vac.graceLastDay, "2027-01-14");
    assert.equal(m.states.vac.plan, "y");
    assert.equal(m.states.vac.source, "key");
    assert.equal(m.states.vac.keyId, p1.id);
    assert.equal(m.states.vac.endedAt, null);
    assert.equal(m.states.appliance.status, "off");
    assert.equal(m.keys.length, 1);
    assert.equal(m.keys[0].state, "current");
    assert.equal(m.keys[0].keyId, p1.id);
    assert.deepEqual(m.keys[0].modules, ["vac"]);
    assert.equal(m.unknownModules.length, 0);
    m = await loadModules(a.shopId, { now: noon("2026-12-01") });
    assert.equal(m.states.vac.status, "on", "30.5 days left: not yet the yearly 30-day notice");
    m = await loadModules(a.shopId, { now: noon("2026-12-15") });
    assert.equal(m.states.vac.status, "renew");
    assert.equal(m.states.vac.active, true);
    m = await loadModules(a.shopId, { now: noon("2027-01-05") });
    assert.equal(m.states.vac.status, "grace");
    assert.equal(m.states.vac.active, true);
    assert.equal(m.keys[0].state, "current");
    m = await loadModules(a.shopId, { now: noon("2027-02-01") });
    assert.equal(m.states.vac.status, "lapsed");
    assert.equal(m.states.vac.active, false);
    assert.equal(m.states.vac.switchedOff, false);
    assert.equal(m.states.vac.endedAt?.getTime(), at(addDaysYmd("2026-12-31", 1 + 14)).getTime(), "endedAt is the end of grace");
    assert.equal(m.states.vac.lastDay, "2026-12-31");
    assert.equal(m.keys[0].state, "ended");
    m = await loadModules(a.shopId, { now: noon("2025-12-01") });
    assert.equal(m.states.vac.status, "off");
    assert.equal(m.states.vac.startsOn, "2026-01-01");
    assert.equal(m.keys[0].state, "future");
    ok("yearly key: off before, on, renew, grace, lapsed with endedAt at the end of grace");

    // 2. The stored key text edited with SQL: not valid, and the module off.
    const row1 = await db.license.findFirstOrThrow({ where: { shopId: a.shopId }, select: { id: true } });
    await db.$executeRaw`UPDATE "License" SET key = ${flipPayloadChar(key1)} WHERE id = ${row1.id}`;
    m = await loadModules(a.shopId, { now: noon("2026-06-15") });
    assert.equal(m.keys.length, 1);
    assert.equal(m.keys[0].state, "not-valid");
    assert.ok(m.keys[0].reason, "a not-valid key says why");
    assert.equal(m.states.vac.status, "off");
    assert.equal(m.states.vac.active, false);
    await db.$executeRaw`UPDATE "License" SET key = ${key1} WHERE id = ${row1.id}`;
    m = await loadModules(a.shopId, { now: noon("2026-06-15") });
    assert.equal(m.states.vac.status, "on", "the original text verifies again");
    ok("an edited key text is not-valid and switches nothing on");

    // 3. Another company's key in this company's rows: other-company, ignored.
    const b = await makeCompany(`Check ${RUN} B`);
    companies.push(b.shopId);
    const foreign = devLicenseKey({ shopId: b.shopId, modules: ["vac", "appliance"], from: "2026-01-01", until: "2026-12-31" });
    const foreignRow = await db.license.create({ data: { shopId: a.shopId, keyId: payloadOf(foreign).id, key: foreign, addedBy: "check" }, select: { id: true } });
    m = await loadModules(a.shopId, { now: noon("2026-06-15") });
    assert.equal(m.keys.length, 2);
    const fv = m.keys.find((k) => k.rowId === foreignRow.id);
    assert.equal(fv?.state, "other-company");
    assert.match(fv?.reason ?? "", new RegExp(b.shopId));
    assert.equal(m.states.appliance.status, "off", "the other company's key switches nothing on here");
    assert.equal(m.states.vac.status, "on");
    assert.equal(m.states.vac.keyId, p1.id);
    const mb = await loadModules(b.shopId, { now: noon("2026-06-15") });
    assert.equal(mb.states.vac.status, "off", "and it isn't the other company's either: it was never pasted there");
    await db.license.delete({ where: { id: foreignRow.id } });
    ok("another company's key shows as other-company and is ignored");

    // 4. The administrator's switch: a ModuleGrant "on" signed with signGrant counts, and not on the Windows program.
    await clearRows();
    assert.equal(hostedSigner()?.scope, "dev", "a check script signs with the development key");
    const grantKey = signGrant({ shopId: a.shopId, shopName: shop.name, module: "appliance", lastDay: addDaysYmd(today, 60), graceDays: 0, timeZone: tz });
    await db.moduleGrant.create({ data: { shopId: a.shopId, module: "appliance", mode: "on", key: grantKey, byEmail } });
    m = await loadModules(a.shopId);
    assert.equal(m.states.appliance.status, "on");
    assert.equal(m.states.appliance.source, "admin");
    assert.equal(m.states.appliance.plan, "a");
    assert.equal(m.states.appliance.keyId, payloadOf(grantKey).id);
    assert.equal(m.states.appliance.lastDay, addDaysYmd(today, 60));
    assert.equal(m.keys.length, 0, "switch rows aren't listed as pasted keys");
    await withEnv({ STITCH_DESKTOP: "1" }, async () => {
      const d = await loadModules(a.shopId);
      assert.equal(d.states.appliance.status, "off", "the Windows program never reads ModuleGrant");
      assert.equal(hostedSigner(), null, "and has no signer");
    });
    ok("a signed ModuleGrant 'on' counts, and is ignored with STITCH_DESKTOP=1");

    // 5. Real switch rows: off, then a short on, then "Let keys decide".
    await clearRows();
    const yearly = await grantDevLicense(a.shopId, ["vac"], { from: addDaysYmd(today, -30), until: addDaysYmd(today, 335), grace: 14, plan: "y", issuedAt: new Date(+real - 30 * DAY) });
    const yearlyId = payloadOf(yearly).id;
    m = await loadModules(a.shopId, { now: real });
    assert.equal(m.states.vac.status, "on");
    const t0 = new Date(+real - 3 * 60_000);
    const t1 = new Date(+real - 2 * 60_000);
    const t2 = new Date(+real - 60_000);
    await db.moduleGrant.create({ data: { shopId: a.shopId, module: "vac", mode: "off", byEmail, createdAt: t0 } });
    m = await loadModules(a.shopId, { now: real });
    assert.equal(m.states.vac.status, "lapsed");
    assert.equal(m.states.vac.switchedOff, true);
    assert.equal(m.states.vac.active, false);
    assert.equal(m.states.vac.endedAt?.getTime(), t0.getTime(), "switched off: new work stopped at the switch");
    const shortKey = signGrant({ shopId: a.shopId, shopName: shop.name, module: "vac", lastDay: addDaysYmd(today, 20), graceDays: 0, timeZone: tz });
    await db.moduleGrant.create({ data: { shopId: a.shopId, module: "vac", mode: "on", key: shortKey, byEmail, createdAt: t1 } });
    m = await loadModules(a.shopId, { now: new Date(+real + DAY) });
    assert.equal(m.states.vac.status, "on", "inside the short admin window");
    assert.equal(m.states.vac.source, "admin");
    assert.equal(m.states.vac.keyId, payloadOf(shortKey).id);
    assert.equal(m.states.vac.switchedOff, false);
    m = await loadModules(a.shopId, { now: new Date(+real + 30 * DAY) });
    assert.equal(m.states.vac.status, "lapsed", "after the short window; the earlier off still ends the yearly key");
    assert.equal(m.states.vac.endedAt?.getTime(), at(addDaysYmd(addDaysYmd(today, 20), 1)).getTime());
    await db.moduleGrant.create({ data: { shopId: a.shopId, module: "vac", mode: "none", byEmail, createdAt: t2 } });
    m = await loadModules(a.shopId, { now: real });
    assert.equal(m.states.vac.status, "on", "Let keys decide: the yearly key again");
    assert.equal(m.states.vac.source, "key");
    assert.equal(m.states.vac.keyId, yearlyId);
    m = await loadModules(a.shopId, { now: new Date(+real + 30 * DAY) });
    assert.equal(m.states.vac.status, "on");
    ok("switch rows: off, a short on (on inside, lapsed after), then Let keys decide");

    // 6. devKeysAllowed truth table.
    const base = { NODE_ENV: undefined, STITCH_TEST_BUILD: undefined, LICENSE_HOSTED_KEY: undefined, STITCH_DESKTOP: undefined, DATABASE_URL: "postgresql://u:p@localhost:5433/x" };
    assert.equal(await withEnv(base, devKeysAllowed), true, "NODE_ENV unset");
    assert.equal(await withEnv({ ...base, NODE_ENV: "production" }, devKeysAllowed), false, "production");
    const testBuild = { ...base, NODE_ENV: "production", STITCH_TEST_BUILD: "1" };
    assert.equal(await withEnv(testBuild, devKeysAllowed), true, "a test build on a localhost database");
    assert.equal(await withEnv({ ...testBuild, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/x" }, devKeysAllowed), true, "127.0.0.1 is this machine too");
    assert.equal(await withEnv({ ...testBuild, LICENSE_HOSTED_KEY: "x" }, devKeysAllowed), false, "a server holding a hosting key");
    assert.equal(await withEnv({ ...testBuild, DATABASE_URL: "postgresql://u:p@db.example.com:5432/x" }, devKeysAllowed), false, "a remote database");
    assert.equal(await withEnv({ ...testBuild, STITCH_DESKTOP: "1" }, devKeysAllowed), false, "the Windows program");
    assert.equal(await withEnv({ ...base, STITCH_DESKTOP: "1" }, devKeysAllowed), false, "the Windows program, even outside production");
    ok("devKeysAllowed truth table");

    // 7. hostedSigner with a LICENSE_HOSTED_KEY that matches no compiled hosted key: null, said once.
    const stray = crypto.generateKeyPairSync("ed25519");
    const strayPem = stray.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const strayEnv = Buffer.from(strayPem, "utf8").toString("base64");
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => said.push(args.map(String).join(" "));
    try {
      await withEnv({ LICENSE_HOSTED_KEY: strayEnv }, () => {
        assert.equal(hostedSigner(), null);
        assert.equal(hostedSigner(), null, "memoised: still null");
        assert.equal(devKeysAllowed(), false, "and development keys don't count while a hosting key is set");
        assert.equal(verifyFor(yearly, "pasted").ok, false);
      });
    } finally {
      console.error = realError;
    }
    assert.equal(said.length, 1, "one console.error per process (expected in this check's output)");
    assert.match(said[0], /LICENSE_HOSTED_KEY doesn't match kid h1/);
    assert.equal(hostedSigner()?.scope, "dev", "without it, the development signer again");
    ok("hostedSigner with a stray LICENSE_HOSTED_KEY is null");

    // 8. verifyFor and acceptScope: an "any" key is never the administrator's switch; a dev key counts only where allowed.
    assert.equal(acceptScope("any", "grant", { devAllowed: true, hostedHeld: true }), false);
    assert.equal(acceptScope("any", "pasted", { devAllowed: false, hostedHeld: false }), true);
    assert.equal(acceptScope("hosted", "pasted", { devAllowed: true, hostedHeld: true }), false);
    assert.equal(acceptScope("hosted", "grant", { devAllowed: true, hostedHeld: false }), false);
    assert.equal(acceptScope("hosted", "grant", { devAllowed: false, hostedHeld: true }), true);
    assert.equal(acceptScope("dev", "grant", { devAllowed: false, hostedHeld: true }), false);
    assert.equal(acceptScope("dev", "pasted", { devAllowed: true, hostedHeld: false }), true);
    // No "any" kid is compiled in yet (the owner adds k1 before the first release), so sign one with a throwaway pair.
    const anyPair = crypto.generateKeyPairSync("ed25519");
    const anyX = (anyPair.publicKey.export({ format: "jwk" }) as { x: string }).x;
    const anyKeys: PublicKeys = { t9: { x: anyX, scope: "any" } };
    const anyKey = encodeLicense({ v: 1, k: "t9", id: newKeyId(), s: a.shopId, n: shop.name, m: ["vac"], p: "y", f: today, u: addDaysYmd(today, 364), g: 14, t: real.toISOString() }, anyPair.privateKey);
    const av = verifyLicense(anyKey, anyKeys);
    assert.ok(av.ok && av.scope === "any");
    assert.equal(acceptScope(av.scope, "grant", { devAllowed: true, hostedHeld: true }), false, "an any key as a grant is refused");
    assert.equal(acceptScope(av.scope, "pasted", { devAllowed: false, hostedHeld: false }), true);
    const unknownKid = verifyFor(anyKey, "pasted");
    assert.ok(!unknownKid.ok && /newer version/.test(unknownKid.reason), "its kid isn't compiled in: needs a newer version");
    assert.equal(verifyFor(yearly, "pasted").ok, true, "a dev key pastes on a development server");
    assert.equal(verifyFor(yearly, "grant").ok, true, "and serves as the switch there");
    await withEnv({ NODE_ENV: "production", STITCH_TEST_BUILD: undefined }, () => {
      assert.equal(devKeysAllowed(), false);
      const r = verifyFor(yearly, "pasted");
      assert.ok(!r.ok && /test key/.test(r.reason), "a dev key is refused when devKeysAllowed() is false");
      assert.equal(verifyFor(yearly, "grant").ok, false);
    });
    ok("verifyFor / acceptScope: any keys never grant; dev keys only where allowed");

    // 9. The Windows clock floor: a key issued 5 days from now gives clockBehind. Dev keys don't count on the Windows
    // program and no "any" kid is compiled in yet, so the throwaway "any" kid is lent to the registry for this step.
    const lateKey = encodeLicense(
      { v: 1, k: "t9", id: newKeyId(), s: a.shopId, n: shop.name, m: ["vac"], p: "y", f: addDaysYmd(today, -10), u: addDaysYmd(today, 354), g: 14, t: new Date(+real + 5 * DAY).toISOString() },
      anyPair.privateKey,
    );
    LICENSE_PUBLIC_KEYS.t9 = { x: anyX, scope: "any" };
    try {
      const lateRow = await db.license.create({ data: { shopId: a.shopId, keyId: payloadOf(lateKey).id, key: lateKey, addedBy: "check" }, select: { id: true } });
      const yearlyRow = await db.license.findFirstOrThrow({ where: { shopId: a.shopId, keyId: yearlyId }, select: { id: true } });
      await withEnv({ STITCH_DESKTOP: "1" }, async () => {
        const d = await loadModules(a.shopId);
        assert.equal(d.clockBehind, true);
        assert.ok(d.floor && +d.floor - +real > 24 * 3_600_000, "the floor is the key's issue time less 48 hours: 3 days ahead");
        assert.ok(d.floor && +d.now >= +d.floor, "now is never before the floor");
        assert.equal(d.states.vac.status, "on");
        assert.equal(d.states.vac.keyId, payloadOf(lateKey).id);
        const dv = d.keys.find((k) => k.rowId === yearlyRow.id);
        assert.equal(dv?.state, "not-valid", "the dev key is a test key on the Windows program");
        assert.match(dv?.reason ?? "", /test key/);
      });
      const h = await loadModules(a.shopId);
      assert.equal(h.clockBehind, false, "no floor off the Windows program");
      assert.equal(h.floor, null);
      await db.license.delete({ where: { id: lateRow.id } });
    } finally {
      delete LICENSE_PUBLIC_KEYS.t9;
    }
    assert.equal(verifyFor(anyKey, "pasted").ok, false, "the lent kid is gone again");
    ok("STITCH_DESKTOP=1: a key issued 5 days ahead gives clockBehind");

    // 10. requireModule on a module that ended at the real now.
    await clearRows();
    const endedLastDay = addDaysYmd(today, -30);
    await grantDevLicense(a.shopId, ["vac"], { from: addDaysYmd(today, -60), until: endedLastDay, grace: 0, plan: "m", issuedAt: new Date(+real - 60 * DAY) });
    const endedAt = at(addDaysYmd(endedLastDay, 1));
    const lapsed = (await loadModules(a.shopId)).states.vac;
    assert.equal(lapsed.status, "lapsed");
    assert.equal(lapsed.endedAt?.getTime(), endedAt.getTime());
    const expectEnded = (who: "OWNER" | "TECH" | "ADMIN" | null, tail: string) => (e: unknown) => {
      assert.ok(isUserError(e), `requireModule threw ${String(e)}`);
      const msg = (e as Error).message;
      assert.ok(msg.startsWith("Vac Shop ended on"), `${who}: ${msg}`);
      assert.ok(msg.includes(fmtYmd(endedLastDay)), `${who}: ${msg}`);
      assert.ok(msg.endsWith(tail), `${who}: ${msg}`);
      return true;
    };
    await assert.rejects(requireModule({ shopId: a.shopId, role: "OWNER" }, "vac"), expectEnded("OWNER", "renew it in Settings → Modules."));
    await assert.rejects(requireModule({ shopId: a.shopId, role: "ADMIN" }, "vac"), expectEnded("ADMIN", "renew it in Settings → Modules."));
    await assert.rejects(requireModule(a.shopId, "vac"), expectEnded(null, "renew it in Settings → Modules."));
    await assert.rejects(requireModule({ shopId: a.shopId, role: "TECH" }, "vac"), expectEnded("TECH", "Ask the shop owner to renew it."));
    assert.equal(await hasModule(a.shopId, "vac"), false);
    ok("requireModule: 'Vac Shop ended on ...' for admins and techs");

    // 11. canWorkOn after the lapse: work that came in before endedAt can be finished; nothing new, nothing closed, nothing unknown.
    const machine = await db.machine.create({ data: { shopId: a.shopId, brand: "Hoover", model: "UH70120", modelKey: modelKey("UH70120"), equipment: "VACUUM", kind: "vacuum" }, select: { id: true } });
    const before = new Date(+endedAt - DAY);
    const after = new Date(+endedAt + 3_600_000);
    assert.equal(await canWorkOn(a.shopId, "VACUUM", gate(before)), true, "an open ticket opened before endedAt");
    assert.equal(await canWorkOn(a.shopId, "VACUUM", gate(after)), false, "one opened after");
    assert.equal(await canWorkOn(a.shopId, "VACUUM", gate(before, "COLLECTED")), false, "a Collected one");
    assert.equal(await canWorkOn(a.shopId, "ROBOT"), false, "unknown equipment");
    assert.equal(await canWorkOn(a.shopId, "ROBOT", gate(before)), false);
    assert.equal(await canWorkOn(a.shopId, "VACUUM"), false, "no new vacuum work");
    assert.equal(await canWorkOn(a.shopId, "SEWING"), true, "sewing is free");
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
    ok("canWorkOn / ticketWorkable / machineWorkable after the lapse");

    // 12. shopsWithModule only while active; loadModulesMany equals one loadModules per company.
    assert.deepEqual(await shopsWithModule("vac", [a.shopId]), []);
    await grantDevLicense(a.shopId, ["vac"], { from: addDaysYmd(today, -1), until: addDaysYmd(today, 300), grace: 14 });
    assert.deepEqual(await shopsWithModule("vac", [a.shopId]), [a.shopId]);
    assert.deepEqual(await shopsWithModule("appliance", [a.shopId]), []);
    const c = await makeCompany(`Check ${RUN} C`);
    companies.push(c.shopId);
    await grantDevLicense(c.shopId, ["appliance", "scheduling"], { from: addDaysYmd(today, -1), until: addDaysYmd(today, 100) });
    assert.deepEqual((await shopsWithModule("vac", [a.shopId, b.shopId, c.shopId])).sort(), [a.shopId]);
    assert.deepEqual((await shopsWithModule("appliance", [c.shopId, b.shopId, a.shopId])).sort(), [c.shopId]);
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
