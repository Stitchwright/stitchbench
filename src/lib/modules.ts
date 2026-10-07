import "server-only";
// The gating API for paid modules (modules-design.md section 6.1). Only this file reads License and ModuleGrant rows,
// and every stored key is verified from its text each time: nothing in the database can switch a module on by itself.
import { cache } from "react";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { acceptScope, adminPosition, effectiveNow, resolveStatus, verifyLicense, windows, type AdminPosition, type GrantRow, type LicensePayload, type Verified, type Window } from "@/lib/license";
import { LICENSE_PUBLIC_KEYS } from "@/lib/license-keys";
import { baseWritable, blockedMessage, canWrite, isModuleId, MODULE_IDS, MODULES, toNavGates, type KeyView, type ModuleId, type Modules, type ModuleState, type NavGate } from "@/lib/module-info";
// license-signing imports isDesktop / devKeysAllowed from here; each file uses the other only inside functions, so the cycle is harmless.
import { hostedSigner } from "@/lib/license-signing";

export const isDesktop = () => process.env.STITCH_DESKTOP === "1";

/** The host of DATABASE_URL is this machine. */
export function localDatabase(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Where development keys (scripts/license/dev-key.json) count: never on the Windows program or a server holding a hosting key. */
export const devKeysAllowed = () => {
  if (process.env.STITCH_DESKTOP === "1" || process.env.LICENSE_HOSTED_KEY) return false;
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

/** The only caller of verifyLicense in the app: memoised verification, then acceptScope for this use (section 3.4). */
export function verifyFor(text: string, use: "pasted" | "grant"): Verified {
  const v = verifyMemo(text);
  if (!v.ok) return v;
  if (!acceptScope(v.scope, use, { devAllowed: devKeysAllowed(), hostedHeld: hostedSigner()?.scope === "hosted" })) {
    return {
      ok: false,
      reason:
        v.scope === "hosted"
          ? use === "pasted"
            ? "That key is for the hosted StitchBench's own use. Ask for a key to paste."
            : "This server holds no hosting key for this switch."
          : v.scope === "dev"
            ? "This is a test key. It only works on a test copy of StitchBench."
            : "That key can't be used as the administrator's switch.",
    };
  }
  return v;
}

type LicenseRow = { id: string; shopId: string; keyId: string; key: string; addedBy: string | null; source: string; createdAt: Date };

function keyView(row: LicenseRow, v: Verified, shopId: string, now: Date, tz: string): { view: KeyView; payload: LicensePayload | null } {
  if (!v.ok) {
    return {
      view: {
        rowId: row.id,
        keyId: row.keyId,
        modules: [],
        plan: null,
        from: null,
        lastDay: null,
        graceLastDay: null,
        issuedTo: null,
        addedBy: row.addedBy,
        addedAt: row.createdAt,
        source: row.source,
        state: "not-valid",
        reason: v.reason,
      },
      payload: null,
    };
  }
  const p = v.payload;
  const ws = windows(p, tz, "key");
  const w = ws[0];
  const base = {
    rowId: row.id,
    keyId: p.id,
    modules: p.m,
    plan: p.p,
    from: p.f,
    lastDay: p.u,
    graceLastDay: w?.graceLastDay ?? null,
    issuedTo: p.n,
    addedBy: row.addedBy,
    addedAt: row.createdAt,
    source: row.source,
    reason: null as string | null,
  };
  if (p.s !== shopId) return { view: { ...base, state: "other-company", reason: `For Company ID ${p.s}` }, payload: null };
  const state: KeyView["state"] = w && w.from > now ? "future" : w && now >= w.graceUntil ? "ended" : "current";
  return { view: { ...base, state }, payload: p };
}

function toState(id: ModuleId, r: ReturnType<typeof resolveStatus>, pos: AdminPosition | null, tz: string): ModuleState {
  const best: Window | null = r.best;
  const switchedOff = r.status === "lapsed" && pos?.offAt != null && (best == null || best.graceUntil <= pos.offAt || best.issuedAt <= pos.offAt);
  const offDay = pos?.offAt ? ymdIn(pos.offAt, tz) : null;
  return {
    id,
    label: MODULES[id].label,
    status: r.status,
    active: canWrite(r.status),
    lastDay: switchedOff && offDay ? offDay : (best?.lastDay ?? null),
    graceLastDay: switchedOff ? null : (best?.graceLastDay ?? null),
    startsOn: r.startsAt ? ymdIn(r.startsAt, tz) : null,
    endedAt: r.status === "lapsed" ? r.endedAt : null,
    plan: best?.plan ?? null,
    source: best?.source ?? null,
    keyId: best?.keyId ?? null,
    switchedOff,
  };
}

function ymdIn(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Every company's modules in three queries, whatever the number of companies (section 6.1). */
export async function loadModulesMany(shopIds: string[], opts: { now?: Date } = {}): Promise<Map<string, Modules>> {
  const ids = [...new Set(shopIds)];
  const out = new Map<string, Modules>();
  if (!ids.length) return out;
  const desktop = isDesktop();
  const [shops, licenses, grants] = await Promise.all([
    db.shop.findMany({ where: { id: { in: ids } }, select: { id: true, timeZone: true, movingAt: true, movedTo: true, movedOutAt: true } }),
    db.license.findMany({
      where: { shopId: { in: ids } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, shopId: true, keyId: true, key: true, addedBy: true, source: true, createdAt: true },
    }),
    desktop
      ? Promise.resolve([] as { id: string; shopId: string; module: string; mode: string; key: string | null; createdAt: Date }[])
      : db.moduleGrant.findMany({ where: { shopId: { in: ids } }, select: { id: true, shopId: true, module: true, mode: true, key: true, createdAt: true } }),
  ]);
  const real = new Date();
  const isTest = testBuild();
  for (const shop of shops) {
    const rows = licenses.filter((l) => l.shopId === shop.id);
    const checked = rows.map((row) => ({ row, v: verifyFor(row.key, "pasted") }));
    const good = checked.filter((c): c is { row: LicenseRow; v: Extract<Verified, { ok: true }> } => c.v.ok && c.v.payload.s === shop.id);
    const eff = opts.now
      ? { now: opts.now, floor: null, clockBehind: false }
      : effectiveNow(
          real,
          good.map((c) => new Date(c.v.payload.t)),
          desktop,
        );
    const now = eff.now;
    const keys = checked.map((c) => keyView(c.row, c.v, shop.id, now, shop.timeZone).view);
    const unknown = new Set<string>();
    const keyWindows: Window[] = [];
    for (const c of good) {
      for (const w of windows(c.v.payload, shop.timeZone, "key")) {
        if (isModuleId(w.module)) keyWindows.push(w);
        else unknown.add(w.module);
      }
    }
    const states = {} as Record<ModuleId, ModuleState>;
    for (const id of MODULE_IDS) {
      const ws = keyWindows.filter((w) => w.module === id);
      let pos: AdminPosition | null = null;
      if (!desktop) {
        const g: GrantRow[] = grants.filter((r) => r.shopId === shop.id && r.module === id);
        if (g.length) {
          pos = adminPosition(g);
          if (pos.onKey) {
            const gv = verifyFor(pos.onKey, "grant");
            if (gv.ok && gv.payload.s === shop.id && gv.payload.m.includes(id)) ws.push(...windows(gv.payload, shop.timeZone, "admin").filter((w) => w.module === id));
          }
        }
      }
      states[id] = toState(id, resolveStatus(ws, now, pos), pos, shop.timeZone);
    }
    out.set(shop.id, {
      shopId: shop.id,
      now,
      clockBehind: eff.clockBehind,
      floor: eff.floor,
      states,
      keys,
      testBuild: isTest,
      unknownModules: [...unknown].sort(),
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

/** New work allowed (on, renew or grace). */
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
 * Workers: the shops (all on the install, or the given ones) where the module is active now. A company whose program
 * key has lapsed (base read-only, hub-accounts-billing-design.md 3.5), or that is being moved to another install
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

/** Companies page: the newest switch rows with their decoded last day (never the key text). */
export async function grantHistory(limit: number): Promise<{ at: Date; shopId: string; module: string; mode: string; lastDay: string | null; byEmail: string; note: string | null }[]> {
  if (isDesktop()) return [];
  const rows = await db.moduleGrant.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { createdAt: true, shopId: true, module: true, mode: true, key: true, byEmail: true, note: true },
  });
  return rows.map((r) => {
    let lastDay: string | null = null;
    if (r.key) {
      const v = verifyMemo(r.key);
      if (v.ok) lastDay = v.payload.u;
    }
    return { at: r.createdAt, shopId: r.shopId, module: r.module, mode: r.mode, lastDay, byEmail: r.byEmail, note: r.note };
  });
}
