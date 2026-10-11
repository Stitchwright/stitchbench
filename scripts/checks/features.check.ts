// Settings → Features and the move to 1.8 (free-software-design.md sections 2 and 7, package 2 "StitchBench: free for
// all"): every add-on is free, switched on per company, and nothing a shop used before goes away.
//   1. the move to 1.8: a company from before it (Shop.featuresSetUpAt null, as the migration leaves every company)
//      starts with the add-ons its keys and the hosted switch had working, judged as 1.7 judged them (a current key, one
//      in grace, a development key only where those counted, the administrator's "on"); one that had ended starts
//      switched off from the day it ended; it happens once, even with two loads at once, and a later key changes
//      nothing; the Windows program never read the switch; a company made on 1.8 starts with every one off, keys or not
//   2. Features alone decide: the real action (safe(), owner or admin, its audit entry) switches each of the five on and
//      off; keys and the hosted switch for them change nothing; requireModule, shopsWithModule and the nav follow; the
//      Assistant is no Feature (its key decides); a company being moved can't switch; company B's switch is B's own
//   3. read-only only where hosting is billed: a lapsed program key changes nothing unless HOSTING_BILLING is exactly
//      "on", and never on the Windows program; the move's freeze stays whatever the variable says
//   npm run check scripts/checks/features.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end).
import "dotenv/config";
import assert from "node:assert/strict";
import Module from "node:module";
import { db } from "@/lib/db";
import { safe } from "@/lib/action";
import { readOnlyReason, requireBaseWritable } from "@/lib/base-gate";
import { lapseUserFrom } from "@/lib/lapse-guard";
import { addDaysYmd } from "@/lib/license";
import { FEATURE_IDS, toNavGates } from "@/lib/module-info";
import { FROM_KEYS, hasModule, hostingBilling, loadModules, loadModulesMany, requireModule, shopsWithModule } from "@/lib/modules";
import type { CurrentUser } from "@/lib/session";
import { devLicenseKey, grantDevLicense } from "../license/dev";
import { checkShop, cleanup, switchFeatures, type CheckShop } from "./lib";
import { RUN } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);

// ---------- the action, outside Next ----------
// setFeature asks who is signed in and revalidates pages: neither exists outside a request. The session says whoever
// `who` is (requireAdmin as the app's), and revalidatePath does nothing (market-companies.check.ts does the same).
let who: CurrentUser | null = null;
const needUser = () => {
  if (!who) throw new Error("check script: nobody is signed in");
  return who;
};
const sessionStub = {
  requireUser: async () => needUser(),
  sessionUser: async () => who,
  requireAdmin: async () => {
    const u = needUser();
    if (u.role === "TECH") throw new (await import("@/lib/user-error")).UserError("Only the shop owner or an admin can change this.");
    return u;
  },
};
type Loader = { _load: (request: string, ...rest: unknown[]) => unknown };
const loader = Module as unknown as Loader;
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === "@/lib/session") return sessionStub;
  if (request === "next/cache") return { revalidatePath: () => undefined };
  return realLoad.call(this, request, ...rest);
};
/* eslint-disable @typescript-eslint/no-require-imports */
const { setFeature } = require("@/actions/features") as typeof import("@/actions/features");
/* eslint-enable @typescript-eslint/no-require-imports */
lapseUserFrom(async () => who);

/** Runs the action as this person and answers what the page would get ({ ok } or { error }). */
async function as(user: CurrentUser, fn: () => Promise<{ ok?: boolean; error?: string }>) {
  who = user;
  try {
    return await fn();
  } finally {
    who = null;
  }
}

/** The company as the migration leaves one from before 1.8: its Features not worked out yet, no switches made. */
async function before18(shopId: string) {
  await db.shop.update({ where: { id: shopId }, data: { featuresSetUpAt: null } });
  await db.shopFeature.deleteMany({ where: { shopId } });
}

const ymd = (d: number) => addDaysYmd(today(), d);
const keyOn = (shopId: string, modules: string[]) => grantDevLicense(shopId, modules, { from: ymd(-30), until: ymd(300), plan: "y", issuedAt: new Date(Date.now() - 30 * DAY) });
const featureRows = async (shopId: string) =>
  (await db.shopFeature.findMany({ where: { shopId }, orderBy: { module: "asc" }, select: { module: true, enabled: true, changedAt: true, byName: true } })).map((r) => ({ ...r, changedAt: r.changedAt.toISOString() }));

async function main() {
  const made: CheckShop[] = [];
  const shop = async (o: Parameters<typeof checkShop>[0] = {}) => {
    const s = await checkShop(o);
    made.push(s);
    return s;
  };
  try {
    // ---------- 1. the move to 1.8 ----------
    const a = await shop({ retail: true, repair: true });
    // What the company held on 1.7: a current key for Vac Shop and Scheduling, Maker Shop in its grace, Marketing ended
    // twenty days after its grace, Small Appliance Repair switched off by the hosted administrator while its key ran,
    // and the Assistant's own key.
    await keyOn(a.shopId, ["vac", "scheduling", "appliance"]);
    await grantDevLicense(a.shopId, ["maker"], { from: ymd(-60), until: ymd(-5), grace: 14, plan: "m", issuedAt: new Date(Date.now() - 60 * DAY) });
    await grantDevLicense(a.shopId, ["marketing"], { from: ymd(-90), until: ymd(-34), grace: 14, plan: "m", issuedAt: new Date(Date.now() - 90 * DAY) });
    const offAt = new Date(Date.now() - 3 * DAY);
    await db.moduleGrant.create({ data: { shopId: a.shopId, module: "appliance", mode: "off", byEmail: "admin@stitchbench.test", createdAt: offAt } });
    await keyOn(a.shopId, ["assistant"]);
    await before18(a.shopId);
    let m = (await loadModules(a.shopId)).states;
    assert.deepEqual(
      FEATURE_IDS.filter((id) => m[id].active),
      ["vac", "scheduling", "maker"],
      "on: what the keys had working (a current key, one in grace)",
    );
    assert.ok(m.marketing.status === "lapsed" && m.marketing.switchedOff, "an ended key's module starts switched off");
    assert.equal(m.marketing.endedAt?.toISOString().slice(0, 10), ymd(-34 + 15), "from the day its grace ran out");
    assert.ok(m.appliance.status === "lapsed" && m.appliance.switchedOff && m.appliance.endedAt?.getTime() === offAt.getTime(), "the administrator's off: switched off from the switch");
    assert.ok(m.assistant.active && m.assistant.source === "key", "the Assistant: its key, as before");
    const shopA = await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { featuresSetUpAt: true } });
    assert.ok(shopA.featuresSetUpAt, "set up");
    const rowsA = await featureRows(a.shopId);
    assert.deepEqual(rowsA.map((r) => [r.module, r.enabled, r.byName]), [["appliance", false, FROM_KEYS], ["maker", true, FROM_KEYS], ["marketing", false, FROM_KEYS], ["scheduling", true, FROM_KEYS], ["vac", true, FROM_KEYS]]);
    ok("a company from before 1.8 starts with what its keys and the switch had working; what had ended starts switched off from its end");

    // Once: a key that arrives later, or the keys and the switch taken away, change nothing; a second look writes nothing.
    await keyOn(a.shopId, ["marketing", "appliance"]);
    m = (await loadModules(a.shopId)).states;
    assert.deepEqual(FEATURE_IDS.filter((id) => m[id].active), ["vac", "scheduling", "maker"], "a key that arrives later switches nothing on");
    await db.license.deleteMany({ where: { shopId: a.shopId } });
    await db.moduleGrant.deleteMany({ where: { shopId: a.shopId } });
    m = (await loadModules(a.shopId)).states;
    assert.deepEqual(FEATURE_IDS.filter((id) => m[id].active), ["vac", "scheduling", "maker"], "nor do the keys taken away");
    assert.equal(m.assistant.active, false, "(the Assistant goes with its key, as before)");
    assert.deepEqual(await featureRows(a.shopId), rowsA, "nothing written again");
    ok("it happens once: a later key, or the keys taken away, change nothing");

    // Two loads at once (two requests after the update): one set of rows, the same answer for both.
    const b = await shop({ retail: true });
    await keyOn(b.shopId, ["marketing"]);
    await before18(b.shopId);
    const [one, two] = await Promise.all([loadModulesMany([b.shopId]), loadModulesMany([b.shopId])]);
    assert.ok(one.get(b.shopId)?.states.marketing.active && two.get(b.shopId)?.states.marketing.active);
    assert.deepEqual((await featureRows(b.shopId)).map((r) => [r.module, r.enabled]), [["marketing", true]]);
    ok("two loads at once: worked out once, the same for both");

    // Judged where it runs, as 1.7 judged it: a development key never counted on a production server; the hosted
    // switch's "on" counted where its key verified; the Windows program never read the switch.
    const c = await shop();
    await keyOn(c.shopId, ["vac"]);
    await before18(c.shopId);
    const env = process.env as Record<string, string | undefined>; // Next's types make NODE_ENV read-only; this script sets it on purpose
    const nodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      assert.equal((await loadModules(c.shopId)).states.vac.active, false, "a dev key on a production server had nothing working");
    } finally {
      if (nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = nodeEnv;
    }
    const d = await shop();
    const grantKey = devLicenseKey({ shopId: d.shopId, modules: ["maker"], plan: "a", from: ymd(-1), until: ymd(60), grace: 0 });
    await db.moduleGrant.create({ data: { shopId: d.shopId, module: "maker", mode: "on", key: grantKey, byEmail: "admin@stitchbench.test" } });
    await before18(d.shopId);
    process.env.STITCH_DESKTOP = "1";
    try {
      assert.equal((await loadModules(d.shopId)).states.maker.active, false, "the Windows program never read the switch");
    } finally {
      delete process.env.STITCH_DESKTOP;
    }
    await before18(d.shopId);
    assert.equal((await loadModules(d.shopId)).states.maker.active, true, "the switch's 'on' (here a development server's) carried over");
    ok("judged where it runs: no dev key in production, no switch on the Windows program, the switch's 'on' elsewhere");

    // A company made on 1.8 starts with every one off, whatever keys come its way.
    const e = await shop();
    assert.ok((await db.shop.findUniqueOrThrow({ where: { id: e.shopId }, select: { featuresSetUpAt: true } })).featuresSetUpAt, "set up when it is made");
    await keyOn(e.shopId, ["vac", "appliance", "scheduling", "marketing", "maker"]);
    m = (await loadModules(e.shopId)).states;
    assert.deepEqual(FEATURE_IDS.filter((id) => m[id].active), [], "every feature off until the shop chooses one");
    assert.deepEqual(await featureRows(e.shopId), []);
    ok("a company made on 1.8 starts with every feature off, keys or not");

    // ---------- 2. Features alone decide ----------
    const owner = e.user;
    const admin: CurrentUser = { ...e.user, id: (await db.user.create({ data: { shopId: e.shopId, email: `check-${RUN}-admin@stitchbench.test`, name: "Ada Admin", role: "ADMIN", passwordHash: "x" } })).id, role: "ADMIN", name: "Ada Admin" };
    const tech: CurrentUser = { ...e.user, id: (await db.user.create({ data: { shopId: e.shopId, email: `check-${RUN}-tech@stitchbench.test`, name: "Ted Tech", role: "TECH", passwordHash: "x" } })).id, role: "TECH", name: "Ted Tech" };
    assert.deepEqual(await as(owner, () => setFeature("vac", true)), { ok: true });
    assert.deepEqual(await as(admin, () => setFeature("scheduling", true)), { ok: true });
    assert.match((await as(tech, () => setFeature("marketing", true))).error ?? "", /Only the shop owner or an admin/);
    assert.match((await as(owner, () => setFeature("assistant", true))).error ?? "", /Pick one of the features/);
    assert.match((await as(owner, () => setFeature("base", false))).error ?? "", /Pick one of the features/);
    m = (await loadModules(e.shopId)).states;
    assert.deepEqual(FEATURE_IDS.filter((id) => m[id].active), ["vac", "scheduling"]);
    assert.equal(m.assistant.active, false, "the Assistant has no key here: no Feature switches it on");
    assert.deepEqual((await featureRows(e.shopId)).map((r) => [r.module, r.enabled, r.byName]), [["scheduling", true, "Ada Admin"], ["vac", true, e.user.name]]);
    const audits = await db.auditEntry.findMany({ where: { shopId: e.shopId, action: "feature.switch" }, orderBy: { at: "asc" }, select: { userName: true, subjectLabel: true } });
    assert.deepEqual(audits.map((x) => [x.userName, x.subjectLabel]), [[e.user.name, "Vac Shop"], ["Ada Admin", "Scheduling"]], "each switch is in the audit log");
    assert.deepEqual(await as(owner, () => setFeature("vac", true)), { ok: true });
    assert.equal(await db.auditEntry.count({ where: { shopId: e.shopId, action: "feature.switch" } }), 2, "switching on what is on changes nothing");
    ok("the action: an owner or admin switches a feature on (in the audit log); a tech, the Assistant and the program itself are refused");

    assert.ok(await hasModule(e.shopId, "vac"));
    await requireModule(tech, "scheduling");
    assert.deepEqual(await shopsWithModule("vac", [e.shopId, b.shopId]), [e.shopId]);
    let nav = toNavGates(await loadModules(e.shopId));
    assert.ok(nav.vac === "on" && nav.scheduling === "on" && nav.marketing === "hidden" && nav.maker === "hidden");
    assert.deepEqual(await as(owner, () => setFeature("vac", false)), { ok: true });
    m = (await loadModules(e.shopId)).states;
    assert.ok(m.vac.status === "lapsed" && m.vac.switchedOff && !m.vac.active, "switched off: read-only from now, nothing deleted");
    await assert.rejects(requireModule(owner, "vac"), /Vac Shop was switched off for this company on .* switch it on again in Settings → Features\./);
    assert.deepEqual(await shopsWithModule("vac", [e.shopId]), [], "the workers skip it");
    nav = toNavGates(await loadModules(e.shopId));
    assert.equal(nav.vac, "readonly", "its menu item stays, read-only, for what is there");
    ok("requireModule, the workers and the menu follow the switch; switched off it is read-only, nothing deleted");

    // Keys and the hosted switch for the five change nothing any more (e holds a current key for all five).
    await db.moduleGrant.create({ data: { shopId: e.shopId, module: "marketing", mode: "on", key: devLicenseKey({ shopId: e.shopId, modules: ["marketing"], plan: "a", until: ymd(60) }), byEmail: "admin@stitchbench.test" } });
    await db.moduleGrant.create({ data: { shopId: e.shopId, module: "scheduling", mode: "off", byEmail: "admin@stitchbench.test" } });
    m = (await loadModules(e.shopId)).states;
    assert.ok(!m.marketing.active && m.scheduling.active && !m.appliance.active, "keys and the switch for the trade modules decide nothing");
    await keyOn(e.shopId, ["assistant"]);
    assert.equal((await loadModules(e.shopId)).states.assistant.active, true, "the Assistant's key still decides the Assistant");
    ok("keys and the hosted switch for the five decide nothing; the Assistant's key still does");

    // A company being moved is frozen: no switching there (the action is refused like any other write).
    await db.shop.update({ where: { id: e.shopId }, data: { movingAt: new Date(), movedTo: "the new PC" } });
    assert.match((await as(owner, () => setFeature("marketing", true))).error ?? "", /moving to the new PC/);
    await db.shop.update({ where: { id: e.shopId }, data: { movingAt: null, movedTo: null } });
    assert.equal((await loadModules(e.shopId)).states.marketing.active, false);
    ok("a company being moved can't switch its features");

    // Tenant: B's switches are B's own.
    const eRows = await featureRows(e.shopId);
    assert.deepEqual(await as(b.user, () => setFeature("vac", true)), { ok: true });
    assert.deepEqual(await featureRows(e.shopId), eRows, "e's rows unchanged");
    assert.equal((await loadModules(e.shopId)).states.vac.active, false);
    assert.equal((await loadModules(b.shopId)).states.vac.active, true);
    ok("tenant: one company's switch changes nothing of another's");

    // ---------- 3. read-only only where hosting is billed ----------
    const f = await shop({ retail: true });
    await switchFeatures(f.shopId, ["marketing"]);
    await grantDevLicense(f.shopId, ["base"], { from: ymd(-60), until: ymd(-20), grace: 14, plan: "m", issuedAt: new Date(Date.now() - 60 * DAY) });
    let ran = 0;
    const write = safe(async () => {
      ran += 1;
    });
    const tryWrite = () => as(f.user, write);
    delete process.env.HOSTING_BILLING;
    for (const value of [undefined, "", "off", "true", "1", "ON"]) {
      if (value === undefined) delete process.env.HOSTING_BILLING;
      else process.env.HOSTING_BILLING = value;
      assert.equal(hostingBilling(), false, `HOSTING_BILLING=${value}`);
      assert.equal((await loadModules(f.shopId)).states.base.status, "off", `HOSTING_BILLING=${value}: a lapsed key changes nothing`);
      assert.equal(await readOnlyReason(f.shopId), null);
      assert.deepEqual(await tryWrite(), { ok: true });
    }
    assert.equal(ran, 6, "every write went through");
    assert.deepEqual(await shopsWithModule("marketing", [f.shopId]), [f.shopId], "the workers run the company");
    ok("without HOSTING_BILLING=on (unset, empty, off, true, 1, ON) a lapsed program key changes nothing");

    process.env.HOSTING_BILLING = "on";
    try {
      assert.equal(hostingBilling(), true);
      assert.equal((await loadModules(f.shopId)).states.base.status, "lapsed");
      assert.equal((await readOnlyReason(f.shopId))?.kind, "lapsed");
      assert.match((await tryWrite()).error ?? "", /read-only since .*Pay for the hosting/);
      assert.equal(ran, 6, "refused: the body never ran");
      assert.deepEqual(await shopsWithModule("marketing", [f.shopId]), [], "the workers skip the company");
      process.env.STITCH_DESKTOP = "1";
      try {
        assert.equal(hostingBilling(), false, "never on the Windows program");
        assert.equal((await loadModules(f.shopId)).states.base.status, "off");
        assert.deepEqual(await tryWrite(), { ok: true });
      } finally {
        delete process.env.STITCH_DESKTOP;
      }
    } finally {
      delete process.env.HOSTING_BILLING;
    }
    ok("HOSTING_BILLING=on: a lapsed key makes the company read-only (the owner's hosting); never on the Windows program");

    // The Assistant's key ending makes nothing read-only; the move's freeze does, with or without the variable.
    await grantDevLicense(f.shopId, ["assistant"], { from: ymd(-90), until: ymd(-40), grace: 14 });
    assert.equal((await loadModules(f.shopId)).states.assistant.status, "lapsed");
    assert.equal(await readOnlyReason(f.shopId), null, "an ended Assistant key isn't the program's");
    await db.shop.update({ where: { id: f.shopId }, data: { movingAt: new Date(), movedTo: "the hosted service" } });
    assert.equal((await readOnlyReason(f.shopId))?.kind, "moving");
    await assert.rejects(requireBaseWritable(f.user), /moving to the hosted service/);
    assert.match((await tryWrite()).error ?? "", /moving to the hosted service/);
    await db.shop.update({ where: { id: f.shopId }, data: { movingAt: null, movedTo: null } });
    assert.deepEqual(await tryWrite(), { ok: true });
    ok("an ended Assistant key changes nothing; a company being moved is read-only whatever HOSTING_BILLING says");

    console.log(`features.check: ${steps} groups passed (run ${RUN})`);
  } finally {
    delete process.env.HOSTING_BILLING;
    await cleanup();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
