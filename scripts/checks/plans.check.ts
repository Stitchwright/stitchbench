// The two plans' logins (price list decided 3 Oct 2026; src/lib/plan.ts, src/lib/people.ts): StitchHub names the plan in
// the key it signs for the program (payload l: solo | shop), stored the way the hub's sync stores it (applyStanding).
//   1. no plan known, no limit: a company with no key at all, and one whose key names no plan (an older hub's, an
//      emailed one), add a third and a fourth login
//   2. Shop: a third login is added
//   3. Solo: the third login refused in the plan's words; taking access away is always allowed; restoring access counts
//      as adding (refused at two, allowed below); two added at once with one place left: one goes in; the StitchBench
//      administrator's own login isn't counted
//   4. over two on Solo (a company that moved down from Shop): nobody is locked out (everyone still active, no session
//      ended), the owner's notice (over), adding and restoring refused; down to two, the "both in use" notice
//   5. the words: SOLO_FULL as decided, planWords for Settings → Account, the actions go through src/lib/people.ts
//   npm run check scripts/checks/plans.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end).
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { addDaysYmd } from "@/lib/license";
import { applyStanding } from "@/lib/hub-standing";
import { addPersonAs, setPersonActiveAs } from "@/lib/people";
import { activeLogins, companyPlan, loginNotice, planWords, SOLO_FULL, SOLO_LOGINS } from "@/lib/plan";
import type { CurrentUser } from "@/lib/session";
import { isUserError } from "@/lib/user-error";
import { devLicenseKey } from "../license/dev";
import { checkShop, cleanup } from "./lib";
import { RUN } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const today = () => new Date().toISOString().slice(0, 10);
let n = 0;

function person(role: "TECH" | "ADMIN" = "TECH") {
  n += 1;
  const fd = new FormData();
  fd.append("name", `Plan person ${n}`);
  fd.append("email", `plan-${RUN}-${n}@stitchbench.test`);
  fd.append("password", "plan-pass-1234");
  fd.append("role", role);
  return fd;
}
const add = (admin: CurrentUser, role: "TECH" | "ADMIN" = "TECH") => addPersonAs(admin, person(role));
const idOf = async (fd: FormData) => (await db.user.findUniqueOrThrow({ where: { email: String(fd.get("email")) } })).id;

async function refused(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.equal((e as Error).message, SOLO_FULL, label);
    return;
  }
  assert.fail(`${label}: no refusal`);
}

/** The hub's key for the company, with or without a login plan, stored as the sync stores it (the one "hub" row). */
async function hubKey(shopId: string, loginPlan?: "solo" | "shop", opts: { plan?: string; founding?: boolean } = {}) {
  const key = devLicenseKey({ shopId, modules: ["base"], plan: opts.plan ?? "m", from: addDaysYmd(today(), -2), until: addDaysYmd(today(), 28), grace: 14, loginPlan, founding: opts.founding });
  await applyStanding(shopId, { standing: "active", message: "Subscribed.", plan: loginPlan ?? null, key });
  assert.equal(await db.license.count({ where: { shopId, source: "hub" } }), 1, "one hub key per company");
  return key;
}

async function main() {
  console.log(`plans check (run ${RUN})`);

  // ---------- 1. No plan known: no limit ----------
  {
    const a = await checkShop();
    assert.equal(await companyPlan(a.shopId), null, "no key: no plan");
    await add(a.user);
    await add(a.user);
    await add(a.user);
    assert.equal(await activeLogins(a.shopId), 4);
    assert.deepEqual(await loginNotice(a.shopId), { plan: null, active: 4, over: false, full: false });
    ok("no key at all (never joined, offline): a third and a fourth login are added, no notice");

    const b = await checkShop();
    await hubKey(b.shopId);
    assert.equal(await companyPlan(b.shopId), null, "a key that names no plan");
    await add(b.user);
    await add(b.user);
    assert.equal(await activeLogins(b.shopId), 3);
    ok("a key that names no plan (an older hub's, an emailed one): a third login is added");
  }

  // ---------- 2. Shop ----------
  {
    const c = await checkShop();
    await hubKey(c.shopId, "shop");
    assert.deepEqual(await companyPlan(c.shopId), { plan: "shop", keyPlan: "m", founding: false });
    await add(c.user);
    await add(c.user, "ADMIN");
    await add(c.user);
    assert.equal(await activeLogins(c.shopId), 4);
    assert.deepEqual((await loginNotice(c.shopId)).over, false);
    ok("Shop: a third and a fourth login are added");
  }

  // ---------- 3. Solo ----------
  {
    const d = await checkShop();
    await hubKey(d.shopId, "solo");
    assert.deepEqual(await companyPlan(d.shopId), { plan: "solo", keyPlan: "m", founding: false });
    const second = person();
    await addPersonAs(d.user, second);
    assert.equal(await activeLogins(d.shopId), SOLO_LOGINS);
    assert.deepEqual(await loginNotice(d.shopId), { plan: { plan: "solo", keyPlan: "m", founding: false }, active: 2, over: false, full: true });
    const third = person();
    await refused("a third login on Solo", () => addPersonAs(d.user, third));
    assert.equal(await db.user.count({ where: { email: String(third.get("email")) } }), 0, "nothing was made");
    ok("Solo: the third login is refused in the plan's words, nothing made; the full notice at two");

    // Taking access away always works; restoring counts as adding.
    const secondId = await idOf(second);
    await setPersonActiveAs(d.user, secondId, false);
    assert.equal(await activeLogins(d.shopId), 1);
    await addPersonAs(d.user, third);
    assert.equal(await activeLogins(d.shopId), 2);
    await refused("restoring a third login on Solo", () => setPersonActiveAs(d.user, secondId, true));
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: secondId } })).active, false, "still switched off");
    await setPersonActiveAs(d.user, await idOf(third), false);
    await setPersonActiveAs(d.user, secondId, true);
    assert.equal(await activeLogins(d.shopId), 2);
    ok("Solo: removing access always works; restoring is counted (refused at two, allowed with a place free)");

    // Two added at once with one place left: the company's row is held, so only one goes in.
    const e = await checkShop();
    await hubKey(e.shopId, "solo");
    const results = await Promise.allSettled([add(e.user), add(e.user), add(e.user)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "one of three at once");
    for (const r of results) if (r.status === "rejected") assert.equal((r.reason as Error).message, SOLO_FULL);
    assert.equal(await activeLogins(e.shopId), 2);
    ok("Solo: three added at once with one place left: one goes in, two refused");

    // The StitchBench administrator's own login (PLATFORM_ADMIN_EMAILS) isn't one of the shop's people.
    const before = process.env.PLATFORM_ADMIN_EMAILS;
    const adminEmail = `plan-admin-${RUN}@stitchbench.test`;
    process.env.PLATFORM_ADMIN_EMAILS = [before, adminEmail].filter(Boolean).join(",");
    try {
      await db.user.create({ data: { shopId: e.shopId, email: adminEmail, name: "Administrator", role: "ADMIN", passwordHash: "x" } });
      assert.equal(await activeLogins(e.shopId), 2, "the administrator's login isn't counted");
      await refused("still two people on Solo", () => add(e.user));
    } finally {
      if (before === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
      else process.env.PLATFORM_ADMIN_EMAILS = before;
    }
    ok("Solo: the StitchBench administrator's own login isn't counted");
  }

  // ---------- 4. Over two on Solo: never locked out ----------
  {
    const f = await checkShop();
    await hubKey(f.shopId, "shop");
    const people = [person(), person("ADMIN"), person()];
    for (const p of people) await addPersonAs(f.user, p);
    const offOne = person();
    await addPersonAs(f.user, offOne);
    await setPersonActiveAs(f.user, await idOf(offOne), false);
    const sessions = await db.user.findMany({ where: { shopId: f.shopId }, select: { id: true, active: true, sessionVersion: true }, orderBy: { id: "asc" } });
    // The owner moves down to Solo (a new hub key replaces the Shop one).
    await hubKey(f.shopId, "solo", { plan: "y", founding: true });
    assert.deepEqual(await companyPlan(f.shopId), { plan: "solo", keyPlan: "y", founding: true });
    assert.deepEqual(await db.user.findMany({ where: { shopId: f.shopId }, select: { id: true, active: true, sessionVersion: true }, orderBy: { id: "asc" } }), sessions, "nobody switched off, no session ended");
    let notice = await loginNotice(f.shopId);
    assert.deepEqual([notice.active, notice.over, notice.full], [4, true, false]);
    await refused("adding while over two", () => add(f.user));
    await refused("restoring while over two", async () => setPersonActiveAs(f.user, await idOf(offOne), true));
    ok("over two on Solo: everyone keeps working, the owner's notice, adding and restoring refused");

    await setPersonActiveAs(f.user, await idOf(people[0]), false);
    notice = await loginNotice(f.shopId);
    assert.deepEqual([notice.active, notice.over, notice.full], [3, true, false]);
    await setPersonActiveAs(f.user, await idOf(people[1]), false);
    notice = await loginNotice(f.shopId);
    assert.deepEqual([notice.active, notice.over, notice.full], [2, false, true]);
    await refused("at two on Solo", () => add(f.user));
    ok("down to two: the notice turns to \"both in use\", and the next one still needs Shop");

    // Back on Shop: the limit goes at once.
    await hubKey(f.shopId, "shop");
    await setPersonActiveAs(f.user, await idOf(offOne), true);
    await add(f.user);
    assert.equal(await activeLogins(f.shopId), 4);
    ok("back on Shop: restoring and adding work again");
  }

  // ---------- 5. The words, and the actions' path ----------
  {
    assert.equal(SOLO_FULL, "The Solo plan includes two people signed in. Switch to the Shop plan on your StitchHub account to add more: Settings → Account.");
    assert.equal(planWords({ plan: "solo", keyPlan: "y", founding: true }), "Solo (up to two people signed in), yearly, founding-shop price");
    assert.equal(planWords({ plan: "shop", keyPlan: "m", founding: false }), "Shop (everyone at the shop), monthly");
    assert.equal(planWords({ plan: "shop", keyPlan: "t", founding: false }), "Shop (everyone at the shop), free trial");
    assert.equal(planWords({ plan: "shop", keyPlan: "w", founding: false }), "Shop (everyone at the shop), free while partnered");
    const src = fs.readFileSync(path.join(process.cwd(), "src/actions/settings.ts"), "utf8");
    assert.match(src, /export const addUser = safe\(async function addUser\(formData: FormData\) \{\s+await addPersonAs\(await requireAdmin\(\), formData\);/);
    assert.match(src, /export const setUserActive = safe\(async function setUserActive\(userId: string, active: boolean\) \{\s+await setPersonActiveAs\(await requireAdmin\(\), userId, active === true\);/);
    ok("the refusal's words as decided, the plan's words for Settings → Account, and addUser / setUserActive go through src/lib/people.ts");
  }

  console.log(`plans: ${steps} checks passed`);
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
