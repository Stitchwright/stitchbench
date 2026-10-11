import "server-only";
// The gating API for the add-on modules (modules-design.md section 6.1). Since 1.8 (free-software-design.md, 11 Oct
// 2026) every module but the Assistant is free: Vac Shop, Small Appliance Repair, Scheduling, Marketing and Maker Shop
// are on while the company has switched them on in Settings → Features (ShopFeature), and nothing else counts. The
// Assistant is still bought, so a license key decides it, as does the program's own key ("base"), but only where the
// owner's hosting is billed (HOSTING_BILLING=on): anywhere else nothing ever makes a company read-only but a move.
// Only this file reads License and ModuleGrant rows, and every stored key is verified from its text each time: nothing
// in the database can switch the Assistant on by itself.
import { cache } from "react";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { acceptScope, adminPosition, effectiveNow, resolveStatus, statusAt, verifyLicense, windows, type AdminPosition, type GrantRow, type Verified, type Window } from "@/lib/license";
import { LICENSE_PUBLIC_KEYS } from "@/lib/license-keys";
import { baseWritable, blockedMessage, canWrite, FEATURE_IDS, isFeatureId, MODULE_IDS, MODULES, toNavGates, type FeatureId, type ModuleId, type Modules, type ModuleState, type NavGate } from "@/lib/module-info";

export const isDesktop = () => process.env.STITCH_DESKTOP === "1";

/**
 * The owner's hosted services, once their hosting is billed (free-software-design.md section 7, decision 2): only there
 * does the program's own key count, so a hosting left unpaid makes the company read-only. Never on the Windows program,
 * whatever its PC's environment says, and never on a self-hosted server (the variable isn't set there).
 */
export const hostingBilling = () => !isDesktop() && process.env.HOSTING_BILLING === "on";

/** The host of DATABASE_URL is this machine. */
export function localDatabase(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Where development keys (scripts/license/dev-key.json) count: never on the Windows program or a production server. */
export const devKeysAllowed = () => {
  if (process.env.STITCH_DESKTOP === "1") return false;
  // next dev and check scripts.
  if (process.env.NODE_ENV !== "production") return true;
  // A test build (STITCH_TEST_BUILD=1 at build time, inlined by next.config.ts), run against a database on this machine.
  return process.env.STITCH_TEST_BUILD === "1" && localDatabase();
};

/** A production build that accepts development keys: said once in the log (section 3.3). */
let saidTestBuild = false;
export function testBuild(): boolean {
  const on = process.env.NODE_ENV === "production" && devKeysAllowed();
  if (on && !saidTestBuild) {
    saidTestBuild = true;
    console.warn("TEST BUILD: development license keys are accepted");
  }
  return on;
}

// Verification is a pure function of the key text and the compiled public keys: memoised per process, capped.
const verified = new Map<string, Verified>();
function verifyMemo(text: string): Verified {
  let v = verified.get(text);
  if (!v) {
    v = verifyLicense(text, LICENSE_PUBLIC_KEYS);
    if (verified.size >= 1000) verified.delete(verified.keys().next().value as string);
    verified.set(text, v);
  }
  return v;
}

/**
 * The only caller of verifyLicense in the app: memoised verification, then acceptScope for this use (section 3.4). No
 * server holds a hosting key any more (the Companies switch is gone), so a "hosted" key never counts.
 */
export function verifyFor(text: string, use: "pasted" | "grant"): Verified {
  const v = verifyMemo(text);
  if (!v.ok) return v;
  if (!acceptScope(v.scope, use, { devAllowed: devKeysAllowed(), hostedHeld: false })) {
    return {
      ok: false,
      reason:
        v.scope === "hosted"
          ? "That key was for the hosted StitchBench's own use."
          : v.scope === "dev"
            ? "This is a test key. It only works on a test copy of StitchBench."
            : "That key can't be used as the administrator's switch.",
    };
  }
  return v;
}

function ymdIn(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** A module a key decides (the Assistant, the program itself), from that key's windows. */
function keyState(id: ModuleId, r: ReturnType<typeof statusAt>, tz: string): ModuleState {
  const best: Window | null = r.best;
  return {
    id,
    label: MODULES[id].label,
    status: r.status,
    active: canWrite(r.status),
    lastDay: best?.lastDay ?? null,
    graceLastDay: best?.graceLastDay ?? null,
    startsOn: r.startsAt ? ymdIn(r.startsAt, tz) : null,
    endedAt: r.status === "lapsed" ? r.endedAt : null,
    source: best ? "key" : null,
    keyId: best?.keyId ?? null,
    switchedOff: false,
  };
}

type FeatureRow = { shopId: string; module: string; enabled: boolean; changedAt: Date };

/**
 * A feature, from the company's own switch: on; switched off (lapsed from that moment, so work that came in before can
 * be finished and the records stay readable); or never switched on (off).
 */
function featureState(id: FeatureId, row: FeatureRow | undefined): ModuleState {
  const on = row?.enabled === true;
  const off = row != null && !row.enabled;
  return {
    id,
    label: MODULES[id].label,
    status: on ? "on" : off ? "lapsed" : "off",
    active: on,
    lastDay: null,
    graceLastDay: null,
    startsOn: null,
    endedAt: off ? row.changedAt : null,
    source: "feature",
    keyId: null,
    switchedOff: off,
  };
}

/** Who carried a company's working add-ons over from its keys, as Settings → Features shows it. */
export const FROM_KEYS = "Your license keys";

type LicenseRow = { shopId: string; key: string };

/**
 * A company from before 1.8 (Shop.featuresSetUpAt null): its Features start as the add-ons its keys and the hosted
 * switch had working at that moment, judged exactly as 1.7 judged them, so nothing a shop uses disappears with the
 * update. A module that had ended (its grace over, or switched off by the administrator) starts switched off from the
 * day it ended, so its records stay readable and the work from before then can still be finished, as before. Done once
 * per company: the first load to claim the company writes its rows; a later key changes nothing.
 */
async function setUpFromKeys(shops: { id: string; timeZone: string }[], licenses: LicenseRow[], at: Date | undefined, desktop: boolean): Promise<void> {
  const grants = desktop
    ? []
    : await db.moduleGrant.findMany({ where: { shopId: { in: shops.map((s) => s.id) } }, select: { id: true, shopId: true, module: true, mode: true, key: true, createdAt: true } });
  const real = new Date();
  for (const shop of shops) {
    const good = licenses
      .filter((l) => l.shopId === shop.id)
      .map((l) => verifyFor(l.key, "pasted"))
      .filter((v): v is Extract<Verified, { ok: true }> => v.ok && v.payload.s === shop.id);
    const now = at ?? effectiveNow(real, good.map((v) => new Date(v.payload.t)), desktop).now;
    const rows: { shopId: string; module: FeatureId; enabled: boolean; changedAt: Date; byName: string }[] = [];
    for (const id of FEATURE_IDS) {
      const ws = good.flatMap((v) => windows(v.payload, shop.timeZone, "key")).filter((w) => w.module === id);
      let pos: AdminPosition | null = null;
      const g: GrantRow[] = grants.filter((r) => r.shopId === shop.id && r.module === id);
      if (g.length) {
        pos = adminPosition(g);
        if (pos.onKey) {
          const gv = verifyFor(pos.onKey, "grant");
          if (gv.ok && gv.payload.s === shop.id && gv.payload.m.includes(id)) ws.push(...windows(gv.payload, shop.timeZone, "admin").filter((w) => w.module === id));
        }
      }
      const r = resolveStatus(ws, now, pos);
      if (canWrite(r.status)) rows.push({ shopId: shop.id, module: id, enabled: true, changedAt: real, byName: FROM_KEYS });
      else if (r.status === "lapsed") rows.push({ shopId: shop.id, module: id, enabled: false, changedAt: r.endedAt ?? real, byName: FROM_KEYS });
    }
    const claimed = await db.$transaction(async (tx) => {
      // The row lock: a second load of the same company waits here, then finds it set up and writes nothing.
      const { count } = await tx.shop.updateMany({ where: { id: shop.id, featuresSetUpAt: null }, data: { featuresSetUpAt: real } });
      // A switch the company already made (it can't have, before this, but a check or an import might) is kept.
      if (count && rows.length) await tx.shopFeature.createMany({ data: rows, skipDuplicates: true });
      return count > 0;
    });
    if (claimed) console.info(`[features] ${JSON.stringify({ company: shop.id, fromKeys: rows.filter((r) => r.enabled).map((r) => r.module), ended: rows.filter((r) => !r.enabled).map((r) => r.module) })}`);
  }
}

/** Every company's modules in a few queries, whatever the number of companies (section 6.1). */
export async function loadModulesMany(shopIds: string[], opts: { now?: Date } = {}): Promise<Map<string, Modules>> {
  const ids = [...new Set(shopIds)];
  const out = new Map<string, Modules>();
  if (!ids.length) return out;
  const desktop = isDesktop();
  const [shops, licenses] = await Promise.all([
    db.shop.findMany({ where: { id: { in: ids } }, select: { id: true, timeZone: true, movingAt: true, movedTo: true, movedOutAt: true, featuresSetUpAt: true } }),
    db.license.findMany({ where: { shopId: { in: ids } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { shopId: true, key: true } }),
  ]);
  const fresh = shops.filter((s) => !s.featuresSetUpAt);
  if (fresh.length) await setUpFromKeys(fresh, licenses, opts.now, desktop);
  const features = await db.shopFeature.findMany({ where: { shopId: { in: ids } }, select: { shopId: true, module: true, enabled: true, changedAt: true } });
  const real = new Date();
  const billing = hostingBilling();
  testBuild(); // says so in the log, once, on a test build
  for (const shop of shops) {
    const good = licenses
      .filter((l) => l.shopId === shop.id)
      .map((l) => verifyFor(l.key, "pasted"))
      .filter((v): v is Extract<Verified, { ok: true }> => v.ok && v.payload.s === shop.id);
    const now = opts.now ?? effectiveNow(real, good.map((v) => new Date(v.payload.t)), desktop).now;
    const keyWindows = good.flatMap((v) => windows(v.payload, shop.timeZone, "key"));
    const states = {} as Record<ModuleId, ModuleState>;
    for (const id of MODULE_IDS) {
      if (isFeatureId(id)) states[id] = featureState(id, features.find((f) => f.shopId === shop.id && f.module === id));
      // Hosting isn't billed here: the program's own key changes nothing, so the program is always fully working ("off").
      else if (id === "base" && !billing) states[id] = keyState(id, statusAt([], now), shop.timeZone);
      else states[id] = keyState(id, statusAt(keyWindows.filter((w) => w.module === id), now), shop.timeZone);
    }
    out.set(shop.id, {
      shopId: shop.id,
      now,
      states,
      moving: shop.movingAt ? { at: shop.movingAt, to: shop.movedTo, outAt: shop.movedOutAt } : null,
    });
  }
  return out;
}

export async function loadModules(shopId: string, opts: { now?: Date } = {}): Promise<Modules> {
  const m = (await loadModulesMany([shopId], opts)).get(shopId);
  if (!m) throw new UserError("Company not found.");
  return m;
}

/** Per request (React cache); calls through outside one. */
export const getModules = cache((shopId: string) => loadModules(shopId));

export async function moduleState(shopId: string, id: ModuleId): Promise<ModuleState> {
  return (await getModules(shopId)).states[id];
}

/** New work allowed (a feature switched on; a key on, due to renew, or in grace). */
export async function hasModule(shopId: string, id: ModuleId): Promise<boolean> {
  return (await moduleState(shopId, id)).active;
}

export type Who = string | { shopId: string; role?: "OWNER" | "ADMIN" | "TECH" };
const shopIdOf = (who: Who) => (typeof who === "string" ? who : who.shopId);
export const isAdminWho = (who: Who) => typeof who === "string" || who.role !== "TECH";

/** Throws UserError(blockedMessage(state, role !== "TECH")) unless new work is allowed. */
export async function requireModule(who: Who, id: ModuleId): Promise<ModuleState> {
  const s = await moduleState(shopIdOf(who), id);
  if (!s.active) throw new UserError(blockedMessage(s, isAdminWho(who)));
  return s;
}

export async function navGates(shopId: string): Promise<Record<ModuleId, NavGate>> {
  return toNavGates(await getModules(shopId));
}

/** Route handlers: a 403 Response with the blocked message, or null to go on. */
export async function moduleResponse(shopId: string, id: ModuleId, admin = true): Promise<Response | null> {
  const s = await moduleState(shopId, id);
  return s.active ? null : new Response(blockedMessage(s, admin), { status: 403 });
}

/**
 * Workers: the shops (all on the install, or the given ones) where the module is active now. A company that is
 * read-only (its hosting unpaid, hub-accounts-billing-design.md 3.5), or that is being moved to another install
 * (company-move-design.md section 7), is skipped for every module, as it is for new work.
 */
export async function shopsWithModule(id: ModuleId, shopIds?: string[]): Promise<string[]> {
  const ids = shopIds ?? (await db.shop.findMany({ select: { id: true } })).map((s) => s.id);
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = await loadModulesMany(ids.slice(i, i + 500));
    for (const id2 of ids.slice(i, i + 500)) {
      const m = chunk.get(id2);
      if (m?.states[id].active && !m.moving && (id === "base" || baseWritable(m.states.base.status))) out.push(id2);
    }
  }
  return out;
}
