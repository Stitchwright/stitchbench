import "server-only";
// Shop hop passports (shop-features-round-2-design.md 4.6), the program's side. Off until the shop turns it on (Settings,
// Selling). The hub holds the hops: an organizer shop starts one (name, dates, the prize rule) and hands other shops an
// invite code; each shop chooses to take part (the sharing rule). Shoppers sign up on the hub's hop page and get a
// passport code. Here: "Stamp a passport" (the camera or the code typed) gives a big tick and "Stamp 4 of 10"; the stamp
// is the shop's own record (HopStampLocal), sent to the hub signed with the shop's partner key; when the hub can't be
// reached it waits and goes on the next try. The page shows today's visitors (a shopper's details only if she chose to
// share them with this shop; everyone else is a count) and totals. The organizer sees completed passports and draws a
// winner. Every query by shopId; bodies take the user so the check script can drive them. The hub routes are listed
// in the Built note.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { UserError, isUserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { hubFetch, hubId, hubJoined } from "@/lib/hub";
import { ownKey } from "@/lib/partner-keys";
import { ymdOf } from "@/lib/zoned";
import { passportCode, ruleOf, signStamp } from "@/lib/hops/hop-math";

type HubHop = { id: string; name: string; startsOn?: string | null; endsOn?: string | null; rule?: string; shops?: number; role?: string; status?: string; slug?: string | null };

function owner(user: CurrentUser) {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can do that.");
}

async function hopsOn(shopId: string) {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { hopOn: true } });
  if (!s.hopOn) throw new UserError("Shop hops are off. Turn them on in Settings, Selling.");
}

async function hubJson<T>(user: CurrentUser, path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  if (!(await hubJoined())) throw new UserError("Shop hops run on the community hub: join it first (Settings, Community hub).");
  const r = await hubFetch(path, { method: init.method ?? "GET", json: init.json, shopRef: user.shopId });
  return (await r.json()) as T;
}

/** Turns shop hops on or off for the shop (the menu shows the page while on). Owners and admins. */
export async function setHopOnFor(user: CurrentUser, on: boolean): Promise<void> {
  owner(user);
  await db.shop.update({ where: { id: user.shopId }, data: { hopOn: on } });
}

async function saveHop(shopId: string, h: HubHop): Promise<string> {
  const data = {
    name: String(h.name ?? "Shop hop").slice(0, 120),
    startsOn: h.startsOn ?? null,
    endsOn: h.endsOn ?? null,
    rule: typeof h.rule === "string" && /^(all|any:\d{1,3})$/.test(h.rule) ? h.rule : "all",
    shopsCount: Number.isInteger(h.shops) ? Number(h.shops) : 1,
    role: h.role === "ORGANIZER" ? "ORGANIZER" : "MEMBER",
    status: h.status === "LEFT" ? "LEFT" : "JOINED",
    slug: h.slug ?? null,
  };
  const row = await db.shopHop.upsert({ where: { shopId_hubHopId: { shopId, hubHopId: hubId(h.id) } }, create: { shopId, hubHopId: h.id, ...data }, update: data, select: { id: true } });
  return row.id;
}

/** The hops this shop takes part in, fresh from the hub (kept as they were when the hub can't be reached). */
export async function refreshHopsFor(user: CurrentUser): Promise<void> {
  await hopsOn(user.shopId);
  const r = await hubJson<{ hops: HubHop[] }>(user, "/v1/hops");
  for (const h of r.hops ?? []) await saveHop(user.shopId, h);
}

/** "Start a shop hop" (the organizer): the name, the dates and the prize rule. */
export async function startHopFor(user: CurrentUser, a: { name: string; startsOn: string; endsOn: string; ruleKind: string; ruleN?: number | null }): Promise<string> {
  owner(user);
  await hopsOn(user.shopId);
  await requireBaseWritable(user);
  const name = a.name.trim().slice(0, 120);
  if (!name) throw new UserError("Give the hop a name, like Fall Shop Hop 2026.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.startsOn) || !/^\d{4}-\d{2}-\d{2}$/.test(a.endsOn) || a.endsOn < a.startsOn) throw new UserError("Pick the first and last day of the hop.");
  let rule: string;
  try {
    rule = ruleOf(a.ruleKind, a.ruleN);
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : "Check the prize rule.");
  }
  const key = await ownKey(user.shopId);
  const r = await hubJson<{ hop: HubHop }>(user, "/v1/hops", { method: "POST", json: { name, startsOn: a.startsOn, endsOn: a.endsOn, rule, publicKey: key.publicKey } });
  return saveHop(user.shopId, { ...r.hop, role: "ORGANIZER" });
}

async function ownHop(user: CurrentUser, id: string) {
  const h = typeof id === "string" ? await db.shopHop.findFirst({ where: { id, shopId: user.shopId } }) : null;
  if (!h) throw new UserError("Shop hop not found.");
  return h;
}

/** The organizer's invite code for another shop (it chooses to join with it). */
export async function inviteCodeFor(user: CurrentUser, hopId: string): Promise<string> {
  owner(user);
  const h = await ownHop(user, hopId);
  if (h.role !== "ORGANIZER") throw new UserError("Only the hop's organizer invites shops.");
  const r = await hubJson<{ code: string }>(user, `/v1/hops/${hubId(h.hubHopId)}/invite-code`, { method: "POST" });
  return r.code;
}

/** "Take part": the code from the organizer joins this shop to the hop (its choice). */
export async function joinHopFor(user: CurrentUser, code: string): Promise<string> {
  owner(user);
  await hopsOn(user.shopId);
  const c = String(code ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9-]{6,40}$/.test(c)) throw new UserError("Type the code the organizer sent you.");
  const key = await ownKey(user.shopId);
  const r = await hubJson<{ hop: HubHop }>(user, "/v1/hops/join", { method: "POST", json: { code: c, publicKey: key.publicKey } });
  return saveHop(user.shopId, { ...r.hop, role: "MEMBER" });
}

/** Leaves a hop (stamps already given stay on the shoppers' passports). */
export async function leaveHopFor(user: CurrentUser, hopId: string): Promise<void> {
  owner(user);
  const h = await ownHop(user, hopId);
  await hubJson(user, `/v1/hops/${hubId(h.hubHopId)}/leave`, { method: "POST" });
  await db.shopHop.updateMany({ where: { id: h.id, shopId: user.shopId }, data: { status: "LEFT" } });
}

type StampAnswer = { stampNo?: number; of?: number; complete?: boolean; shopper?: { name?: string | null; email?: string | null; phone?: string | null } | null };

/** Sends one stamp to the hub, signed; records what the hub answered (or why it couldn't). */
async function sendStamp(user: CurrentUser, stampId: string): Promise<boolean> {
  const s = await db.hopStampLocal.findFirst({ where: { id: stampId, shopId: user.shopId }, include: { hop: true } });
  if (!s || s.sentAt) return !!s;
  const key = await ownKey(user.shopId);
  const fields = { hopId: s.hop.hubHopId, shopRef: user.shopId, stampId: s.id, passport: s.passportRef, at: s.at.toISOString() };
  try {
    const r = await hubJson<StampAnswer>(user, `/v1/hops/${hubId(s.hop.hubHopId)}/stamps`, { method: "POST", json: { stampId: s.id, passport: s.passportRef, at: fields.at, sig: signStamp(key, fields) } });
    await db.hopStampLocal.updateMany({
      where: { id: s.id, shopId: user.shopId },
      data: {
        sentAt: new Date(),
        error: null,
        stampNo: Number.isInteger(r.stampNo) ? r.stampNo : null,
        stampsOf: Number.isInteger(r.of) ? r.of : null,
        complete: r.complete === true,
        shopperName: r.shopper?.name?.slice(0, 120) ?? null,
        shopperEmail: r.shopper?.email?.slice(0, 200) ?? null,
        shopperPhone: r.shopper?.phone?.slice(0, 40) ?? null,
      },
    });
    return true;
  } catch (e) {
    if (!isUserError(e)) throw e;
    // A passport the hub doesn't know is no stamp at all: taken back so it can be typed again.
    if ((e as { detail?: Record<string, unknown> | null }).detail?.code === "no_passport") {
      await db.hopStampLocal.deleteMany({ where: { id: s.id, shopId: user.shopId, sentAt: null } });
      throw new UserError("That passport isn't in this hop. Check the code on her passport.");
    }
    await db.hopStampLocal.updateMany({ where: { id: s.id, shopId: user.shopId }, data: { error: e.message.slice(0, 300) } });
    return false;
  }
}

export type StampResult = { ok: true; words: string; complete: boolean; waiting: boolean; shopper: string | null };

/** "Stamp a passport": the code read or typed; one stamp per passport per hop. The words for the big tick. */
export async function stampFor(user: CurrentUser, hopId: string, raw: string, now = new Date()): Promise<StampResult> {
  await hopsOn(user.shopId);
  await requireBaseWritable(user);
  const h = await ownHop(user, hopId);
  if (h.status !== "JOINED") throw new UserError("This shop isn't taking part in that hop any more.");
  const code = passportCode(raw);
  if (!code) throw new UserError("That isn't a passport code. It looks like HOP-7K2M-9QXD.");
  const tz = (await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true } })).timeZone;
  const today = ymdOf(now, tz);
  if ((h.startsOn && today < h.startsOn) || (h.endsOn && today > h.endsOn)) throw new UserError(`${h.name} runs ${h.startsOn ?? "?"} to ${h.endsOn ?? "?"}: no stamps today.`);
  const had = await db.hopStampLocal.findUnique({ where: { hopId_passportRef: { hopId: h.id, passportRef: code } } });
  if (had) return { ok: true, words: `Already stamped here${had.stampNo && had.stampsOf ? ` (stamp ${had.stampNo} of ${had.stampsOf})` : ""}.`, complete: had.complete, waiting: !had.sentAt, shopper: had.shopperName };
  const row = await db.hopStampLocal.create({ data: { id: `hs${crypto.randomBytes(12).toString("hex")}`, shopId: user.shopId, hopId: h.id, passportRef: code, at: now, byUserId: user.id } });
  const sent = await sendStamp(user, row.id);
  const s = (await db.hopStampLocal.findUnique({ where: { id: row.id } }))!;
  if (!sent) return { ok: true, words: "Stamped. The hub can't be reached just now: it goes there on the next try.", complete: false, waiting: true, shopper: null };
  return { ok: true, words: s.stampNo && s.stampsOf ? `Stamp ${s.stampNo} of ${s.stampsOf}` : "Stamped", complete: s.complete, waiting: false, shopper: s.shopperName };
}

/** Sends the stamps still waiting for the hub (the page's "Send now" and every visit to the page). */
export async function sendWaitingFor(user: CurrentUser): Promise<number> {
  const rows = await db.hopStampLocal.findMany({ where: { shopId: user.shopId, sentAt: null }, select: { id: true }, take: 200 });
  let n = 0;
  for (const r of rows) {
    try {
      if (await sendStamp(user, r.id)) n += 1;
    } catch (e) {
      if (!isUserError(e)) throw e;
    }
  }
  return n;
}

/** Today's visitors at this shop for a hop (a shopper's name only if she shared it), the totals, and what's waiting. */
export async function hopDay(shopId: string, hopId: string, now = new Date()) {
  const h = await db.shopHop.findFirst({ where: { id: hopId, shopId } });
  if (!h) return null;
  const tz = (await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } })).timeZone;
  const today = ymdOf(now, tz);
  const all = await db.hopStampLocal.findMany({ where: { shopId, hopId: h.id }, orderBy: { at: "desc" }, take: 2000 });
  const todays = all.filter((s) => ymdOf(s.at, tz) === today);
  return {
    hop: h,
    today: todays.map((s) => ({ id: s.id, at: s.at, name: s.shopperName, email: s.shopperEmail, phone: s.shopperPhone, stampNo: s.stampNo, of: s.stampsOf, complete: s.complete, waiting: !s.sentAt })),
    totals: { today: todays.length, all: all.length, shared: all.filter((s) => s.shopperName).length, waiting: all.filter((s) => !s.sentAt).length },
  };
}

export type Completed = { passport: string; name: string };
export type HopDraw = { id: string; passport: string; name: string; prize: string; present: boolean; at: string };

/** The organizer's list of completed passports and the draws so far (from the hub). */
export async function completedFor(user: CurrentUser, hopId: string): Promise<{ completed: Completed[]; draws: HopDraw[]; passports: number; stamps: number }> {
  owner(user);
  const h = await ownHop(user, hopId);
  if (h.role !== "ORGANIZER") throw new UserError("Only the hop's organizer sees the completed passports.");
  const r = await hubJson<{ completed?: Completed[]; draws?: HopDraw[]; passports?: number; stamps?: number }>(user, `/v1/hops/${hubId(h.hubHopId)}/completed`);
  return { completed: r.completed ?? [], draws: r.draws ?? [], passports: r.passports ?? 0, stamps: r.stamps ?? 0 };
}

/**
 * "Draw a winner" (the organizer), the same way as an event's drawing: among completed passports, leaving out anyone
 * who has won and was there and anyone drawn for this prize already. The hub records the draw.
 */
export async function drawHopWinnerFor(user: CurrentUser, hopId: string, prize: string): Promise<HopDraw> {
  const { completed, draws } = await completedFor(user, hopId);
  const h = await ownHop(user, hopId);
  const what = prize.trim().slice(0, 120) || "Grand prize";
  const won = new Set(draws.filter((d) => d.present).map((d) => d.passport));
  const forThis = new Set(draws.filter((d) => d.prize.toLowerCase() === what.toLowerCase()).map((d) => d.passport));
  const pool = completed.filter((c) => !won.has(c.passport) && !forThis.has(c.passport));
  if (!pool.length) throw new UserError(completed.length ? "Every completed passport has been drawn." : "No completed passports yet.");
  const pick = pool[crypto.randomInt(pool.length)];
  const r = await hubJson<{ draw: HopDraw }>(user, `/v1/hops/${hubId(h.hubHopId)}/draws`, { method: "POST", json: { passport: pick.passport, prize: what } });
  return r.draw;
}

/** "She's not here": the draw stays, marked not present (then Draw again). */
export async function hopNotPresentFor(user: CurrentUser, hopId: string, drawId: string): Promise<void> {
  owner(user);
  const h = await ownHop(user, hopId);
  await hubJson(user, `/v1/hops/${hubId(h.hubHopId)}/draws/${hubId(drawId)}`, { method: "PATCH", json: { present: false } });
}
