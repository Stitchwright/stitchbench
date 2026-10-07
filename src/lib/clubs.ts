import "server-only";
// Clubs (fabric-smarts-design.md section 4a, package F7): fat quarter and fabric clubs and Block of the Month, with a
// monthly price. Members are the shop's customers; each pays by card on the shop's own Stripe (a Stripe Customer and a
// monthly Subscription made with the shop's keys) or "pay at pickup", marked by hand. The monthly pick list says who gets
// what, shipped or picked up, and is marked done. Stripe's webhooks (paid, failed, cancelled) arrive through the online
// shop's webhook route (handleClubEvent below). Money is integer cents; every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { money, str } from "@/lib/format";
import { clubTenderOf, postClubPayment, voidClubPaymentsFor, voidClubSale } from "@/lib/club-books";
import { MAX_CENTS, centsField } from "@/lib/parts";
import { unseal } from "@/lib/messaging/secrets";
import { publicBaseUrl } from "@/lib/messaging/settings";
import { cancelSubscription, createCustomer, createSubscriptionCheckout, setSubscriptionPaused, type WebhookEvent } from "@/lib/shop/stripe";
import { dateIn } from "@/lib/time-zone";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";
import type { ClubBilling, ClubFulfil, ClubKind, ClubMemberStatus } from "@/generated/prisma/enums";

export const MAX_MEMBERS = 5000;
const MIN_PRICE_CENTS = 50; // Stripe's smallest charge
export const KIND_LABEL: Record<ClubKind, string> = { FAT_QUARTER: "Fat quarter club", FABRIC: "Fabric club", BOM: "Block of the Month", OTHER: "Other club" };
export const STATUS_LABEL: Record<ClubMemberStatus, string> = { ACTIVE: "Active", PAUSED: "Paused", CANCELLED: "Cancelled" };
const KINDS = Object.keys(KIND_LABEL) as ClubKind[];

const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
export const isMonth = (m: unknown): m is string => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
/** "2026-10" for a moment, in the shop's time zone. */
export const monthOf = (d: Date, timeZone: string) => dateIn(d, timeZone).slice(0, 7);
export const monthLabel = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------------------------------------------------------------
// Stripe, on the shop's own keys
// ---------------------------------------------------------------------------------------------------------------

/** Card billing needs the shop's own Stripe key and webhook secret (Settings -> Online shop) and a public address to come back to. */
export async function cardBillingFor(shopId: string): Promise<{ ready: boolean; why: string | null }> {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { stripeKeySealed: true, stripeWebhookSealed: true } });
  if (!s.stripeKeySealed || !s.stripeWebhookSealed) return { ready: false, why: "Card billing needs your own Stripe account: enter its key and webhook secret under Settings -> Online shop. Until then members pay at pickup." };
  if (!publicBaseUrl()) return { ready: false, why: "Card billing needs this server's public address (PUBLIC_URL) so Stripe can send people back. Until then members pay at pickup." };
  return { ready: true, why: null };
}

async function stripeKeyOf(shopId: string): Promise<string> {
  const s = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { stripeKeySealed: true } });
  const k = unseal(s.stripeKeySealed, shopId, "stripeKey");
  if (!k) throw new UserError("The shop's Stripe key isn't saved (or can't be read). Enter it again under Settings -> Online shop.");
  return k.plain;
}

// ---------------------------------------------------------------------------------------------------------------
// Clubs
// ---------------------------------------------------------------------------------------------------------------

export type ClubRow = {
  id: string;
  name: string;
  kind: ClubKind;
  monthlyCents: number;
  fulfil: ClubFulfil;
  billDay: number | null;
  series: { id: string; name: string } | null;
  note: string | null;
  closed: boolean;
  active: number;
  paused: number;
  cancelled: number;
  /** Members (active or paused) whose last card payment failed. */
  failed: number;
  monthlyTotalCents: number;
};

export async function clubsFor(shopId: string): Promise<ClubRow[]> {
  const [clubs, groups, failed] = await Promise.all([
    db.club.findMany({ where: { shopId }, orderBy: [{ closedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }], include: { series: { select: { id: true, name: true } } } }),
    db.clubMember.groupBy({ by: ["clubId", "status"], where: { shopId }, _count: { _all: true } }),
    db.clubMember.groupBy({ by: ["clubId"], where: { shopId, status: { in: ["ACTIVE", "PAUSED"] }, payFailedAt: { not: null } }, _count: { _all: true } }),
  ]);
  const n = (clubId: string, status: ClubMemberStatus) => groups.find((g) => g.clubId === clubId && g.status === status)?._count._all ?? 0;
  return clubs.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    monthlyCents: c.monthlyCents,
    fulfil: c.fulfil,
    billDay: c.billDay,
    series: c.series,
    note: c.note,
    closed: !!c.closedAt,
    active: n(c.id, "ACTIVE"),
    paused: n(c.id, "PAUSED"),
    cancelled: n(c.id, "CANCELLED"),
    failed: failed.find((f) => f.clubId === c.id)?._count._all ?? 0,
    monthlyTotalCents: n(c.id, "ACTIVE") * c.monthlyCents,
  }));
}

export type MemberRow = {
  id: string;
  customerId: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: ClubMemberStatus;
  fulfil: ClubFulfil;
  billing: ClubBilling;
  /** Card billing with no card yet: the link hasn't been used. */
  awaitingCard: boolean;
  paidMonth: string | null;
  lastPaidAt: Date | null;
  payFailedAt: Date | null;
  note: string | null;
  joinedAt: Date;
};
export type ClubView = ClubRow & { members: MemberRow[]; timeZone: string };

export async function clubFor(shopId: string, id: string): Promise<ClubView | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const [row, shop] = await Promise.all([
    db.club.findFirst({ where: { id, shopId }, include: { series: { select: { id: true, name: true } }, members: { include: { customer: { select: { name: true, phone: true, email: true } } } } } }),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } }),
  ]);
  if (!row) return null;
  const order = { ACTIVE: 0, PAUSED: 1, CANCELLED: 2 } as const;
  const members: MemberRow[] = row.members
    .map((m) => ({
      id: m.id,
      customerId: m.customerId,
      name: m.customer.name,
      phone: m.customer.phone,
      email: m.customer.email,
      status: m.status,
      fulfil: m.fulfil,
      billing: m.billing,
      awaitingCard: m.billing === "STRIPE" && m.status !== "CANCELLED" && !m.stripeSubscriptionId,
      paidMonth: m.paidMonth,
      lastPaidAt: m.lastPaidAt,
      payFailedAt: m.payFailedAt,
      note: m.note,
      joinedAt: m.joinedAt,
    }))
    .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const count = (s: ClubMemberStatus) => members.filter((m) => m.status === s).length;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    monthlyCents: row.monthlyCents,
    fulfil: row.fulfil,
    billDay: row.billDay,
    series: row.series,
    note: row.note,
    closed: !!row.closedAt,
    active: count("ACTIVE"),
    paused: count("PAUSED"),
    cancelled: count("CANCELLED"),
    failed: members.filter((m) => m.status !== "CANCELLED" && m.payFailedAt).length,
    monthlyTotalCents: count("ACTIVE") * row.monthlyCents,
    members,
    timeZone: shop.timeZone,
  };
}

/** Starts a club (id null) or changes one: name, kind, monthly price, ship or pickup for new members, bill day, the Block of the Month series. */
export async function saveClubFor(user: CurrentUser, id: string | null, fd: FormData): Promise<{ id: string; text: string }> {
  const name = str(fd.get("name"));
  if (!name) throw new UserError("Give the club a name.");
  if (name.length > 80) throw new UserError("The name is 80 characters at most.");
  const kind = (str(fd.get("kind")) ?? "FAT_QUARTER") as ClubKind;
  if (!KINDS.includes(kind)) throw new UserError("Pick the kind of club.");
  const monthlyCents = centsField(fd.get("price"), "Monthly price");
  if (monthlyCents == null) throw new UserError("Enter the monthly price in dollars.");
  if (monthlyCents < MIN_PRICE_CENTS || monthlyCents > MAX_CENTS) throw new UserError("Monthly price: from $0.50 up (Stripe's smallest charge).");
  const fulfil: ClubFulfil = str(fd.get("fulfil")) === "SHIP" ? "SHIP" : "PICKUP";
  const dayRaw = str(fd.get("billDay"));
  let billDay: number | null = null;
  if (dayRaw) {
    billDay = Number(dayRaw);
    if (!Number.isInteger(billDay) || billDay < 1 || billDay > 28) throw new UserError("Bill day: a day of the month from 1 to 28 (or leave it blank to bill on each member's sign-up day).");
  }
  const seriesId = str(fd.get("seriesId"));
  if (seriesId) {
    assertId(seriesId);
    const s = await db.kitSeries.findFirst({ where: { id: seriesId, shopId: user.shopId }, select: { id: true } });
    if (!s) throw new UserError("Series not found.");
  }
  if (seriesId && kind !== "BOM") throw new UserError("Only a Block of the Month club follows a kit series.");
  const note = str(fd.get("note"))?.slice(0, 500) ?? null;
  const data = { name, kind, monthlyCents, fulfil, billDay, seriesId, note };
  if (!id) {
    const c = await db.club.create({ data: { shopId: user.shopId, ...data } });
    return { id: c.id, text: `${name} is started. Add members next.` };
  }
  assertId(id);
  const c = await db.club.findFirst({ where: { id, shopId: user.shopId } });
  if (!c) throw new UserError("Club not found.");
  await db.club.update({ where: { id: c.id }, data });
  const subs = await db.clubMember.count({ where: { shopId: user.shopId, clubId: c.id, stripeSubscriptionId: { not: null }, status: { not: "CANCELLED" } } });
  const priced = monthlyCents !== c.monthlyCents && subs > 0;
  return { id: c.id, text: `Saved ${name}.${priced ? ` The new price applies to members who join from now on; the ${subs} card subscriptions already running keep the old price until you cancel and re-add them.` : ""}` };
}

/** Closes a club to new members (nobody active or paused), or opens it again. */
export async function closeClubFor(user: CurrentUser, id: string, close: boolean): Promise<string> {
  assertId(id);
  const c = await db.club.findFirst({ where: { id, shopId: user.shopId } });
  if (!c) throw new UserError("Club not found.");
  if (close) {
    const live = await db.clubMember.count({ where: { shopId: user.shopId, clubId: c.id, status: { in: ["ACTIVE", "PAUSED"] } } });
    if (live) throw new UserError(`${live} members are still active or paused. Cancel them first.`);
  }
  await db.club.update({ where: { id: c.id }, data: { closedAt: close ? new Date() : null } });
  return close ? `${c.name} is closed.` : `${c.name} is open again.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------------------------

/** Signs a customer up. Card billing needs the shop's Stripe (then "Send card link" starts the subscription); otherwise pay at pickup. */
export async function addMemberFor(user: CurrentUser, clubId: string, fd: FormData): Promise<string> {
  assertId(clubId);
  const customerId = str(fd.get("customerId"));
  if (!customerId) throw new UserError("Search for the customer, then pick them.");
  assertId(customerId);
  const [club, customer] = await Promise.all([
    db.club.findFirst({ where: { id: clubId, shopId: user.shopId } }),
    db.customer.findFirst({ where: { id: customerId, shopId: user.shopId }, select: { id: true, name: true } }),
  ]);
  if (!club) throw new UserError("Club not found.");
  if (!customer) throw new UserError("Customer not found.");
  if (club.closedAt) throw new UserError(`${club.name} is closed to new members.`);
  const fulfil: ClubFulfil = (str(fd.get("fulfil")) ?? club.fulfil) === "SHIP" ? "SHIP" : "PICKUP";
  const billing: ClubBilling = str(fd.get("billing")) === "STRIPE" ? "STRIPE" : "PAY_AT_PICKUP";
  if (billing === "STRIPE") {
    const b = await cardBillingFor(user.shopId);
    if (!b.ready) throw new UserError(b.why!);
  }
  const note = str(fd.get("note"))?.slice(0, 200) ?? null;
  const current = await db.clubMember.count({ where: { shopId: user.shopId, clubId: club.id, status: { not: "CANCELLED" } } });
  if (current >= MAX_MEMBERS) throw new UserError(`A club holds ${MAX_MEMBERS} members at most.`);
  const fresh = { status: "ACTIVE" as const, fulfil, billing, note, joinedAt: new Date(), pausedAt: null, cancelledAt: null, stripeSubscriptionId: null, paidMonth: null, lastPaidAt: null, payFailedAt: null };
  try {
    const old = await db.clubMember.findFirst({ where: { shopId: user.shopId, clubId: club.id, customerId: customer.id } });
    if (old) {
      if (old.status !== "CANCELLED") throw new UserError(`${customer.name} is already in ${club.name}.`);
      await db.clubMember.update({ where: { id: old.id }, data: fresh });
    } else {
      await db.clubMember.create({ data: { shopId: user.shopId, clubId: club.id, customerId: customer.id, ...fresh } });
    }
  } catch (e) {
    if (isUnique(e)) throw new UserError(`${customer.name} is already in ${club.name}.`);
    throw e;
  }
  // A Block of the Month club's members are on the series' roster too (the kits' handouts list them).
  if (club.seriesId) {
    try {
      const has = await db.kitSeriesMember.findFirst({ where: { shopId: user.shopId, seriesId: club.seriesId, customerId: customer.id }, select: { id: true } });
      if (!has) await db.kitSeriesMember.create({ data: { shopId: user.shopId, seriesId: club.seriesId, customerId: customer.id, note: `Club: ${club.name}` } });
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }
  return billing === "STRIPE" ? `${customer.name} is in ${club.name}. Send them the card link to start the monthly billing.` : `${customer.name} is in ${club.name}, paying at pickup (mark each month paid on the pick list).`;
}

async function memberOf(shopId: string, memberId: string) {
  assertId(memberId);
  const m = await db.clubMember.findFirst({ where: { id: memberId, shopId }, include: { club: true, customer: { select: { name: true, email: true } } } });
  if (!m) throw new UserError("Member not found.");
  return m;
}

/** Ship or pickup, the note, and how they pay (card billing can't be changed while a subscription is running). */
export async function saveMemberFor(user: CurrentUser, memberId: string, fd: FormData): Promise<string> {
  const m = await memberOf(user.shopId, memberId);
  const data: Prisma.ClubMemberUpdateInput = {};
  const f = str(fd.get("fulfil"));
  if (f) data.fulfil = f === "SHIP" ? "SHIP" : "PICKUP";
  if (fd.has("note")) data.note = str(fd.get("note"))?.slice(0, 200) ?? null;
  const b = str(fd.get("billing"));
  if (b && b !== m.billing) {
    if (m.status === "CANCELLED") throw new UserError("A cancelled member can be added again from the Add a member box.");
    if (m.stripeSubscriptionId) throw new UserError("This member pays by card with a subscription running. Cancel it first to change how they pay.");
    if (b === "STRIPE") {
      const r = await cardBillingFor(user.shopId);
      if (!r.ready) throw new UserError(r.why!);
      data.billing = "STRIPE";
    } else data.billing = "PAY_AT_PICKUP";
  }
  await db.clubMember.update({ where: { id: m.id }, data });
  return `Saved ${m.customer.name}.`;
}

/** The first bill date for a club with a fixed bill day: the next such day (in this or next month), at noon UTC. */
export function nextAnchor(billDay: number, now = new Date()): number {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  let at = Date.UTC(y, mo, billDay, 12);
  if (at <= now.getTime() + 86_400_000) at = Date.UTC(y, mo + 1, billDay, 12);
  return Math.floor(at / 1000);
}

/**
 * The Stripe page where the member enters their card and starts the monthly subscription: a Stripe Customer for them
 * (made once), then a Checkout Session in subscription mode. Returns the address to hand them (it expires in 24 hours).
 */
export async function cardLinkFor(user: CurrentUser, memberId: string, now = new Date()): Promise<string> {
  const m = await memberOf(user.shopId, memberId);
  if (m.billing !== "STRIPE") throw new UserError("This member pays at pickup. Change them to card billing first.");
  if (m.status !== "ACTIVE") throw new UserError("Only an active member can start card billing.");
  if (m.stripeSubscriptionId) throw new UserError("This member's card subscription is already running.");
  const b = await cardBillingFor(user.shopId);
  if (!b.ready) throw new UserError(b.why!);
  const key = await stripeKeyOf(user.shopId);
  const base = publicBaseUrl()!;
  let customer = m.stripeCustomerId;
  if (!customer) {
    const c = await createCustomer(key, { name: m.customer.name, email: m.customer.email, metadata: { shopId: user.shopId, memberId: m.id } }, `club-cust-${m.id}`);
    customer = c.id;
    // Only if nobody else saved one in the meantime.
    await db.clubMember.updateMany({ where: { id: m.id, shopId: user.shopId, stripeCustomerId: null }, data: { stripeCustomerId: customer } });
  }
  const meta = { shopId: user.shopId, memberId: m.id, clubId: m.clubId, endpoint: user.shopId };
  const session = await createSubscriptionCheckout(key, {
    customer,
    name: `${m.club.name} (monthly)`,
    monthlyCents: m.club.monthlyCents,
    successUrl: `${base}/shop/o/club-thanks`,
    cancelUrl: `${base}/shop/o/club-thanks?cancelled=1`,
    reference: m.id,
    metadata: meta,
    anchor: m.club.billDay ? nextAnchor(m.club.billDay, now) : null,
    idempotencyKey: `club-sub-${m.id}-${now.getTime()}`,
  });
  if (!session.url) throw new UserError("Stripe didn't give a payment page. Try again in a minute.");
  return session.url;
}

/** Pauses a member: card billing is paused at Stripe first (nothing is charged while paused); they leave the pick list. */
export async function pauseMemberFor(user: CurrentUser, memberId: string): Promise<string> {
  const m = await memberOf(user.shopId, memberId);
  if (m.status !== "ACTIVE") throw new UserError(`${m.customer.name} isn't active.`);
  if (m.stripeSubscriptionId) await setSubscriptionPaused(await stripeKeyOf(user.shopId), m.stripeSubscriptionId, true, `club-pause-${m.id}-${Date.now()}`);
  const r = await db.clubMember.updateMany({ where: { id: m.id, shopId: user.shopId, status: "ACTIVE" }, data: { status: "PAUSED", pausedAt: new Date() } });
  if (r.count !== 1) throw new UserError("The member changed while you were looking. Reload and try again.");
  return `${m.customer.name} is paused${m.stripeSubscriptionId ? ": no card charges until you resume" : ""}.`;
}

export async function resumeMemberFor(user: CurrentUser, memberId: string): Promise<string> {
  const m = await memberOf(user.shopId, memberId);
  if (m.status !== "PAUSED") throw new UserError(`${m.customer.name} isn't paused.`);
  if (m.stripeSubscriptionId) await setSubscriptionPaused(await stripeKeyOf(user.shopId), m.stripeSubscriptionId, false, `club-resume-${m.id}-${Date.now()}`);
  const r = await db.clubMember.updateMany({ where: { id: m.id, shopId: user.shopId, status: "PAUSED" }, data: { status: "ACTIVE", pausedAt: null } });
  if (r.count !== 1) throw new UserError("The member changed while you were looking. Reload and try again.");
  return `${m.customer.name} is active again.`;
}

/** Cancels a member: the card subscription is cancelled at Stripe first; their unfinished pick-list rows go. */
export async function cancelMemberFor(user: CurrentUser, memberId: string): Promise<string> {
  const m = await memberOf(user.shopId, memberId);
  if (m.status === "CANCELLED") throw new UserError(`${m.customer.name} is already cancelled.`);
  if (m.stripeSubscriptionId) await cancelSubscription(await stripeKeyOf(user.shopId), m.stripeSubscriptionId);
  await db.$transaction([
    db.clubMember.updateMany({ where: { id: m.id, shopId: user.shopId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED", cancelledAt: new Date(), payFailedAt: null } }),
    db.clubPick.deleteMany({ where: { shopId: user.shopId, memberId: m.id, doneAt: null } }),
  ]);
  return `${m.customer.name} is cancelled${m.stripeSubscriptionId ? " and their card subscription is stopped" : ""}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// The monthly pick list
// ---------------------------------------------------------------------------------------------------------------

export type PickRow = {
  memberId: string;
  name: string;
  phone: string | null;
  address: string | null;
  fulfil: ClubFulfil;
  billing: ClubBilling;
  /** Paid for this month: the card paid (or later), or marked by hand. */
  paid: boolean;
  failed: boolean;
  awaitingCard: boolean;
  doneAt: Date | null;
  doneFulfil: ClubFulfil | null;
  tracking: string | null;
  note: string | null;
};
export type PickList = {
  club: { id: string; name: string; kind: ClubKind; monthlyCents: number; seriesId: string | null };
  month: string;
  what: { text: string; kitId: string | null } | null;
  rows: PickRow[];
  summary: { total: number; done: number; ship: number; pickup: number; unpaid: number; failed: number };
  kits: { id: string; name: string; seriesMonth: number | null }[];
};

/** This month's list: every active member (a member who got theirs and then paused or cancelled stays on it), undone first. Reads only. */
export async function pickListFor(shopId: string, clubId: string, month: string): Promise<PickList | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(clubId) || !isMonth(month)) return null;
  const club = await db.club.findFirst({ where: { id: clubId, shopId } });
  if (!club) return null;
  const [members, picks, what, kits] = await Promise.all([
    db.clubMember.findMany({ where: { shopId, clubId }, include: { customer: { select: { name: true, phone: true, address: true } } } }),
    db.clubPick.findMany({ where: { shopId, clubId, month } }),
    db.clubMonth.findFirst({ where: { shopId, clubId, month } }),
    club.seriesId ? db.kit.findMany({ where: { shopId, seriesId: club.seriesId }, orderBy: [{ seriesMonth: "asc" }, { name: "asc" }], select: { id: true, name: true, seriesMonth: true } }) : Promise.resolve([]),
  ]);
  const pick = new Map(picks.map((p) => [p.memberId, p]));
  const rows: PickRow[] = [];
  for (const m of members) {
    const p = pick.get(m.id);
    if (m.status !== "ACTIVE" && !p?.doneAt) continue;
    rows.push({
      memberId: m.id,
      name: m.customer.name,
      phone: m.customer.phone,
      address: m.customer.address,
      fulfil: p?.doneFulfil ?? m.fulfil,
      billing: m.billing,
      paid: !!m.paidMonth && m.paidMonth >= month,
      failed: !!m.payFailedAt && m.status !== "CANCELLED",
      awaitingCard: m.billing === "STRIPE" && !m.stripeSubscriptionId,
      doneAt: p?.doneAt ?? null,
      doneFulfil: p?.doneFulfil ?? null,
      tracking: p?.tracking ?? null,
      note: m.note,
    });
  }
  rows.sort((a, b) => Number(!!a.doneAt) - Number(!!b.doneAt) || a.name.localeCompare(b.name));
  const live = rows.filter((r) => !r.doneAt);
  return {
    club: { id: club.id, name: club.name, kind: club.kind, monthlyCents: club.monthlyCents, seriesId: club.seriesId },
    month,
    what: what ? { text: what.what, kitId: what.kitId } : null,
    rows,
    summary: { total: rows.length, done: rows.length - live.length, ship: live.filter((r) => r.fulfil === "SHIP").length, pickup: live.filter((r) => r.fulfil === "PICKUP").length, unpaid: rows.filter((r) => !r.paid).length, failed: rows.filter((r) => r.failed).length },
    kits,
  };
}

/** What the club gives in a month (a few words, and optionally the kit that is). */
export async function setMonthFor(user: CurrentUser, clubId: string, month: string, fd: FormData): Promise<string> {
  assertId(clubId);
  if (!isMonth(month)) throw new UserError("Pick the month.");
  const club = await db.club.findFirst({ where: { id: clubId, shopId: user.shopId } });
  if (!club) throw new UserError("Club not found.");
  let what = str(fd.get("what"));
  const kitId = str(fd.get("kitId"));
  let kit: { id: string; name: string } | null = null;
  if (kitId) {
    assertId(kitId);
    kit = await db.kit.findFirst({ where: { id: kitId, shopId: user.shopId }, select: { id: true, name: true } });
    if (!kit) throw new UserError("Kit not found.");
    what = what ?? kit.name;
  }
  if (!what) {
    await db.clubMonth.deleteMany({ where: { shopId: user.shopId, clubId: club.id, month } });
    return `Cleared ${monthLabel(month)}.`;
  }
  if (what.length > 200) throw new UserError("What goes out: 200 characters at most.");
  await db.clubMonth.upsert({
    where: { clubId_month: { clubId: club.id, month } },
    create: { shopId: user.shopId, clubId: club.id, month, what, kitId: kit?.id ?? null },
    update: { what, kitId: kit?.id ?? null },
  });
  return `${monthLabel(month)}: ${what}.`;
}

async function activeMember(shopId: string, clubId: string, memberId: string) {
  assertId(clubId);
  assertId(memberId);
  const m = await db.clubMember.findFirst({ where: { id: memberId, clubId, shopId }, include: { customer: { select: { name: true } } } });
  if (!m) throw new UserError("Member not found.");
  return m;
}

/** Marks a member's share handed over or shipped (tracking for a shipment). Their payment, if not in, is said in the answer. */
export async function markPickDoneFor(user: CurrentUser, clubId: string, memberId: string, month: string, fd: FormData | null): Promise<string> {
  if (!isMonth(month)) throw new UserError("Pick the month.");
  const m = await activeMember(user.shopId, clubId, memberId);
  if (m.status !== "ACTIVE") throw new UserError(`${m.customer.name} isn't active.`);
  const tracking = m.fulfil === "SHIP" ? (str(fd?.get("tracking") ?? null)?.slice(0, 100) ?? null) : null;
  const done = { doneAt: new Date(), doneFulfil: m.fulfil, tracking };
  const prior = await db.clubPick.findUnique({ where: { memberId_month: { memberId: m.id, month } } });
  if (prior?.doneAt) throw new UserError(`${m.customer.name}'s ${monthLabel(month)} share is already marked done.`);
  await db.clubPick.upsert({
    where: { memberId_month: { memberId: m.id, month } },
    create: { shopId: user.shopId, clubId, memberId: m.id, month, ...done },
    update: done,
  });
  const owes = !(m.paidMonth && m.paidMonth >= month);
  return `${m.customer.name}: ${monthLabel(month)} ${m.fulfil === "SHIP" ? "shipped" : "picked up"}.${m.payFailedAt ? " Their card payment failed: ask for a new card." : owes ? (m.billing === "PAY_AT_PICKUP" ? " They haven't paid this month yet." : " Their card payment for this month isn't in yet.") : ""}`;
}

/** Takes a "done" back (it was marked by mistake). */
export async function undoPickFor(user: CurrentUser, clubId: string, memberId: string, month: string): Promise<string> {
  if (!isMonth(month)) throw new UserError("Pick the month.");
  const m = await activeMember(user.shopId, clubId, memberId);
  const r = await db.clubPick.updateMany({ where: { shopId: user.shopId, memberId: m.id, month, doneAt: { not: null } }, data: { doneAt: null, doneFulfil: null, tracking: null } });
  if (r.count !== 1) throw new UserError("That share isn't marked done.");
  return `${m.customer.name}: ${monthLabel(month)} is back on the list.`;
}

/** Pay at pickup: marks the month paid by hand. A card member's payments come from Stripe, never from here. */
export async function markPaidFor(user: CurrentUser, clubId: string, memberId: string, month: string, fd: FormData | null = null): Promise<string> {
  if (!isMonth(month)) throw new UserError("Pick the month.");
  const m = await activeMember(user.shopId, clubId, memberId);
  if (m.billing !== "PAY_AT_PICKUP") throw new UserError(`${m.customer.name} pays by card: the payment is marked when Stripe reports it.`);
  if (m.status === "CANCELLED") throw new UserError(`${m.customer.name} is cancelled.`);
  if (m.paidMonth && m.paidMonth >= month) throw new UserError(`${m.customer.name} is already marked paid through ${monthLabel(m.paidMonth)}.`);
  const club = await db.club.findFirst({ where: { id: clubId, shopId: user.shopId }, select: { monthlyCents: true } });
  if (!club) throw new UserError("Club not found.");
  // The money goes in the register's books as a sale (tender as chosen, cash by default) unless this month's is already posted.
  const posted = await db.clubPayment.count({ where: { shopId: user.shopId, memberId: m.id, month, voidedAt: null } });
  const method = clubTenderOf(fd?.get("method") ?? null);
  if (!posted) await postClubPayment(user.shopId, { memberId: m.id, month, label: monthLabel(month), amountCents: club.monthlyCents, method, by: user });
  const r = await db.clubMember.updateMany({ where: { id: m.id, shopId: user.shopId, paidMonth: m.paidMonth }, data: { paidMonth: month, lastPaidAt: new Date(), payFailedAt: null } });
  if (r.count !== 1) throw new UserError("The member changed while you were looking. Reload and try again.");
  return `${m.customer.name}: ${monthLabel(month)} marked paid (${money(club.monthlyCents)} in the register).`;
}

/** Takes a hand-marked payment back (marked by mistake, or refunded at the counter): its sale is voided and the month is unpaid again. */
export async function takeBackPaidFor(user: CurrentUser, clubId: string, memberId: string, month: string): Promise<string> {
  if (!isMonth(month)) throw new UserError("Pick the month.");
  const m = await activeMember(user.shopId, clubId, memberId);
  if (m.billing !== "PAY_AT_PICKUP") throw new UserError(`${m.customer.name} pays by card: a refund is made in Stripe, and the payment is taken back when Stripe reports it.`);
  const p = await db.clubPayment.findFirst({ where: { shopId: user.shopId, memberId: m.id, month, voidedAt: null }, orderBy: { createdAt: "desc" } });
  if (p?.invoiceId) throw new UserError(`${monthLabel(month)} was paid by card through Stripe: refund it there and it is taken back here.`);
  if (!p && m.paidMonth !== month) throw new UserError(`${m.customer.name} isn't marked paid for ${monthLabel(month)}.`);
  if (p) await voidClubSale(user, user.shopId, p.saleId, "Club payment taken back");
  else await db.clubMember.updateMany({ where: { id: m.id, shopId: user.shopId, paidMonth: month }, data: { paidMonth: null, lastPaidAt: null } }); // marked before payments were booked
  return `${m.customer.name}: ${monthLabel(month)} is unpaid again${p ? " and its sale in the register is voided" : ""}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Stripe's webhook
// ---------------------------------------------------------------------------------------------------------------

type Out = { status: number; body: string };

/**
 * A club event on the shop's own webhook endpoint (the signature is already checked by the caller): the checkout that
 * made the subscription, an invoice paid or failed, a subscription paused in Stripe or cancelled. Only this shop's
 * members are looked up, so one shop's secret can't touch another's. Null when the event isn't a club one.
 */
export async function handleClubEvent(shopId: string, ev: WebhookEvent, now = new Date()): Promise<Out | null> {
  const obj = ev.data.object;
  const str1 = (v: unknown) => (typeof v === "string" && v ? v : null);
  const shop = async () => (await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } })).timeZone;
  const bySub = (sub: string | null, customer: string | null) =>
    sub || customer
      ? db.clubMember.findFirst({ where: { shopId, OR: [...(sub ? [{ stripeSubscriptionId: sub }] : []), ...(customer ? [{ stripeCustomerId: customer }] : [])] }, orderBy: { joinedAt: "desc" } })
      : Promise.resolve(null);
  const month = async (created: unknown) => {
    const t = typeof created === "number" && Number.isFinite(created) ? new Date(created * 1000) : now;
    return monthOf(t, await shop());
  };
  const later = (a: string | null, b: string) => (a && a > b ? a : b);

  if (ev.type === "checkout.session.completed" && obj.mode === "subscription") {
    const ref = str1(obj.client_reference_id);
    const m = ref && /^[a-z0-9]{10,40}$/i.test(ref) ? await db.clubMember.findFirst({ where: { id: ref, shopId } }) : null;
    if (!m) return { status: 200, body: "no member" };
    const paid = obj.payment_status === "paid" || obj.payment_status === "no_payment_required";
    const mo = await month(ev.created);
    const sub = str1(obj.subscription);
    // A link paid after the member was paused or cancelled, or a second link paid on top of a running subscription: the
    // new subscription is stopped at Stripe so it never charges again. Its first payment still goes in the books below
    // (the money was taken), for the shop to refund in Stripe; the refund then voids it here. The member's own subscription
    // (this event sent again) is never stopped here, paused or not.
    const stop = !!sub && sub !== m.stripeSubscriptionId && (m.status !== "ACTIVE" || !!m.stripeSubscriptionId);
    if (stop) await cancelSubscription(await stripeKeyOf(shopId), sub!);
    else
      await db.clubMember.update({
        where: { id: m.id },
        data: { stripeSubscriptionId: sub ?? m.stripeSubscriptionId, stripeCustomerId: str1(obj.customer) ?? m.stripeCustomerId, ...(paid ? { paidMonth: later(m.paidMonth, mo), lastPaidAt: now, payFailedAt: null } : {}) },
      });
    // The first month's money goes in the books under the invoice that took it (the later invoice.paid for it posts nothing twice).
    const invoice = str1(obj.invoice);
    if (paid && invoice) {
      const tax = (obj.total_details as { amount_tax?: unknown } | undefined)?.amount_tax;
      await postClubPayment(shopId, { memberId: m.id, month: mo, label: monthLabel(mo), amountCents: Number(obj.amount_total) || 0, method: "CARD", invoiceId: invoice, paymentIntent: str1(obj.payment_intent), taxCents: typeof tax === "number" ? tax : null });
    }
    return { status: 200, body: stop ? "stopped" : "ok" };
  }
  if (ev.type === "invoice.paid" || ev.type === "invoice.payment_succeeded" || ev.type === "invoice.payment_failed") {
    if (obj.object !== "invoice") return { status: 200, body: "ignored" };
    const m = await bySub(str1(obj.subscription), str1(obj.customer));
    if (!m) return { status: 200, body: "no member" };
    if (ev.type === "invoice.payment_failed") {
      await db.clubMember.update({ where: { id: m.id }, data: { payFailedAt: m.payFailedAt ?? now } });
    } else {
      const mo = await month(obj.created);
      await db.clubMember.update({ where: { id: m.id }, data: { paidMonth: later(m.paidMonth, mo), lastPaidAt: now, payFailedAt: null } });
      // The money goes in the register's books as a card sale, once per invoice (Stripe sends this event more than once).
      await postClubPayment(shopId, { memberId: m.id, month: mo, label: monthLabel(mo), amountCents: Number(obj.amount_paid) || 0, method: "CARD", invoiceId: str1(obj.id), paymentIntent: str1(obj.payment_intent), taxCents: typeof obj.tax === "number" ? obj.tax : null });
    }
    return { status: 200, body: "ok" };
  }
  if (ev.type === "charge.refunded") {
    if (obj.object !== "charge") return { status: 200, body: "ignored" };
    // A full refund voids the sale (the money went back); a part of it is for the shop to sort out at the register with a return.
    const full = obj.refunded === true || (typeof obj.amount === "number" && typeof obj.amount_refunded === "number" && obj.amount > 0 && obj.amount_refunded >= obj.amount);
    const ref = { paymentIntent: str1(obj.payment_intent), invoiceId: str1(obj.invoice) };
    if (!full) {
      const part = ref.paymentIntent || ref.invoiceId ? await db.clubPayment.count({ where: { shopId, voidedAt: null, OR: [...(ref.paymentIntent ? [{ paymentIntent: ref.paymentIntent }] : []), ...(ref.invoiceId ? [{ invoiceId: ref.invoiceId }] : [])] } }) : 0;
      return part ? { status: 200, body: "partial refund" } : null;
    }
    return (await voidClubPaymentsFor(shopId, ref, "Refunded in Stripe")) ? { status: 200, body: "ok" } : null;
  }
  if (ev.type === "customer.subscription.deleted" || ev.type === "customer.subscription.updated") {
    if (obj.object !== "subscription") return { status: 200, body: "ignored" };
    const m = await bySub(str1(obj.id), null);
    if (!m) return { status: 200, body: "no member" };
    if (ev.type === "customer.subscription.deleted") {
      if (m.status !== "CANCELLED") {
        await db.$transaction([
          db.clubMember.updateMany({ where: { id: m.id, shopId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED", cancelledAt: now, payFailedAt: null } }),
          db.clubPick.deleteMany({ where: { shopId, memberId: m.id, doneAt: null } }),
        ]);
      }
    } else if (obj.pause_collection && m.status === "ACTIVE") {
      await db.clubMember.updateMany({ where: { id: m.id, shopId, status: "ACTIVE" }, data: { status: "PAUSED", pausedAt: now } });
    } else if (!obj.pause_collection && m.status === "PAUSED") {
      await db.clubMember.updateMany({ where: { id: m.id, shopId, status: "PAUSED" }, data: { status: "ACTIVE", pausedAt: null } });
    }
    return { status: 200, body: "ok" };
  }
  return null;
}


// ---------------------------------------------------------------------------------------------------------------
// A customer leaving (deleting or merging a customer record)
// ---------------------------------------------------------------------------------------------------------------

/** The customer's club memberships that still bill a card: what deleting them would leave running at Stripe. */
export function cardMembershipsOf(shopId: string, customerId: string) {
  return db.clubMember.findMany({ where: { shopId, customerId, status: { not: "CANCELLED" }, stripeSubscriptionId: { not: null } }, select: { id: true, stripeSubscriptionId: true, club: { select: { name: true } } } });
}

/**
 * Deleting a customer: their card subscriptions are cancelled at Stripe first (a deleted member would otherwise keep being
 * charged with nobody to say who it is), then marked cancelled here. If Stripe can't be reached, nothing is deleted.
 */
export async function cancelCardMembershipsFor(shopId: string, customerId: string): Promise<void> {
  const subs = await cardMembershipsOf(shopId, customerId);
  if (!subs.length) return;
  let key: string;
  try {
    key = await stripeKeyOf(shopId);
  } catch {
    throw new UserError(`This customer pays for ${subs[0].club.name} by card, and the shop's Stripe key isn't set, so the subscription can't be stopped from here. Cancel it in your Stripe dashboard, cancel the member on the club's page, then delete the customer.`);
  }
  for (const s of subs) {
    try {
      await cancelSubscription(key, s.stripeSubscriptionId!);
    } catch (e) {
      throw new UserError(`The card subscription for ${s.club.name} couldn't be stopped, so the customer wasn't deleted. ${e instanceof UserError ? e.message : "Try again, or cancel it in your Stripe dashboard first."}`);
    }
    await db.clubMember.updateMany({ where: { id: s.id, shopId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED", cancelledAt: new Date(), payFailedAt: null } });
    await db.clubPick.deleteMany({ where: { shopId, memberId: s.id, doneAt: null } });
  }
}
