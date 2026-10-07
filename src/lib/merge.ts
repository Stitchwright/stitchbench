import "server-only";
// Merging and deleting customers and machines (round 3 L126, batch F; docs/legal/privacy-policy-DRAFT.md sections 6.1,
// 6.3, 8 and 9). A merge moves every row that points at the duplicate to the record kept, in one transaction, fills the
// kept record's blanks from the duplicate, notes "Merged from <name> on <date>" on it (with the duplicate's other
// details), then deletes the duplicate. A delete is for a customer's request to remove their details, or a record made
// by mistake: refused while work is open; money records stay in the books without the person's details; the consent
// record and opt-outs stay, as the policy says the law expects. Owner or admin only, every query bound to the signed-in
// company. Bodies take the user so scripts/checks/customer-merge.check.ts can drive them; src/actions/merge.ts wraps them.
import type { Customer, Machine, Prisma, VacCare } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { CLOSING_STATUSES, OPEN_STATUSES } from "@/lib/constants";
import { cancelCardMembershipsFor, cardMembershipsOf } from "@/lib/clubs";
import { fmtDate, fmtDateTime, money, ticketNo } from "@/lib/format";
import { sameText } from "@/lib/input";
import { recordConsent } from "@/lib/messaging/consent";
import { fmtPhone, toE164 } from "@/lib/phone";
import { customerIdsByPhone } from "@/lib/phone-search";
import type { CurrentUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { ticketTotals } from "@/lib/ticket-math";

type Db = Prisma.TransactionClient | typeof db;

/**
 * A column that holds a customer's or a machine's id. `via: "sale"`: the table has no shopId of its own (SaleLine), its
 * sale's says whose it is. `one`: at most one row per machine (a unique column or the key), so a merge where both
 * machines have one needs a rule. `tag`: the column holds other kinds of ids too, and this SQL picks the machine's.
 */
export type Ref = { model: string; field: string; label: [string, string]; via?: "sale"; one?: boolean; tag?: string };

/** Every column that points at a customer (relations and plain ids). The check script compares it with the schema. */
export const CUSTOMER_REFS: readonly Ref[] = [
  { model: "Machine", field: "customerId", label: ["machine", "machines"] },
  { model: "Ticket", field: "customerId", label: ["ticket", "tickets"] },
  { model: "Ticket", field: "viaAccountId", label: ["ticket through this shop account", "tickets through this shop account"] },
  { model: "Sale", field: "customerId", label: ["register sale", "register sales"] },
  { model: "RepairJob", field: "customerId", label: ["partner repair", "partner repairs"] },
  { model: "OutMessage", field: "customerId", label: ["message", "messages"] },
  { model: "ConsentEvent", field: "customerId", label: ["consent record", "consent records"] },
  { model: "Enrollment", field: "customerId", label: ["class seat", "class seats"] },
  { model: "Appointment", field: "customerId", label: ["appointment", "appointments"] },
  { model: "BookingLink", field: "customerId", label: ["booking link", "booking links"] },
  { model: "WebOrder", field: "customerId", label: ["online order", "online orders"] },
  { model: "InboundText", field: "customerId", label: ["text reply", "text replies"] },
  { model: "EstimateLink", field: "customerId", label: ["estimate link", "estimate links"] },
  { model: "GiftCard", field: "customerId", label: ["gift card or store credit", "gift cards and store credit"] },
  { model: "PartnerLink", field: "accountId", label: ["partnership using this account", "partnerships using this account"] },
  { model: "KitSeriesMember", field: "customerId", label: ["Block of the Month sign-up", "Block of the Month sign-ups"] },
  { model: "ClubMember", field: "customerId", label: ["club membership", "club memberships"] },
  { model: "LongarmOrder", field: "customerId", label: ["quilting work order", "quilting work orders"] },
  { model: "Layaway", field: "customerId", label: ["layaway", "layaways"] },
  { model: "SoftwareLicense", field: "customerId", label: ["software licence", "software licences"] },
];

/** Customer ids inside a JSON list: a campaign's members (the ids picked when it was sent). Replaced in place, so a campaign being built keeps its place. */
export const CUSTOMER_LISTS = [{ model: "Campaign", field: "members" }] as const;

/** Every column that points at a machine. */
export const MACHINE_REFS: readonly Ref[] = [
  { model: "Ticket", field: "machineId", label: ["ticket", "tickets"] },
  { model: "MachinePhoto", field: "machineId", label: ["photo", "photos"] },
  { model: "RepairJob", field: "machineId", label: ["partner repair", "partner repairs"] },
  { model: "SaleLine", field: "machineId", via: "sale", label: ["sale line (supplies bought for it)", "sale lines (supplies bought for it)"] },
  { model: "StockUnit", field: "machineId", one: true, label: ["for-sale stock record", "for-sale stock records"] },
  { model: "VacCare", field: "machineId", one: true, label: ["bag reminder setting", "bag reminder settings"] },
  { model: "MachinePlan", field: "machineId", label: ["service plan", "service plans"] },
  { model: "OutMessage", field: "refId", tag: `"refType" = 'machine'`, label: ["message about it", "messages about it"] },
  { model: "AssistantCall", field: "machineId", label: ["Assistant call", "Assistant calls"] },
  { model: "SoftwareLicense", field: "machineId", label: ["software licence", "software licences"] },
];

/** What a deleted customer's kept rows say instead of their name. */
export const DELETED_NAME = "Deleted customer";

const IDENT = /^[A-Za-z][A-Za-z0-9]*$/;

function refWhere(r: Ref): string {
  if (!IDENT.test(r.model) || !IDENT.test(r.field)) throw new Error(`merge: odd name ${r.model}.${r.field}`);
  const shop = r.via === "sale" ? `"saleId" IN (SELECT id FROM "Sale" WHERE "shopId" = $2)` : `"shopId" = $2`;
  return `"${r.field}" = $1 AND ${shop}${r.tag ? ` AND ${r.tag}` : ""}`;
}

/** Rows of one reference that point at `id`, in this company. */
export async function refCount(tx: Db, r: Ref, id: string, shopId: string): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${r.model}" WHERE ${refWhere(r)}`, id, shopId);
  return rows[0]?.n ?? 0;
}

async function moveRef(tx: Db, r: Ref, from: string, to: string, shopId: string): Promise<number> {
  return tx.$executeRawUnsafe(`UPDATE "${r.model}" SET "${r.field}" = $3 WHERE ${refWhere(r)}`, from, shopId, to);
}

/** Campaigns of this company whose member list names `from`; `to` takes its place ("" when the customer is deleted). */
async function replaceInLists(tx: Db, shopId: string, from: string, to: string): Promise<number> {
  const rows = await tx.campaign.findMany({ where: { shopId, members: { array_contains: [from] } }, select: { id: true, members: true } });
  for (const r of rows) {
    const list = Array.isArray(r.members) ? r.members : [];
    await tx.campaign.update({ where: { id: r.id }, data: { members: list.map((m) => (m === from ? to : m)) as Prisma.InputJsonValue } });
  }
  return rows.length;
}

const say = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;
const blank = (v: string | null | undefined) => !v || !v.trim();
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function requireManager(user: CurrentUser) {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can merge or delete customers and machines.");
}

/** The name typed to confirm must be the record's (any case and spacing). */
function requireTyped(typed: string | null | undefined, word: string) {
  if (norm(typed) !== norm(word)) throw new UserError(`Type ${word.trim()} to confirm.`);
}

/** Locks the rows (in id order, so two merges can't deadlock) and says which of them are this company's. */
async function lockRows(tx: Db, table: "Customer" | "Machine", ids: string[], shopId: string): Promise<Set<string>> {
  const found = new Set<string>();
  for (const id of [...new Set(ids)].sort()) {
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${table}" WHERE id = $1 AND "shopId" = $2 FOR UPDATE`, id, shopId);
    if (rows.length) found.add(id);
  }
  return found;
}

const TX = { timeout: 60_000, maxWait: 15_000 };

export type PlanRow = { what: string; then: string };
/** What a merge or a delete would do, for the page to show before the typed confirmation. */
export type Plan = { id: string; name: string; into: { id: string; name: string } | null; rows: PlanRow[]; blockers: string[]; notes: string[]; confirm: string };

// ---------- customers ----------

const KIND_MISMATCH = "One is a shop account and the other a retail customer. Change one of them first (Details), then merge.";
const FIELD_WORDS = { phone: "phone", email: "email", address: "address", code: "code", routeDay: "route day" } as const;

/** Customers of the same kind that may be the same person: by the search typed, else the same name, email or phone. */
export async function customerMergeCandidates(user: CurrentUser, customerId: string, q: string | null) {
  requireManager(user);
  const shopId = user.shopId;
  const c = await db.customer.findFirst({ where: { id: customerId, shopId }, select: { id: true, kind: true, name: true, email: true, phone: true } });
  if (!c) return [];
  const t = (q ?? "").trim();
  const or: Prisma.CustomerWhereInput[] = [];
  if (t.length >= 2) {
    or.push({ name: { contains: t, mode: "insensitive" } }, { email: { contains: t, mode: "insensitive" } });
    const ids = await customerIdsByPhone(shopId, t);
    if (ids.length) or.push({ id: { in: ids } });
  } else {
    or.push({ name: sameText(c.name.trim()) });
    if (c.email) or.push({ email: sameText(c.email.trim()) });
    const digits = (c.phone ?? "").replace(/\D/g, "").slice(-10);
    if (digits.length >= 7) {
      const ids = await customerIdsByPhone(shopId, digits);
      if (ids.length) or.push({ id: { in: ids } });
    }
  }
  return db.customer.findMany({
    where: { shopId, kind: c.kind, id: { not: c.id }, OR: or },
    select: { id: true, name: true, phone: true, email: true, _count: { select: { tickets: true, machines: true } } },
    orderBy: { name: "asc" },
    take: 20,
  });
}

/** What merging `fromId` into `intoId` would move. Throws "not found" for another company's id. */
export async function customerMergePlan(user: CurrentUser, fromId: string, intoId: string): Promise<Plan> {
  requireManager(user);
  const shopId = user.shopId;
  if (fromId === intoId) throw new UserError("Pick another customer: a record can't be merged into itself.");
  const [from, into] = await Promise.all([db.customer.findFirst({ where: { id: fromId, shopId } }), db.customer.findFirst({ where: { id: intoId, shopId } })]);
  if (!from || !into) throw new UserError("Customer not found.");
  if (from.kind !== into.kind) throw new UserError(KIND_MISMATCH);
  const rows: PlanRow[] = [];
  for (const r of CUSTOMER_REFS) {
    const n = await refCount(db, r, from.id, shopId);
    if (!n) continue;
    const then = r.model === "ConsentEvent" ? `move to ${into.name}, their dates, addresses and words unchanged` : `move to ${into.name}`;
    rows.push({ what: say(n, r.label), then });
  }
  const lists = await db.campaign.count({ where: { shopId, members: { array_contains: [from.id] } } });
  if (lists) rows.push({ what: say(lists, ["campaign list", "campaign lists"]), then: `name ${into.name} instead` });
  const tz = await shopTimeZone(shopId);
  const fill = customerFill(from, into, fmtDate(new Date(), tz));
  const notes: string[] = [];
  const filled = (["phone", "email", "address", "code", "routeDay"] as const).filter((f) => f in fill.data).map((f) => FIELD_WORDS[f]);
  notes.push(
    `${into.name} keeps its own details${filled.length ? `; its empty ${filled.join(", ")} ${filled.length === 1 ? "is" : "are"} filled from ${from.name}` : ""}. A note on it says "${fill.line}"`,
  );
  if (from.smsConsentAt && !into.smsConsentAt) {
    notes.push(
      fill.consent
        ? `${from.name}'s agreement to marketing texts carries over: it is for the number ${into.name} will have.`
        : `${from.name}'s agreement to marketing texts was for ${fmtPhone(from.smsConsentPhone ?? "")}, not ${into.name}'s number, so it doesn't carry over (the record of it moves with the rest).`,
    );
  }
  const seats = await db.enrollment.findMany({
    where: { shopId, customerId: { in: [from.id, into.id] }, status: { in: ["ENROLLED", "WAITLIST"] } },
    select: { classId: true, customerId: true, shopClass: { select: { title: true } } },
  });
  const both = [...new Set(seats.filter((s) => s.customerId === from.id && seats.some((o) => o.customerId === into.id && o.classId === s.classId)).map((s) => s.shopClass.title))];
  if (both.length) notes.push(`Both have a seat in ${both.join(", ")}: the roster will show ${into.name} twice. Cancel one seat if it's the same person.`);
  return { id: from.id, name: from.name, into: { id: into.id, name: into.name }, rows, blockers: [], notes, confirm: from.name };
}

/** The kept customer's new fields: blanks filled from the duplicate, the duplicate's other details in the merge note. Pure. */
export function customerFill(from: Customer, into: Customer, date: string): { data: Prisma.CustomerUpdateInput; line: string; consent: boolean } {
  const data: Prisma.CustomerUpdateInput = {};
  const after: Record<string, string | null> = {};
  for (const f of ["phone", "email", "address", "code", "routeDay"] as const) {
    if (blank(into[f]) && !blank(from[f])) data[f] = from[f];
    after[f] = blank(into[f]) ? from[f] : into[f];
  }
  if (into.commissionPct == null && from.commissionPct != null) data.commissionPct = from.commissionPct;
  if (into.notifyBy === "" && from.notifyBy !== "") data.notifyBy = from.notifyBy;
  if (from.lastReviewAskAt && (!into.lastReviewAskAt || from.lastReviewAskAt > into.lastReviewAskAt)) data.lastReviewAskAt = from.lastReviewAskAt;
  // Marketing-text consent is for one number: it carries over only when it is the number the kept record will have.
  const consent = !into.smsConsentAt && !!from.smsConsentAt && !!from.smsConsentPhone && toE164(after.phone) === from.smsConsentPhone;
  if (consent) Object.assign(data, { smsConsentAt: from.smsConsentAt, smsConsentPhone: from.smsConsentPhone, smsConsentSource: from.smsConsentSource, smsConsentText: from.smsConsentText });
  const other: string[] = [];
  for (const f of ["phone", "email", "address", "code", "routeDay"] as const) {
    if (!blank(from[f]) && norm(from[f]) !== norm(after[f])) other.push(`${FIELD_WORDS[f]} ${from[f]!.trim()}`);
  }
  let line = `Merged from ${from.name} on ${date}`;
  if (other.length) line += `: ${other.join(", ")}`;
  line += ".";
  if (!blank(from.notes)) line += ` Their notes: ${from.notes!.trim()}`;
  data.notes = [into.notes?.trim(), line].filter(Boolean).join("\n");
  return { data, line, consent };
}

/** Moves everything of `fromId` to `intoId`, fills blanks, notes the merge and deletes `fromId`. Returns the kept id. */
export async function mergeCustomersFor(user: CurrentUser, fromId: string, intoId: string | null, typed: string | null): Promise<string> {
  requireManager(user);
  const shopId = user.shopId;
  if (!intoId) throw new UserError("Pick the customer to keep.");
  if (fromId === intoId) throw new UserError("Pick another customer: a record can't be merged into itself.");
  const date = fmtDate(new Date(), await shopTimeZone(shopId));
  await db.$transaction(async (tx) => {
    const found = await lockRows(tx, "Customer", [fromId, intoId], shopId);
    if (found.size < 2) throw new UserError("Customer not found.");
    const from = await tx.customer.findUniqueOrThrow({ where: { id: fromId } });
    const into = await tx.customer.findUniqueOrThrow({ where: { id: intoId } });
    requireTyped(typed, from.name);
    if (from.kind !== into.kind) throw new UserError(KIND_MISMATCH);
    // A club or series both have: the kept record's membership stands and the duplicate's goes (a card subscription still
    // running on the one that goes would be left charging, so that is refused).
    const theirClubs = new Set((await tx.clubMember.findMany({ where: { shopId, customerId: into.id }, select: { clubId: true } })).map((x) => x.clubId));
    const clash = (await tx.clubMember.findMany({ where: { shopId, customerId: from.id }, select: { id: true, clubId: true, status: true, stripeSubscriptionId: true } })).filter((x) => theirClubs.has(x.clubId));
    if (clash.some((x) => x.status !== "CANCELLED" && x.stripeSubscriptionId)) {
      throw new UserError(`${from.name} still pays for a club by card, and ${into.name} is in that club too. Cancel ${from.name}'s membership on the club's page first (it stops the subscription), then merge.`);
    }
    if (clash.length) await tx.clubMember.deleteMany({ where: { shopId, id: { in: clash.map((x) => x.id) } } });
    const theirSeries = new Set((await tx.kitSeriesMember.findMany({ where: { shopId, customerId: into.id }, select: { seriesId: true } })).map((x) => x.seriesId));
    const seriesClash = (await tx.kitSeriesMember.findMany({ where: { shopId, customerId: from.id }, select: { id: true, seriesId: true } })).filter((x) => theirSeries.has(x.seriesId));
    if (seriesClash.length) await tx.kitSeriesMember.deleteMany({ where: { shopId, id: { in: seriesClash.map((x) => x.id) } } });
    for (const r of CUSTOMER_REFS) await moveRef(tx, r, from.id, into.id, shopId);
    await replaceInLists(tx, shopId, from.id, into.id);
    await tx.customer.update({ where: { id: into.id }, data: customerFill(from, into, date).data });
    await tx.customer.delete({ where: { id: from.id } });
  }, TX);
  return intoId;
}

const OPEN_ORDER = ["PENDING", "PAID", "READY"];
const ORDER_WORDS: Record<string, string> = { PENDING: "not paid yet", PAID: "paid, not packed", READY: "ready for pickup" };

/** Why this customer can't be deleted yet: open work, money owed, a shop account the books need. Empty when it can. */
async function customerBlockers(tx: Db, shopId: string, c: { id: string; kind: string }, now: Date, tz: string): Promise<string[]> {
  const out: string[] = [];
  const tickets = await tx.ticket.findMany({
    where: { shopId, customerId: c.id },
    select: {
      number: true,
      status: true,
      taxRatePct: true,
      lines: { select: { kind: true, qty: true, unitPriceCents: true, taxable: true } },
      payments: { select: { amountCents: true, method: true } },
    },
    orderBy: { number: "asc" },
  });
  for (const t of tickets) {
    if (OPEN_STATUSES.includes(t.status)) out.push(`Ticket #${ticketNo(t.number)} is still open.`);
    // An abandoned machine was kept against the bill, so what's left on it isn't chased.
    else if (t.status !== "ABANDONED") {
      const owed = ticketTotals(t.lines, t.payments, t.taxRatePct).balance;
      if (owed > 0) out.push(`Ticket #${ticketNo(t.number)} has ${money(owed)} owed.`);
    }
  }
  const via = await tx.ticket.count({ where: { shopId, viaAccountId: c.id } });
  if (via) out.push(`${say(via, ["ticket came", "tickets came"])} in through this shop account, and its commission is in the books. Merge it into another shop account instead.`);
  for (const l of await tx.partnerLink.findMany({ where: { shopId, accountId: c.id, status: "ACTIVE" }, select: { partnerName: true } })) {
    out.push(`It is the account of your partnership with ${l.partnerName}.`);
  }
  for (const j of await tx.repairJob.findMany({ where: { shopId, customerId: c.id, pickedUpAt: null, status: { notIn: CLOSING_STATUSES } }, select: { tag: true } })) {
    out.push(`Partner repair tag ${j.tag} isn't picked up yet.`);
  }
  for (const o of await tx.webOrder.findMany({ where: { shopId, customerId: c.id, status: { in: OPEN_ORDER } }, select: { number: true, status: true }, orderBy: { number: "asc" } })) {
    out.push(`Online order #${o.number} isn't finished (${ORDER_WORDS[o.status] ?? o.status.toLowerCase()}). Finish or cancel it first.`);
  }
  for (const g of await tx.giftCard.findMany({ where: { shopId, customerId: c.id, status: "active", balanceCents: { gt: 0 } }, select: { kind: true, balanceCents: true } })) {
    out.push(`${g.kind === "credit" ? "Store credit" : "A gift card"} of ${money(g.balanceCents)} is still owed. Pay it out or let them spend it first.`);
  }
  for (const l of await tx.layaway.findMany({ where: { shopId, customerId: c.id, status: "OPEN" }, select: { number: true }, orderBy: { number: "asc" } })) {
    out.push(`Layaway #${l.number} is still being paid for. Finish or cancel it first.`);
  }
  for (const a of await tx.appointment.findMany({
    where: { shopId, customerId: c.id, status: "BOOKED", endsAt: { gt: now } },
    select: { title: true, startsAt: true },
    orderBy: { startsAt: "asc" },
  })) {
    out.push(`Their ${a.title || "appointment"} on ${fmtDateTime(a.startsAt, tz)} is still booked. Cancel it first.`);
  }
  for (const q of await tx.longarmOrder.findMany({ where: { shopId, customerId: c.id, status: { in: ["RECEIVED", "ON_FRAME", "READY"] } }, select: { number: true }, orderBy: { number: "asc" } })) {
    out.push(`Quilting work order #${q.number} isn't collected yet. Finish or cancel it first.`);
  }
  const seats = await tx.enrollment.findMany({
    where: { shopId, customerId: c.id, status: { in: ["ENROLLED", "WAITLIST"] }, shopClass: { status: { not: "CANCELLED" }, meetings: { some: { cancelled: false, endsAt: { gt: now } } } } },
    select: { shopClass: { select: { title: true } } },
  });
  for (const s of seats) out.push(`They have a seat in ${s.shopClass.title}, which hasn't finished. Cancel the seat first.`);
  return out;
}

/** The customer's machines nothing else needs: no tickets, partner repairs, stock record or sale lines. Deleted with the customer. */
async function bareMachines(tx: Db, shopId: string, customerId: string): Promise<string[]> {
  const ms = await tx.machine.findMany({ where: { shopId, customerId, tickets: { none: {} }, repairJobs: { none: {} }, stock: { is: null } }, select: { id: true } });
  const ids = ms.map((m) => m.id);
  if (!ids.length) return [];
  const sold = await tx.saleLine.findMany({ where: { machineId: { in: ids }, sale: { shopId } }, select: { machineId: true }, distinct: ["machineId"] });
  const used = new Set(sold.map((s) => s.machineId));
  return ids.filter((id) => !used.has(id));
}

/** What deleting this customer would do, and what stops it now. */
export async function customerDeletePlan(user: CurrentUser, customerId: string): Promise<Plan> {
  requireManager(user);
  const shopId = user.shopId;
  const c = await db.customer.findFirst({ where: { id: customerId, shopId } });
  if (!c) throw new UserError("Customer not found.");
  const tz = await shopTimeZone(shopId);
  const blockers = await customerBlockers(db, shopId, c, new Date(), tz);
  const n: Record<string, number> = {};
  for (const r of CUSTOMER_REFS) n[`${r.model}.${r.field}`] = await refCount(db, r, c.id, shopId);
  const rows: PlanRow[] = [];
  const add = (count: number, label: [string, string], then: string) => {
    if (count) rows.push({ what: say(count, label), then });
  };
  const bare = (await bareMachines(db, shopId, c.id)).length;
  add(bare, ["machine", "machines"], "deleted, with their photos (nothing else needs them)");
  add(n["Machine.customerId"] - bare, ["machine", "machines"], "kept without an owner (their tickets, sales or partner repairs need them)");
  add(
    n["Ticket.customerId"],
    ["ticket", "tickets"],
    "kept in the books with their lines, payments and photos, without the customer; on-site visits lose the contact name, phone and access notes (the address stays: the visit's sales tax depends on it)",
  );
  add(n["Sale.customerId"], ["register sale", "register sales"], "kept in the books, without the customer");
  add(n["RepairJob.customerId"], ["partner repair", "partner repairs"], "kept for the partner statements, without the link; they keep the first name and last initial the repair shop was given");
  const queued = await db.outMessage.count({ where: { shopId, customerId: c.id, status: "QUEUED" } });
  add(queued, ["queued message", "queued messages"], "cancelled");
  add(n["OutMessage.customerId"] - queued, ["message", "messages"], "kept as the record of what was sent (address and words), without the link");
  add(n["ConsentEvent.customerId"], ["consent record", "consent records"], "kept as they are (address, words and dates): the law expects them to stay");
  if (c.smsConsentAt) rows.push({ what: "Marketing texts", then: "their agreement ends: a consent record saying so is added" });
  const addresses = [toE164(c.phone), c.email?.trim().toLowerCase()].filter((a): a is string => !!a);
  const sup = addresses.length ? await db.suppression.count({ where: { shopId, address: { in: addresses } } }) : 0;
  add(sup, ["opt-out", "opt-outs"], "kept, so nothing goes to that address if it's entered again");
  add(n["Enrollment.customerId"], ["class seat", "class seats"], `kept on the rosters as "${DELETED_NAME}" (fees and refunds stay in the books)`);
  add(n["Appointment.customerId"], ["appointment", "appointments"], `kept on the calendar as "${DELETED_NAME}" (fees and refunds stay in the books)`);
  add(n["WebOrder.customerId"], ["online order", "online orders"], `kept in the books as "${DELETED_NAME}", without phone or email; a shipped order keeps its address (its sales tax depends on it)`);
  add(n["EstimateLink.customerId"], ["estimate link", "estimate links"], "kept as the record of their answer, switched off");
  add(n["BookingLink.customerId"], ["booking link", "booking links"], "deleted");
  add(n["InboundText.customerId"], ["text reply", "text replies"], "kept, without the link");
  add(n["GiftCard.customerId"], ["gift card or store credit record", "gift card and store credit records"], "kept with their ledger (nothing is owed on them), without the customer");
  add(n["PartnerLink.accountId"], ["ended partnership", "ended partnerships"], "no longer name this account");
  const lists = await db.campaign.count({ where: { shopId, members: { array_contains: [c.id] } } });
  add(lists, ["campaign list", "campaign lists"], "no longer name them");
  const clubsIn = await db.clubMember.count({ where: { shopId, customerId: c.id } });
  const cards = (await cardMembershipsOf(shopId, c.id)).length;
  add(clubsIn, ["club membership", "club memberships"], `deleted${cards ? `; ${cards === 1 ? "their card subscription is" : "their card subscriptions are"} stopped at Stripe first (if that fails, nothing is deleted)` : ""}; the club payments already in the register's books stay`);
  add(n["LongarmOrder.customerId"], ["quilting work order", "quilting work orders"], `kept in the books as "${DELETED_NAME}" (with their photos and the sale they were billed on)`);
  add(n["KitSeriesMember.customerId"], ["Block of the Month sign-up", "Block of the Month sign-ups"], "deleted");
  add(n["Layaway.customerId"], ["finished layaway", "finished layaways"], "kept in the books, without the customer");
  add(n["SoftwareLicense.customerId"], ["software licence", "software licences"], "kept with their sale, without the customer");
  const notes = ["Notes typed on kept tickets and machines aren't changed. If they name the customer, edit them first."];
  return { id: c.id, name: c.name, into: null, rows, blockers, notes, confirm: c.name };
}

/** Deletes the customer: refused while anything is open; keeps money records and the consent record without their details. */
export async function deleteCustomerFor(user: CurrentUser, customerId: string, typed: string | null): Promise<void> {
  requireManager(user);
  const shopId = user.shopId;
  const tz = await shopTimeZone(shopId);
  const now = new Date();
  // Their card subscriptions to a club are stopped at Stripe first (a deleted member would be charged with nobody to say
  // who it is); if that can't be done, nothing is deleted. Only after the same checks the delete itself makes.
  const pre = await db.customer.findFirst({ where: { id: customerId, shopId } });
  if (pre && (await cardMembershipsOf(shopId, customerId)).length) {
    requireTyped(typed, pre.name);
    const open = await customerBlockers(db, shopId, pre, now, tz);
    if (open.length) throw new UserError(`${pre.name} can't be deleted yet. ${open.slice(0, 3).join(" ")}${open.length > 3 ? ` (and ${open.length - 3} more)` : ""}`);
    await cancelCardMembershipsFor(shopId, customerId);
  }
  await db.$transaction(async (tx) => {
    const found = await lockRows(tx, "Customer", [customerId], shopId);
    if (!found.size) throw new UserError("Customer not found.");
    const c = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
    requireTyped(typed, c.name);
    const blockers = await customerBlockers(tx, shopId, c, now, tz);
    if (blockers.length) throw new UserError(`${c.name} can't be deleted yet. ${blockers.slice(0, 3).join(" ")}${blockers.length > 3 ? ` (and ${blockers.length - 3} more)` : ""}`);
    // Their agreement to marketing texts ends with the record; the consent record says so (it, and every earlier
    // event, stays: the database only clears the link to the deleted record).
    if (c.smsConsentAt) {
      await recordConsent(tx, { shopId, customerId: c.id, channel: "sms", address: c.smsConsentPhone, event: "marketing_no", source: "staff", detail: "Customer record deleted", byUserId: user.id });
    }
    await tx.outMessage.updateMany({ where: { shopId, customerId: c.id, status: "QUEUED" }, data: { status: "CANCELLED", error: "Customer deleted", cancelledById: user.id } });
    await tx.ticketSite.updateMany({ where: { shopId, ticket: { customerId: c.id } }, data: { contactName: null, contactPhone: null, accessNotes: null } });
    await tx.webOrder.updateMany({ where: { shopId, customerId: c.id, fulfil: { not: "ship" } }, data: { address: null } });
    await tx.webOrder.updateMany({ where: { shopId, customerId: c.id }, data: { customerId: null, name: DELETED_NAME, phone: null, email: null, notify: "", note: null, linkSealed: null } });
    await tx.enrollment.updateMany({ where: { shopId, customerId: c.id }, data: { name: DELETED_NAME, attendee: null, note: null } });
    await tx.appointment.updateMany({ where: { shopId, customerId: c.id }, data: { name: DELETED_NAME, note: null } });
    await tx.longarmOrder.updateMany({ where: { shopId, customerId: c.id }, data: { name: DELETED_NAME, note: null } });
    await tx.estimateLink.updateMany({ where: { shopId, customerId: c.id, revokedAt: null }, data: { revokedAt: now } });
    await tx.estimateLink.updateMany({ where: { shopId, customerId: c.id }, data: { customerId: null, tokenSealed: null } });
    await tx.bookingLink.deleteMany({ where: { shopId, customerId: c.id } });
    await tx.inboundText.updateMany({ where: { shopId, customerId: c.id }, data: { customerId: null } });
    await tx.partnerLink.updateMany({ where: { shopId, accountId: c.id }, data: { accountId: null } }); // only ended ones: an active one refused above
    await replaceInLists(tx, shopId, c.id, "");
    const bare = await bareMachines(tx, shopId, c.id);
    if (bare.length) await tx.machine.deleteMany({ where: { shopId, id: { in: bare } } });
    // Machines, tickets, sales, partner repairs, messages, consent records, seats and appointments lose the link here
    // (onDelete: SetNull); their names were replaced above.
    await tx.customer.delete({ where: { id: c.id } });
  }, TX);
}

// ---------- machines ----------

/** "Janome MC6700P": what the confirmation asks for. */
export const machineName = (m: { brand: string; model: string }) => `${m.brand} ${m.model}`.replace(/\s+/g, " ").trim();
const withSerial = (m: { brand: string; model: string; serial: string | null }) => `${machineName(m)}${m.serial ? ` SN ${m.serial}` : ""}`;

/** Machines of the same kind of equipment that may be the same one: by the search typed, else the same model, owner or serial. */
export async function machineMergeCandidates(user: CurrentUser, machineId: string, q: string | null) {
  requireManager(user);
  const shopId = user.shopId;
  const m = await db.machine.findFirst({ where: { id: machineId, shopId }, select: { id: true, brand: true, modelKey: true, serial: true, customerId: true, equipment: true } });
  if (!m) return [];
  const t = (q ?? "").trim();
  const or: Prisma.MachineWhereInput[] = [];
  if (t.length >= 2) {
    const has = { contains: t, mode: "insensitive" as const };
    or.push({ serial: has }, { brand: has }, { model: has }, { customer: { name: has } });
  } else {
    or.push({ brand: sameText(m.brand), modelKey: m.modelKey });
    if (m.customerId) or.push({ customerId: m.customerId });
    if (m.serial) or.push({ serial: sameText(m.serial) });
  }
  return db.machine.findMany({
    where: { shopId, equipment: m.equipment, id: { not: m.id }, OR: or },
    select: { id: true, brand: true, model: true, serial: true, customer: { select: { name: true } }, _count: { select: { tickets: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

type MachineRow = Machine & { stock: { id: string } | null; vacCare: VacCare | null; customer: { name: string } | null };
const MACHINE_INCLUDE = { stock: { select: { id: true } }, vacCare: true, customer: { select: { name: true } } } as const;

/** Why two machines can't be merged (beyond not found): different equipment, or both are machines-for-sale stock. */
function machineMergeRefusal(from: MachineRow, into: MachineRow): string | null {
  if (from.equipment !== into.equipment) return "They aren't the same kind of thing (one is a vacuum or an appliance, the other isn't). Use 'It isn't ...' on the wrong one first.";
  if (from.stock && into.stock) return "Both are machines-for-sale stock records, which are kept for good. They can't be merged.";
  return null;
}

/** What merging machine `fromId` into `intoId` would move. */
export async function machineMergePlan(user: CurrentUser, fromId: string, intoId: string): Promise<Plan> {
  requireManager(user);
  const shopId = user.shopId;
  if (fromId === intoId) throw new UserError("Pick another machine: a record can't be merged into itself.");
  const [from, into] = await Promise.all([
    db.machine.findFirst({ where: { id: fromId, shopId }, include: MACHINE_INCLUDE }),
    db.machine.findFirst({ where: { id: intoId, shopId }, include: MACHINE_INCLUDE }),
  ]);
  if (!from || !into) throw new UserError("Machine not found.");
  const refusal = machineMergeRefusal(from, into);
  const rows: PlanRow[] = [];
  const intoName = withSerial(into);
  for (const r of MACHINE_REFS) {
    const n = await refCount(db, r, from.id, shopId);
    if (!n) continue;
    if (r.model === "VacCare" && into.vacCare) rows.push({ what: "Bag reminder settings", then: `combined with ${intoName}'s: the later contact and snooze are kept, and stopped if either was` });
    else rows.push({ what: say(n, r.label), then: `move to ${intoName}` });
  }
  const tz = await shopTimeZone(shopId);
  const fill = machineFill(from, into, fmtDate(new Date(), tz));
  const notes = [`${intoName} keeps its own details; empty ones are filled from ${withSerial(from)}. A note on it says "${fill.line}"`];
  if (from.customerId && into.customerId && from.customerId !== into.customerId) {
    notes.push(`It stays with ${into.customer?.name ?? "its owner"} (${withSerial(from)} was ${from.customer?.name ?? "someone else"}'s). Each ticket keeps its own customer.`);
  }
  const open = await db.ticket.count({ where: { shopId, machineId: { in: [from.id, into.id] }, status: { in: OPEN_STATUSES } } });
  if (open > 1) notes.push("Both have an open ticket: after the merge the machine has two open tickets. Close the one opened by mistake.");
  return { id: from.id, name: machineName(from), into: { id: into.id, name: intoName }, rows, blockers: refusal ? [refusal] : [], notes, confirm: machineName(from) };
}

/** The kept machine's new fields: blanks filled, the duplicate's answers under keys it lacks, the merge note. Pure. */
export function machineFill(from: Machine, into: Machine, date: string): { data: Prisma.MachineUncheckedUpdateInput; line: string } {
  const data: Prisma.MachineUncheckedUpdateInput = {};
  if (blank(into.serial) && !blank(from.serial)) data.serial = from.serial;
  if (blank(into.machineType) && !blank(from.machineType)) data.machineType = from.machineType;
  if (!into.customerId && from.customerId) data.customerId = from.customerId;
  const fromDetails = (from.details ?? {}) as Record<string, unknown>;
  const intoDetails = (into.details ?? {}) as Record<string, unknown>;
  if (Object.keys(fromDetails).some((k) => !(k in intoDetails))) data.details = { ...fromDetails, ...intoDetails } as Prisma.InputJsonValue;
  if (from.serviceNoticeFor && (!into.serviceNoticeFor || from.serviceNoticeFor > into.serviceNoticeFor)) data.serviceNoticeFor = from.serviceNoticeFor;
  let line = `Merged from ${withSerial(from)} on ${date}.`;
  if (!blank(from.notes)) line += ` Its notes: ${from.notes!.trim()}`;
  data.notes = [into.notes?.trim(), line].filter(Boolean).join("\n");
  return { data, line };
}

/** Both machines' bag reminder settings as one: the later contact (with who and what), the later snooze, stopped if either was. Pure. */
export function vacCombine(from: VacCare, into: VacCare): Prisma.VacCareUpdateInput {
  const later = from.contactedAt && (!into.contactedAt || from.contactedAt > into.contactedAt);
  return {
    ...(later ? { contactedAt: from.contactedAt, contactedBy: from.contactedBy, contactNote: from.contactNote } : {}),
    snoozedUntil: [from.snoozedUntil, into.snoozedUntil].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    stopped: from.stopped || into.stopped,
  };
}

export async function mergeMachinesFor(user: CurrentUser, fromId: string, intoId: string | null, typed: string | null): Promise<string> {
  requireManager(user);
  const shopId = user.shopId;
  if (!intoId) throw new UserError("Pick the machine to keep.");
  if (fromId === intoId) throw new UserError("Pick another machine: a record can't be merged into itself.");
  const date = fmtDate(new Date(), await shopTimeZone(shopId));
  await db.$transaction(async (tx) => {
    const found = await lockRows(tx, "Machine", [fromId, intoId], shopId);
    if (found.size < 2) throw new UserError("Machine not found.");
    const from = await tx.machine.findUniqueOrThrow({ where: { id: fromId }, include: MACHINE_INCLUDE });
    const into = await tx.machine.findUniqueOrThrow({ where: { id: intoId }, include: MACHINE_INCLUDE });
    requireTyped(typed, machineName(from));
    const refusal = machineMergeRefusal(from, into);
    if (refusal) throw new UserError(refusal);
    // One row per machine: both have bag reminder settings, so they become one; otherwise the row simply moves below.
    if (from.vacCare && into.vacCare) {
      await tx.vacCare.update({ where: { machineId: into.id }, data: vacCombine(from.vacCare, into.vacCare) });
      await tx.vacCare.delete({ where: { machineId: from.id } });
    }
    for (const r of MACHINE_REFS) await moveRef(tx, r, from.id, into.id, shopId);
    await tx.machine.update({ where: { id: into.id }, data: machineFill(from, into, date).data });
    await tx.machine.delete({ where: { id: from.id } });
  }, TX);
  return intoId;
}

/** Why this machine can't be deleted: tickets (its history and their bills), a machines-for-sale stock record, an open partner repair. */
async function machineBlockers(tx: Db, shopId: string, m: { id: string; stock: { id: string } | null }): Promise<string[]> {
  const out: string[] = [];
  const tickets = await tx.ticket.count({ where: { shopId, machineId: m.id } });
  if (tickets) out.push(`It has ${say(tickets, ["ticket", "tickets"])}: its service history and their bills stay. Merge it into the right machine instead.`);
  if (m.stock) out.push("It is a machine-for-sale stock record, and those are kept for good (take it off sale instead).");
  for (const j of await tx.repairJob.findMany({ where: { shopId, machineId: m.id, pickedUpAt: null, status: { notIn: CLOSING_STATUSES } }, select: { tag: true } })) {
    out.push(`Partner repair tag ${j.tag} isn't picked up yet.`);
  }
  return out;
}

export async function machineDeletePlan(user: CurrentUser, machineId: string): Promise<Plan> {
  requireManager(user);
  const shopId = user.shopId;
  const m = await db.machine.findFirst({ where: { id: machineId, shopId }, include: MACHINE_INCLUDE });
  if (!m) throw new UserError("Machine not found.");
  const blockers = await machineBlockers(db, shopId, m);
  const n: Record<string, number> = {};
  for (const r of MACHINE_REFS) n[`${r.model}.${r.field}`] = await refCount(db, r, m.id, shopId);
  const rows: PlanRow[] = [];
  const add = (count: number, label: [string, string], then: string) => {
    if (count) rows.push({ what: say(count, label), then });
  };
  add(n["MachinePhoto.machineId"], ["photo", "photos"], "deleted");
  add(n["VacCare.machineId"], ["bag reminder setting", "bag reminder settings"], "deleted");
  add(n["SaleLine.machineId"], ["sale line", "sale lines"], "kept in the books, no longer naming it");
  add(n["RepairJob.machineId"], ["partner repair", "partner repairs"], "kept, without the link (they keep the brand, model and serial)");
  const queued = await db.outMessage.count({ where: { shopId, refType: "machine", refId: m.id, status: "QUEUED" } });
  add(queued, ["queued message about it", "queued messages about it"], "cancelled");
  add(n["OutMessage.refId"] - queued, ["message about it", "messages about it"], "kept, without the link");
  return { id: m.id, name: withSerial(m), into: null, rows, blockers, notes: [], confirm: machineName(m) };
}

/** Deletes a machine entered by mistake: refused while it has tickets, a stock record or an open partner repair. */
export async function deleteMachineFor(user: CurrentUser, machineId: string, typed: string | null): Promise<void> {
  requireManager(user);
  const shopId = user.shopId;
  await db.$transaction(async (tx) => {
    const found = await lockRows(tx, "Machine", [machineId], shopId);
    if (!found.size) throw new UserError("Machine not found.");
    const m = await tx.machine.findUniqueOrThrow({ where: { id: machineId }, include: MACHINE_INCLUDE });
    requireTyped(typed, machineName(m));
    const blockers = await machineBlockers(tx, shopId, m);
    if (blockers.length) throw new UserError(`${withSerial(m)} can't be deleted. ${blockers.join(" ")}`);
    await tx.outMessage.updateMany({ where: { shopId, refType: "machine", refId: m.id, status: "QUEUED" }, data: { status: "CANCELLED", error: "Machine deleted", cancelledById: user.id } });
    await tx.outMessage.updateMany({ where: { shopId, refType: "machine", refId: m.id }, data: { refType: null, refId: null } });
    await tx.saleLine.updateMany({ where: { machineId: m.id, sale: { shopId } }, data: { machineId: null } });
    // Photos and bag reminder settings go with it (onDelete: Cascade); partner repairs lose the link (SetNull).
    await tx.machine.delete({ where: { id: m.id } });
  }, TX);
}
