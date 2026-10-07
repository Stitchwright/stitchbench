import "server-only";
// Software licences and activation codes (shop-features-round-2-design.md 2.5, package software-codes): an item of kind
// SOFTWARE is ONCE (perpetual) or a SUBSCRIPTION of so many months, with its no-returns words. Ringing it up makes a
// SoftwareLicense with the code scanned or typed, the next code on hand, or none yet (the "Codes to fill in" list); a
// subscription's renewal is ringing it up again for her, which carries the licence on. A return of an activated licence
// is refused at the register; an owner or admin can still take it back with a reason (audited). Codes are the shop's
// record of the sale: masked in lists, never sent to the hub or the Assistant. Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { fmtDate, str } from "@/lib/format";
import { actorOf, audit } from "@/lib/audit";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf, zonedTime } from "@/lib/zoned";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient;

export const NO_RETURN_DEFAULT = "Software can't be returned once it has been activated.";
export const MAX_CODES_AT_ONCE = 500;
const MAX_CODE = 80;

/** "…7F3K": the last four, for lists. */
export const maskCode = (code: string | null | undefined) => (code ? `…${code.slice(-4)}` : "");

/** A date `months` after a shop day, as a shop day ("2026-01-31" + 1 -> "2026-02-28"). */
export function addMonthsYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

const noon = (ymd: string, tz: string) => zonedTime(ymd, 12 * 60, tz);

// ---------------------------------------------------------------------------------------------------------------
// The item: once or a subscription, its words, codes on hand
// ---------------------------------------------------------------------------------------------------------------

async function ownSoftware(shopId: string, partId: string) {
  const p = await db.part.findFirst({ where: { id: assertId(partId), shopId }, select: { id: true, partNumber: true, kind: true } });
  if (!p) throw new UserError("Item not found.");
  if (p.kind !== "SOFTWARE") throw new UserError(`${p.partNumber} isn't software: change "What is it?" to Software first.`);
  return p;
}

/** Saves a software item's licence: once or a subscription (1 to 120 months), and its no-returns words (blank: the default). */
export async function saveSoftwareItemFor(user: CurrentUser, partId: string, fd: FormData): Promise<string> {
  const p = await ownSoftware(user.shopId, partId);
  const kind = str(fd.get("licenseKind")) === "SUBSCRIPTION" ? "SUBSCRIPTION" : "ONCE";
  let months: number | null = null;
  if (kind === "SUBSCRIPTION") {
    months = Number(str(fd.get("licenseMonths")) ?? "12");
    if (!Number.isInteger(months) || months < 1 || months > 120) throw new UserError("A subscription lasts a whole number of months, 1 to 120 (12 is a year).");
  }
  const words = (str(fd.get("noReturnText")) ?? "").replace(/\s+/g, " ").slice(0, 300) || null;
  await db.part.updateMany({ where: { id: p.id, shopId: user.shopId }, data: { licenseKind: kind, licenseMonths: months, noReturnText: words } });
  return kind === "SUBSCRIPTION" ? `${p.partNumber} is a ${months}-month subscription.` : `${p.partNumber} is a licence for good (no renewal).`;
}

/** Codes bought ahead (one a line, or separated by commas): each once; a code already loaded is skipped. Returns how many were added. */
export async function loadCodesFor(user: CurrentUser, partId: string, text: string): Promise<string> {
  const p = await ownSoftware(user.shopId, partId);
  const codes = [...new Set(String(text ?? "").split(/[\n,;]+/).map((c) => c.trim()).filter(Boolean))];
  if (!codes.length) throw new UserError("Scan or type the codes, one a line.");
  if (codes.length > MAX_CODES_AT_ONCE) throw new UserError(`${MAX_CODES_AT_ONCE} codes at a time.`);
  const long = codes.find((c) => c.length > MAX_CODE);
  if (long) throw new UserError(`A code is ${MAX_CODE} characters at most (${long.slice(0, 20)}...).`);
  const r = await db.softwareCode.createMany({ data: codes.map((code) => ({ shopId: user.shopId, partId: p.id, code })), skipDuplicates: true });
  const skipped = codes.length - r.count;
  return `${r.count} ${r.count === 1 ? "code" : "codes"} on hand for ${p.partNumber}${skipped ? ` (${skipped} already loaded)` : ""}.`;
}

export async function codesOnHand(shopId: string, partId: string): Promise<number> {
  return db.softwareCode.count({ where: { shopId, partId, usedById: null } });
}

/**
 * An online order or a pay link the customer has paid (the sale must book): software sold as one licence a line, each
 * taking a code from the shop's stock while there are some, the rest "Add the code later" (never refused).
 */
export async function softwarePaidLines<L extends { partId?: string | null; qty: number; software?: SoftwareLineInput | null }>(shopId: string, lines: L[]): Promise<L[]> {
  const ids = [...new Set(lines.map((l) => l.partId).filter((x): x is string => !!x))];
  const soft = ids.length ? await db.part.findMany({ where: { shopId, id: { in: ids }, kind: "SOFTWARE" }, select: { id: true } }) : [];
  if (!soft.length) return lines;
  const have = new Map<string, number>();
  for (const p of soft) have.set(p.id, await codesOnHand(shopId, p.id));
  const out: L[] = [];
  for (const l of lines) {
    if (!l.partId || !have.has(l.partId) || !(Number(l.qty) > 0)) {
      out.push(l);
      continue;
    }
    const n = Math.max(1, Math.round(Number(l.qty)));
    for (let k = 0; k < n; k++) {
      const left = have.get(l.partId)!;
      have.set(l.partId, left - 1);
      out.push({ ...l, qty: 1, software: { ...(l.software ?? {}), later: l.software?.code ? false : left <= 0 } });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// At the register (register-sale.ts calls these inside its transaction)
// ---------------------------------------------------------------------------------------------------------------

/** What the register sends with a software line. */
export type SoftwareLineInput = { code?: string | null; later?: boolean; machineId?: string | null; renewId?: string | null; returnReason?: string | null };

export type PreparedSoftware = {
  partId: string;
  description: string;
  kind: "ONCE" | "SUBSCRIPTION";
  months: number | null;
  noReturn: string;
  /** A sale: the code typed (null: the next on hand, or later), later, the machine, the licence it renews. */
  code: string | null;
  later: boolean;
  machineId: string | null;
  renew: { id: string; renewsOn: Date | null; code: string | null; activatedAt: Date | null; machineId: string | null } | null;
  /** A return: the licence it takes back, and the owner's reason when it was activated. */
  takeBack: { id: string; activated: boolean; fromCode: boolean } | null;
  overrideReason: string | null;
};

/**
 * Checks a software line before the sale is made: one licence a line; the machine is one of the customer's; a renewal is
 * her active subscription of this item; a code can be taken from the drawer or comes later. A return finds the licence
 * (on the receipt's sale, else her latest active one) and refuses an activated one unless an owner or admin gives a reason.
 */
export async function prepareSoftwareLine(
  a: { shopId: string; role: CurrentUser["role"]; customerId: string | null; returnOfSaleId: string | null },
  part: { id: string; partNumber: string; description: string; licenseKind: string | null; licenseMonths: number | null; noReturnText: string | null },
  qty: number,
  input: SoftwareLineInput | null | undefined,
): Promise<PreparedSoftware> {
  const sw = input ?? {};
  const kind = part.licenseKind === "SUBSCRIPTION" ? "SUBSCRIPTION" : "ONCE";
  const base: PreparedSoftware = {
    partId: part.id,
    description: part.description,
    kind,
    months: kind === "SUBSCRIPTION" ? (part.licenseMonths ?? 12) : null,
    noReturn: part.noReturnText?.trim() || NO_RETURN_DEFAULT,
    code: null,
    later: false,
    machineId: null,
    renew: null,
    takeBack: null,
    overrideReason: null,
  };
  if (Math.abs(qty) !== 1) throw new UserError(`${part.partNumber} is software: ring up one licence a line (each has its own code).`);
  if (qty < 0) {
    const where = { shopId: a.shopId, partId: part.id, status: "ACTIVE" };
    const lic =
      (a.returnOfSaleId ? await db.softwareLicense.findFirst({ where: { ...where, saleId: a.returnOfSaleId }, orderBy: { createdAt: "desc" } }) : null) ??
      (a.customerId ? await db.softwareLicense.findFirst({ where: { ...where, customerId: a.customerId }, orderBy: { createdAt: "desc" } }) : null);
    if (!lic) return base;
    const activated = lic.activatedAt != null;
    const reason = (sw.returnReason ?? "").trim().slice(0, 200) || null;
    if (activated && (a.role === "TECH" || !reason)) {
      throw new UserError(`${part.description} was activated, so it can't be returned: "${base.noReturn}"${a.role === "TECH" ? " An owner or admin can still take it back with a reason." : " To take it back anyway, give the reason on the line."}`);
    }
    const fromCode = (await db.softwareCode.count({ where: { shopId: a.shopId, usedById: lic.id } })) > 0;
    return { ...base, takeBack: { id: lic.id, activated, fromCode }, overrideReason: activated ? reason : null };
  }
  let machineId: string | null = null;
  if (sw.machineId) {
    const m = a.customerId ? await db.machine.findFirst({ where: { id: String(sw.machineId), shopId: a.shopId, customerId: a.customerId }, select: { id: true } }) : null;
    if (!m) throw new UserError("Pick the machine from the customer's own machines.");
    machineId = m.id;
  }
  if (sw.renewId) {
    if (kind !== "SUBSCRIPTION") throw new UserError(`${part.description} isn't a subscription: nothing to renew.`);
    const lic = a.customerId ? await db.softwareLicense.findFirst({ where: { id: String(sw.renewId), shopId: a.shopId, partId: part.id, customerId: a.customerId, status: "ACTIVE" } }) : null;
    if (!lic) throw new UserError("That licence isn't this customer's active subscription of this software.");
    return { ...base, machineId: machineId ?? lic.machineId, renew: { id: lic.id, renewsOn: lic.renewsOn, code: lic.code, activatedAt: lic.activatedAt, machineId: lic.machineId } };
  }
  const code = (sw.code ?? "").trim().slice(0, MAX_CODE) || null;
  const later = !code && sw.later === true;
  if (!code && !later && (await codesOnHand(a.shopId, part.id)) === 0) throw new UserError(`Scan or type the code for ${part.description}, or tick "Add the code later".`);
  return { ...base, code, later, machineId };
}

/** Inside the sale: the licence made (or renewed, or taken back) for a prepared software line. Returns the licence's id. */
export async function applySoftwareLine(
  tx: Tx,
  a: { shopId: string; at: Date; timeZone: string; saleId: string; saleLineId: string; saleNumber: number; customerId: string | null; activatedAtSale: boolean; actor: ReturnType<typeof actorOf> },
  p: PreparedSoftware,
): Promise<string | null> {
  const today = ymdOf(a.at, a.timeZone);
  if (p.takeBack) {
    const r = await tx.softwareLicense.updateMany({ where: { id: p.takeBack.id, shopId: a.shopId, status: "ACTIVE" }, data: { status: "RETURNED", returnLineId: a.saleLineId } });
    if (!r.count) throw new UserError(`${p.description} was just returned. Take it off this sale.`);
    // A code that was never activated goes back in the drawer; an activated one is used up.
    if (!p.takeBack.activated && p.takeBack.fromCode) await tx.softwareCode.updateMany({ where: { shopId: a.shopId, usedById: p.takeBack.id }, data: { usedById: null } });
    if (p.overrideReason) {
      await audit(tx, a.actor, { action: "software.return", subjectType: "SoftwareLicense", subjectId: p.takeBack.id, subjectLabel: `${p.description} (sale #${a.saleNumber})`, reason: p.overrideReason });
    }
    return p.takeBack.id;
  }
  if (p.renew) {
    const r = await tx.softwareLicense.updateMany({ where: { id: p.renew.id, shopId: a.shopId, status: "ACTIVE" }, data: { status: "RENEWED" } });
    if (!r.count) throw new UserError(`${p.description} was just renewed. Take it off this sale.`);
    // The new term runs from the old renewal date when that is still ahead, else from today.
    const from = p.renew.renewsOn && ymdOf(p.renew.renewsOn, a.timeZone) > today ? ymdOf(p.renew.renewsOn, a.timeZone) : today;
    const lic = await tx.softwareLicense.create({
      data: {
        shopId: a.shopId,
        partId: p.partId,
        description: p.description,
        saleId: a.saleId,
        saleLineId: a.saleLineId,
        customerId: a.customerId,
        machineId: p.machineId,
        code: p.renew.code,
        kind: "SUBSCRIPTION",
        startsOn: noon(from, a.timeZone),
        renewsOn: noon(addMonthsYmd(from, p.months ?? 12), a.timeZone),
        activatedAt: p.renew.activatedAt,
        renewedFromId: p.renew.id,
      },
      select: { id: true },
    });
    return lic.id;
  }
  const lic = await tx.softwareLicense.create({
    data: {
      shopId: a.shopId,
      partId: p.partId,
      description: p.description,
      saleId: a.saleId,
      saleLineId: a.saleLineId,
      customerId: a.customerId,
      machineId: p.machineId,
      code: p.code,
      kind: p.kind,
      startsOn: noon(today, a.timeZone),
      renewsOn: p.kind === "SUBSCRIPTION" ? noon(addMonthsYmd(today, p.months ?? 12), a.timeZone) : null,
      activatedAt: a.activatedAtSale ? a.at : null,
    },
    select: { id: true },
  });
  if (p.code) {
    // A typed code that is one of the codes on hand comes out of the drawer.
    await tx.softwareCode.updateMany({ where: { shopId: a.shopId, partId: p.partId, code: p.code, usedById: null }, data: { usedById: lic.id } });
  } else if (!p.later) {
    // The next code in the drawer, first in first out; two registers at once can't take the same one.
    for (let i = 0; i < 5; i++) {
      const next = await tx.softwareCode.findFirst({ where: { shopId: a.shopId, partId: p.partId, usedById: null }, orderBy: [{ receivedAt: "asc" }, { id: "asc" }] });
      if (!next) throw new UserError(`No codes left for ${p.description}. Scan or type its code, or tick "Add the code later".`);
      const took = await tx.softwareCode.updateMany({ where: { id: next.id, usedById: null }, data: { usedById: lic.id } });
      if (took.count) {
        await tx.softwareLicense.update({ where: { id: lic.id }, data: { code: next.code } });
        break;
      }
      if (i === 4) throw new UserError(`Couldn't take a code for ${p.description}. Ring it up again.`);
    }
  }
  return lic.id;
}

/** Voiding a sale: the licences it made go away (their drawer codes back on hand), a renewal's licence is active again, a take-back stands again. */
export async function voidSoftwareOfSale(tx: Tx, shopId: string, saleId: string, lineIds: string[]): Promise<void> {
  const made = await tx.softwareLicense.findMany({ where: { shopId, saleId } });
  for (const l of made) {
    if (l.status !== "ACTIVE") throw new UserError(`${l.description} on this sale was ${l.status === "RENEWED" ? "renewed" : "returned"} since. Void that sale first.`);
    await tx.softwareCode.updateMany({ where: { shopId, usedById: l.id }, data: { usedById: null } });
    if (l.renewedFromId) await tx.softwareLicense.updateMany({ where: { id: l.renewedFromId, shopId, status: "RENEWED" }, data: { status: "ACTIVE" } });
    await tx.softwareLicense.deleteMany({ where: { id: l.id, shopId } });
  }
  // A return on this sale put back: the licence it took back is active again.
  // A code that went back in the drawer with the return comes out of it again.
  if (!lineIds.length) return;
  const back = await tx.softwareLicense.findMany({ where: { shopId, status: "RETURNED", returnLineId: { in: lineIds } } });
  for (const l of back) {
    await tx.softwareLicense.update({ where: { id: l.id }, data: { status: "ACTIVE", returnLineId: null } });
    if (l.code && l.partId) await tx.softwareCode.updateMany({ where: { shopId, partId: l.partId, code: l.code, usedById: null }, data: { usedById: l.id } });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading and the licence's own steps
// ---------------------------------------------------------------------------------------------------------------

export type LicenseRow = {
  id: string;
  description: string;
  code: string | null;
  kind: string;
  status: string;
  startsText: string;
  renewsOn: Date | null;
  renewsText: string | null;
  activatedText: string | null;
  customerId: string | null;
  customerName: string | null;
  machineLabel: string | null;
  saleId: string | null;
  /** Past its renewal date and not renewed. */
  lapsed: boolean;
};

async function rows(shopId: string, where: Prisma.SoftwareLicenseWhereInput, take: number, orderBy: Prisma.SoftwareLicenseOrderByWithRelationInput[] = [{ createdAt: "desc" }]): Promise<LicenseRow[]> {
  const [list, tz] = await Promise.all([db.softwareLicense.findMany({ where: { ...where, shopId }, include: { customer: { select: { name: true } } }, orderBy, take }), shopTimeZone(shopId)]);
  const mIds = [...new Set(list.map((l) => l.machineId).filter((x): x is string => !!x))];
  const machines = mIds.length ? await db.machine.findMany({ where: { shopId, id: { in: mIds } }, select: { id: true, brand: true, model: true } }) : [];
  const mLabel = new Map(machines.map((m) => [m.id, `${m.brand} ${m.model}`]));
  const now = Date.now();
  return list.map((l) => ({
    id: l.id,
    description: l.description,
    code: l.code,
    kind: l.kind,
    status: l.status,
    startsText: fmtDate(l.startsOn, tz),
    renewsOn: l.renewsOn,
    renewsText: l.renewsOn ? fmtDate(l.renewsOn, tz) : null,
    activatedText: l.activatedAt ? fmtDate(l.activatedAt, tz) : null,
    customerId: l.customerId,
    customerName: l.customer?.name ?? null,
    machineLabel: l.machineId ? (mLabel.get(l.machineId) ?? null) : null,
    saleId: l.saleId,
    lapsed: l.status === "ACTIVE" && l.renewsOn != null && l.renewsOn.getTime() < now,
  }));
}

/** Sold with no code yet ("Add the code later"). */
export const codesToFillIn = (shopId: string) => rows(shopId, { status: "ACTIVE", code: null }, 200, [{ createdAt: "asc" }]);

/** Subscriptions renewing within `days` (and those already past, not renewed), soonest first. */
export const renewalsDue = (shopId: string, days = 30, now = new Date()) =>
  rows(shopId, { status: "ACTIVE", kind: "SUBSCRIPTION", renewsOn: { lte: new Date(now.getTime() + days * 86_400_000) } }, 200, [{ renewsOn: "asc" }]);

export const recentLicenses = (shopId: string, take = 100) => rows(shopId, {}, take);
export const licensesOfCustomer = (shopId: string, customerId: string) => rows(shopId, { customerId, status: { in: ["ACTIVE", "RENEWED"] } }, 50);
export const licensesOfMachine = (shopId: string, machineId: string) => rows(shopId, { machineId, status: { in: ["ACTIVE", "RENEWED"] } }, 50);
export const licensesOfSale = (shopId: string, saleId: string) => rows(shopId, { saleId }, 50);

/** The licences a customer could renew at the register for this item (her active subscriptions of it). */
export async function renewableFor(shopId: string, customerId: string, partId: string): Promise<{ id: string; label: string }[]> {
  const list = await rows(shopId, { customerId, partId, status: "ACTIVE", kind: "SUBSCRIPTION" }, 10);
  return list.map((l) => ({ id: l.id, label: `${maskCode(l.code) || "no code yet"}${l.renewsText ? `, renews ${l.renewsText}` : ""}` }));
}

async function ownLicense(shopId: string, id: string) {
  const l = await db.softwareLicense.findFirst({ where: { id: assertId(id), shopId } });
  if (!l) throw new UserError("Licence not found.");
  return l;
}

/** Fills in a code sold "later". A code that is one of the drawer's comes out of it. */
export async function fillCodeFor(user: CurrentUser, id: string, typed: string): Promise<string> {
  const l = await ownLicense(user.shopId, id);
  const code = String(typed ?? "").trim().slice(0, MAX_CODE);
  if (!code) throw new UserError("Scan or type the code.");
  if (l.code) throw new UserError("This licence already has its code.");
  await db.$transaction(async (tx) => {
    await tx.softwareLicense.updateMany({ where: { id: l.id, shopId: user.shopId, code: null }, data: { code } });
    if (l.partId) await tx.softwareCode.updateMany({ where: { shopId: user.shopId, partId: l.partId, code, usedById: null }, data: { usedById: l.id } });
  });
  return `Saved the code for ${l.description}.`;
}

/** Marks it activated today (after that a return needs an owner's reason), or not activated after all. */
export async function setActivatedFor(user: CurrentUser, id: string, on: boolean): Promise<string> {
  const l = await ownLicense(user.shopId, id);
  if (!on && user.role === "TECH") throw new UserError("Only an owner or admin can mark software not activated.");
  await db.softwareLicense.updateMany({ where: { id: l.id, shopId: user.shopId }, data: { activatedAt: on ? new Date() : null } });
  return on ? `${l.description} is marked activated.` : `${l.description} is marked not activated.`;
}

/** Ends a subscription the customer isn't renewing (it drops off the renewals list). Owner or admin. */
export async function endLicenseFor(user: CurrentUser, id: string): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can end a licence.");
  const l = await ownLicense(user.shopId, id);
  const r = await db.softwareLicense.updateMany({ where: { id: l.id, shopId: user.shopId, status: "ACTIVE" }, data: { status: "ENDED" } });
  if (!r.count) throw new UserError("That licence isn't active.");
  return `${l.description} is ended: no more renewal reminders.`;
}

/** The message worker, right before a renewal reminder goes: a reason to cancel, or null to send. */
export async function renewNoticeStillWanted(row: { shopId: string; refId: string | null; dedupeKey: string | null }): Promise<string | null> {
  const [, id, day] = (row.dedupeKey ?? "").split(":");
  const l = await db.softwareLicense.findFirst({ where: { id: row.refId ?? id ?? "", shopId: row.shopId }, select: { status: true, renewsOn: true } });
  if (!l || l.status !== "ACTIVE") return "The subscription was renewed or ended";
  const tz = await shopTimeZone(row.shopId);
  if (!l.renewsOn || ymdOf(l.renewsOn, tz) !== day) return "Its renewal date changed";
  return null;
}
