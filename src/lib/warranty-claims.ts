import "server-only";
// Warranty claims per maker (shop-features-round-2-design.md 9.1, package warranty-claims). On a ticket, a line marked
// "Claim it from the maker" charges the customer nothing (as a service plan's cover does: the price moves to coveredCents)
// and goes on the ticket's open claim, or a new one for the machine's maker. The claim is sent through the maker's own
// portal by hand (nothing here connects to it); this logs it and reconciles what came in: paid, paid short, refused, and
// what each maker still owes. Every query filters by shopId; a line is found through its ticket's shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str, toCents } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { audit, actorOf } from "@/lib/audit";
import { parseYmd, zonedTime } from "@/lib/zoned";
import { shopTimeZone } from "@/lib/shop-zone";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

export const CLAIM_STATUSES = ["OPEN", "FILED", "PAID", "SHORT", "REFUSED"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_LABEL: Record<string, string> = { OPEN: "Not sent yet", FILED: "Sent, waiting", PAID: "Paid", SHORT: "Paid short", REFUSED: "Refused" };
export const CLAIM_TONE: Record<string, string> = { OPEN: "tone-wait", FILED: "tone-work", PAID: "tone-done", SHORT: "tone-bad", REFUSED: "tone-bad" };
const MAX_CENTS = 10_000_000;

type Tx = Prisma.TransactionClient;

/** Parts (PART lines) and labour (everything else) of the lines on a claim, at what they would have cost. */
export function claimSums(lines: { kind: string; qty: number; coveredCents: number | null }[]) {
  let parts = 0;
  let labor = 0;
  for (const l of lines) {
    const c = Math.round(l.qty * (l.coveredCents ?? 0));
    if (l.kind === "PART") parts += c;
    else labor += c;
  }
  return { partsCents: parts, laborCents: labor };
}

/** What a closed claim came to against what was expected: short (positive), over (negative). */
export const shortBy = (c: { status: string; expectedCents: number; receivedCents: number }) => (["PAID", "SHORT", "REFUSED"].includes(c.status) ? c.expectedCents - c.receivedCents : 0);

/** Adds the claim's lines up again; while it is open and its expected amount wasn't typed over, that follows too. */
async function resum(tx: Tx, shopId: string, claimId: string) {
  const c = await tx.warrantyClaim.findFirst({ where: { id: claimId, shopId } });
  if (!c) return;
  const lines = await tx.ticketLine.findMany({ where: { claimId, ticket: { shopId } }, select: { kind: true, qty: true, coveredCents: true } });
  const s = claimSums(lines);
  const followed = c.expectedCents === c.partsCents + c.laborCents;
  await tx.warrantyClaim.update({ where: { id: c.id }, data: { ...s, ...(c.status === "OPEN" && followed ? { expectedCents: s.partsCents + s.laborCents } : {}) } });
}

/**
 * Marks a ticket line "Claim it from the maker" (it then charges nothing) on the ticket's open claim, started for the
 * machine's maker when there is none. claim false: the line is charged again and leaves its claim (only while the claim
 * isn't sent).
 */
export async function claimLineFor(user: CurrentUser, lineId: string, claim: boolean): Promise<string> {
  await requireBaseWritable(user);
  const shopId = user.shopId;
  const line = await db.ticketLine.findFirst({
    where: { id: assertId(lineId), ticket: { shopId } },
    include: { ticket: { select: { id: true, number: true, machineId: true, closedAt: true, machine: { select: { brand: true } } } } },
  });
  if (!line) throw new UserError("Line not found.");
  if (line.ticket.closedAt && user.role === "TECH") throw new UserError("The ticket is closed: only the owner or an admin can change its bill.");
  const label = `Ticket #${line.ticket.number}: ${line.description}`;
  if (!claim) {
    if (!line.claimId) return "That line is charged already.";
    const c = await db.warrantyClaim.findFirst({ where: { id: line.claimId, shopId } });
    if (c && c.status !== "OPEN") throw new UserError(`Claim #${c.number} has been sent: the line stays on it. Note any change on the claim.`);
    await db.$transaction(async (tx) => {
      const r = await tx.ticketLine.updateMany({ where: { id: line.id, claimId: line.claimId }, data: { claimId: null, coveredCents: null, unitPriceCents: line.coveredCents ?? 0 } });
      if (!r.count) throw new UserError("That line just changed. Look again.");
      if (c) await resum(tx, shopId, c.id);
      await audit(tx, actorOf(user), { action: "ticket.claimed", subjectType: "Ticket", subjectId: line.ticket.id, subjectLabel: label, changes: { claimed: [true, false] }, amountCents: line.coveredCents ?? 0 });
    });
    return "Charged to the customer again.";
  }
  if (line.claimId) throw new UserError("That line is already on a claim.");
  if (line.coveredPlanId) throw new UserError("That line is covered by a service plan. Charge it first, then claim it.");
  if (line.kind === "DISCOUNT" || line.kind === "FEE") throw new UserError("Only service, labour and parts are claimed from the maker.");
  if (line.unitPriceCents <= 0) throw new UserError("That line has no charge to claim.");
  return db.$transaction(async (tx) => {
    let c = await tx.warrantyClaim.findFirst({ where: { shopId, ticketId: line.ticket.id, status: "OPEN" }, orderBy: { number: "desc" } });
    if (!c) {
      const sh = await tx.shop.update({ where: { id: shopId }, data: { nextClaimNumber: { increment: 1 } }, select: { nextClaimNumber: true } });
      c = await tx.warrantyClaim.create({ data: { shopId, number: sh.nextClaimNumber - 1, ticketId: line.ticket.id, machineId: line.ticket.machineId, maker: line.ticket.machine.brand.slice(0, 80) || "Maker", createdById: user.id } });
    }
    const r = await tx.ticketLine.updateMany({ where: { id: line.id, claimId: null, coveredPlanId: null, unitPriceCents: line.unitPriceCents }, data: { claimId: c.id, coveredCents: line.unitPriceCents, unitPriceCents: 0 } });
    if (!r.count) throw new UserError("That line just changed. Look again.");
    await resum(tx, shopId, c.id);
    await audit(tx, actorOf(user), { action: "ticket.claimed", subjectType: "Ticket", subjectId: line.ticket.id, subjectLabel: label, changes: { claimed: [false, `claim #${c.number}`] }, amountCents: Math.round(line.qty * line.unitPriceCents) });
    return `On claim #${c.number} to ${c.maker}. The customer isn't charged for it.`;
  });
}

async function ownClaim(shopId: string, id: string) {
  const c = await db.warrantyClaim.findFirst({ where: { id: assertId(id), shopId } });
  if (!c) throw new UserError("Claim not found.");
  return c;
}

const ownerOnly = (user: CurrentUser) => {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change the money on a claim.");
};

/** The claim's details: maker, the maker's claim number, the note, and (owner or admin, while not sent) the amount expected. */
export async function saveClaimFor(user: CurrentUser, id: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  const c = await ownClaim(user.shopId, id);
  const maker = (str(fd.get("maker")) ?? "").replace(/\s+/g, " ").slice(0, 80);
  if (!maker) throw new UserError("Say which maker the claim goes to.");
  const data: Prisma.WarrantyClaimUpdateManyMutationInput = { maker, claimNumber: str(fd.get("claimNumber"))?.slice(0, 60) ?? null, note: str(fd.get("note"))?.slice(0, 1000) ?? null };
  const typed = str(fd.get("expected"));
  if (typed != null && user.role !== "TECH") {
    const cents = toCents(typed);
    if (cents == null || cents < 0 || cents > MAX_CENTS) throw new UserError("The amount expected: dollars, like 85.00.");
    if (cents !== c.expectedCents) {
      if (c.status !== "OPEN") throw new UserError("The claim has been sent: the amount expected stays as sent.");
      data.expectedCents = cents;
    }
  }
  await db.warrantyClaim.updateMany({ where: { id: c.id, shopId: user.shopId }, data });
  return `Saved claim #${c.number}.`;
}

/** Sent to the maker (through its portal, by hand): from today it is owed by the maker. */
export async function fileClaimFor(user: CurrentUser, id: string, fd: FormData | null): Promise<string> {
  await requireBaseWritable(user);
  const c = await ownClaim(user.shopId, id);
  if (c.status !== "OPEN") throw new UserError(`Claim #${c.number} is ${CLAIM_LABEL[c.status]?.toLowerCase() ?? c.status}.`);
  if (c.expectedCents <= 0) throw new UserError("Nothing is claimed yet: mark a ticket line \"Claim it from the maker\" first.");
  const number = str(fd?.get("claimNumber"))?.slice(0, 60) ?? c.claimNumber;
  const r = await db.warrantyClaim.updateMany({ where: { id: c.id, shopId: user.shopId, status: "OPEN" }, data: { status: "FILED", filedAt: new Date(), claimNumber: number } });
  if (!r.count) throw new UserError("The claim changed while you were looking. Reload and try again.");
  return `Claim #${c.number} is sent to ${c.maker}.`;
}

/** What came in from the maker, and when: paid in full (or more) or paid short. Owner or admin. */
export async function recordClaimPaymentFor(user: CurrentUser, id: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const c = await ownClaim(user.shopId, id);
  if (c.status !== "FILED") throw new UserError(c.status === "OPEN" ? "Mark the claim sent first." : `Claim #${c.number} is already settled. Undo that first.`);
  const cents = toCents(str(fd.get("amount")) ?? "");
  if (cents == null || cents <= 0 || cents > MAX_CENTS) throw new UserError("What came in: dollars, like 85.00. For nothing, use Refused.");
  const at = await dayFrom(user.shopId, str(fd.get("on")));
  const status: ClaimStatus = cents >= c.expectedCents ? "PAID" : "SHORT";
  const r = await db.warrantyClaim.updateMany({ where: { id: c.id, shopId: user.shopId, status: "FILED" }, data: { status, receivedCents: cents, receivedAt: at } });
  if (!r.count) throw new UserError("The claim changed while you were looking. Reload and try again.");
  return status === "PAID" ? `Claim #${c.number} is paid.` : `Claim #${c.number} is paid short by $${((c.expectedCents - cents) / 100).toFixed(2)}.`;
}

/** The maker refused it: nothing comes in (the note says why). Owner or admin. */
export async function refuseClaimFor(user: CurrentUser, id: string, fd: FormData | null): Promise<string> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const c = await ownClaim(user.shopId, id);
  if (c.status !== "FILED") throw new UserError(c.status === "OPEN" ? "Only a sent claim can be refused. An unsent one: charge its lines instead." : `Claim #${c.number} is already settled. Undo that first.`);
  const why = str(fd?.get("why"))?.slice(0, 300);
  const note = why ? [c.note, `Refused: ${why}`].filter(Boolean).join("\n").slice(0, 1000) : c.note;
  const r = await db.warrantyClaim.updateMany({ where: { id: c.id, shopId: user.shopId, status: "FILED" }, data: { status: "REFUSED", receivedCents: 0, receivedAt: new Date(), note } });
  if (!r.count) throw new UserError("The claim changed while you were looking. Reload and try again.");
  return `Claim #${c.number} is marked refused.`;
}

/** Undo the last step: settled back to sent, or sent back to not sent. Owner or admin. */
export async function undoClaimStepFor(user: CurrentUser, id: string): Promise<string> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const c = await ownClaim(user.shopId, id);
  const data: Prisma.WarrantyClaimUpdateManyMutationInput | null = ["PAID", "SHORT", "REFUSED"].includes(c.status)
    ? { status: "FILED", receivedCents: 0, receivedAt: null }
    : c.status === "FILED"
      ? { status: "OPEN", filedAt: null }
      : null;
  if (!data) throw new UserError("There is nothing to undo.");
  const r = await db.warrantyClaim.updateMany({ where: { id: c.id, shopId: user.shopId, status: c.status }, data });
  if (!r.count) throw new UserError("The claim changed while you were looking. Reload and try again.");
  return `Claim #${c.number} is ${CLAIM_LABEL[data.status as string].toLowerCase()} again.`;
}

async function dayFrom(shopId: string, raw: string | null): Promise<Date> {
  if (!raw) return new Date();
  const ymd = parseYmd(raw);
  if (!ymd) throw new UserError("Enter the date as a date.");
  const at = zonedTime(ymd, 12 * 60, await shopTimeZone(shopId));
  if (at.getTime() > Date.now() + 86_400_000) throw new UserError("That date is in the future.");
  return at;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

export async function claimsFor(shopId: string, o: { status?: string; maker?: string } = {}) {
  return db.warrantyClaim.findMany({
    where: { shopId, ...(o.status && (CLAIM_STATUSES as readonly string[]).includes(o.status) ? { status: o.status } : {}), ...(o.maker ? { maker: { equals: o.maker, mode: "insensitive" } } : {}) },
    orderBy: [{ number: "desc" }],
    take: 300,
  });
}

/** Per maker: claims sent and waiting, what they owe (sent, not settled), paid, short (and how much), refused. */
export async function makerSummary(shopId: string) {
  const rows = await db.warrantyClaim.findMany({ where: { shopId }, select: { maker: true, status: true, expectedCents: true, receivedCents: true } });
  const by = new Map<string, { maker: string; open: number; waiting: number; owedCents: number; paid: number; paidCents: number; short: number; shortCents: number; refused: number; refusedCents: number }>();
  for (const r of rows) {
    const k = r.maker.trim().toLowerCase();
    const m = by.get(k) ?? { maker: r.maker, open: 0, waiting: 0, owedCents: 0, paid: 0, paidCents: 0, short: 0, shortCents: 0, refused: 0, refusedCents: 0 };
    if (r.status === "OPEN") m.open++;
    if (r.status === "FILED") {
      m.waiting++;
      m.owedCents += r.expectedCents;
    }
    if (r.status === "PAID") {
      m.paid++;
      m.paidCents += r.receivedCents;
    }
    if (r.status === "SHORT") {
      m.short++;
      m.paidCents += r.receivedCents;
      m.shortCents += r.expectedCents - r.receivedCents;
    }
    if (r.status === "REFUSED") {
      m.refused++;
      m.refusedCents += r.expectedCents;
    }
    by.set(k, m);
  }
  return [...by.values()].sort((a, b) => b.owedCents - a.owedCents || a.maker.localeCompare(b.maker));
}

export async function claimView(shopId: string, id: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const c = await db.warrantyClaim.findFirst({ where: { id, shopId } });
  if (!c) return null;
  const [lines, ticket, machine] = await Promise.all([
    db.ticketLine.findMany({ where: { claimId: c.id, ticket: { shopId } }, select: { id: true, kind: true, description: true, qty: true, coveredCents: true }, orderBy: { createdAt: "asc" } }),
    c.ticketId ? db.ticket.findFirst({ where: { id: c.ticketId, shopId }, select: { id: true, number: true, customer: { select: { id: true, name: true } } } }) : null,
    c.machineId ? db.machine.findFirst({ where: { id: c.machineId, shopId }, select: { id: true, brand: true, model: true, serial: true } }) : null,
  ]);
  return { ...c, lines, ticket, machine };
}

/** The claims of one ticket (the ticket page's lines name them). */
export async function ticketClaims(shopId: string, ticketId: string) {
  return db.warrantyClaim.findMany({ where: { shopId, ticketId }, select: { id: true, number: true, maker: true, status: true, claimNumber: true }, orderBy: { number: "asc" } });
}
