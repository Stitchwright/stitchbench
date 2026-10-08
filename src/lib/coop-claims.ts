import "server-only";
// Co-op advertising and rebate claims (shop-features-round-2-design.md 9.2, package coop-claims): makers pay back part of
// what a dealer spends advertising their machines (co-op), or pay a rebate per machine sold under a program. A list of
// claims: maker, program, what was spent and where the ad ran (with a photo of the ad and the invoice), what can be
// claimed, the deadline (a dashboard line 14 days before, while not sent), sent, and what came in. Owners and admins
// keep them (marketing money); a tech sees them. Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str, toCents } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { addDays, parseYmd, ymdOf, zonedTime } from "@/lib/zoned";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";

export const COOP_LABEL: Record<string, string> = { OPEN: "Not sent yet", FILED: "Sent, waiting", PAID: "Paid", SHORT: "Paid short", DENIED: "Turned down" };
export const COOP_TONE: Record<string, string> = { OPEN: "tone-wait", FILED: "tone-work", PAID: "tone-done", SHORT: "tone-bad", DENIED: "tone-bad" };
export const COOP_KIND_LABEL: Record<string, string> = { COOP: "Co-op advertising", REBATE: "Rebate" };
/** The dashboard warns this many days before a claim's deadline. */
export const COOP_WARN_DAYS = 14;
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const MAX_CENTS = 10_000_000;

/** A shop's day (YYYY-MM-DD) in words: "Tue, Oct 21, 2026". */
export const dayWords = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });

const ownerOnly = (user: CurrentUser) => {
  if (user.role === "TECH") throw new UserError("Only an owner or admin keeps the co-op and rebate claims.");
};

async function fieldsFrom(fd: FormData) {
  const maker = (str(fd.get("maker")) ?? "").replace(/\s+/g, " ").slice(0, 80);
  if (!maker) throw new UserError("Say which maker it is claimed from.");
  const kind = str(fd.get("kind")) === "REBATE" ? "REBATE" : "COOP";
  const money = (name: string, words: string) => {
    const raw = str(fd.get(name));
    if (!raw) return 0;
    const c = toCents(raw);
    if (c == null || c < 0 || c > MAX_CENTS) throw new UserError(`${words}: dollars, like 250.00.`);
    return c;
  };
  const day = (name: string, words: string) => {
    const raw = str(fd.get(name));
    if (!raw) return null;
    const ymd = parseYmd(raw);
    if (!ymd) throw new UserError(`${words}: enter it as a date.`);
    return ymd;
  };
  const spentCents = money("spent", "What was spent");
  let claimCents = money("claim", "What can be claimed");
  // Blank: a co-op program usually pays half the ad.
  if (!str(fd.get("claim")) && kind === "COOP") claimCents = Math.round(spentCents / 2);
  return {
    maker,
    kind,
    program: str(fd.get("program"))?.slice(0, 120) ?? null,
    adWhere: str(fd.get("adWhere"))?.slice(0, 120) ?? null,
    placedOn: day("placedOn", "When it ran"),
    spentCents,
    claimCents,
    deadline: day("deadline", "The deadline"),
    note: str(fd.get("note"))?.slice(0, 1000) ?? null,
  };
}

/** The proof picked on the form (a photo or a PDF), checked. */
async function proofFrom(fd: FormData): Promise<{ name: string; mime: string; data: Uint8Array<ArrayBuffer> } | null> {
  const f = fd.get("proof");
  if (!(f instanceof File) || f.size === 0) return null;
  if (f.size > MAX_PROOF_BYTES) throw new UserError("That file is larger than 5 MB. Take the photo again at a smaller size.");
  const mime = (f.type || "").toLowerCase();
  if (!/^image\/(jpeg|png|webp|heic|heif)$|^application\/pdf$/.test(mime)) throw new UserError("A proof is a photo (JPEG, PNG) or a PDF.");
  return { name: f.name.replace(/[^\w .()-]+/g, "_").slice(-120) || "proof", mime, data: new Uint8Array(await f.arrayBuffer()) };
}

export async function createCoopFor(user: CurrentUser, fd: FormData): Promise<{ id: string; number: number }> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const data = await fieldsFrom(fd);
  const proof = await proofFrom(fd);
  return db.$transaction(async (tx) => {
    const sh = await tx.shop.update({ where: { id: user.shopId }, data: { nextCoopNumber: { increment: 1 } }, select: { nextCoopNumber: true } });
    const number = sh.nextCoopNumber - 1;
    const c = await tx.coopClaim.create({ data: { shopId: user.shopId, number, createdById: user.id, ...data }, select: { id: true } });
    if (proof) await tx.coopProof.create({ data: { shopId: user.shopId, claimId: c.id, ...proof } });
    return { id: c.id, number };
  });
}

async function own(shopId: string, id: string) {
  const c = await db.coopClaim.findFirst({ where: { id: assertId(id), shopId } });
  if (!c) throw new UserError("Claim not found.");
  return c;
}

export async function saveCoopFor(user: CurrentUser, id: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const c = await own(user.shopId, id);
  const data = await fieldsFrom(fd);
  // Once sent, the amount claimed stays as sent (the form shows it locked).
  if (c.status !== "OPEN") data.claimCents = c.claimCents;
  const proof = await proofFrom(fd);
  await db.$transaction(async (tx) => {
    await tx.coopClaim.updateMany({ where: { id: c.id, shopId: user.shopId }, data });
    if (proof) await tx.coopProof.create({ data: { shopId: user.shopId, claimId: c.id, ...proof } });
  });
  return `Saved claim #${c.number}.`;
}

export async function removeProofFor(user: CurrentUser, proofId: string): Promise<string> {
  await requireBaseWritable(user);
  ownerOnly(user);
  const r = await db.coopProof.deleteMany({ where: { id: assertId(proofId), shopId: user.shopId } });
  if (!r.count) throw new UserError("Proof not found.");
  return "Removed.";
}

const step = async (user: CurrentUser, id: string, from: string[], data: (c: Awaited<ReturnType<typeof own>>) => Prisma.CoopClaimUpdateManyMutationInput, why: (c: { number: number; status: string }) => string) => {
  await requireBaseWritable(user);
  ownerOnly(user);
  const c = await own(user.shopId, id);
  if (!from.includes(c.status)) throw new UserError(why(c));
  const r = await db.coopClaim.updateMany({ where: { id: c.id, shopId: user.shopId, status: c.status }, data: data(c) });
  if (!r.count) throw new UserError("The claim changed while you were looking. Reload and try again.");
  return c;
};

/** Sent to the maker's co-op program. */
export async function fileCoopFor(user: CurrentUser, id: string): Promise<string> {
  const pre = await own(user.shopId, id);
  if (pre.status === "OPEN" && pre.claimCents <= 0) throw new UserError("Say what can be claimed first.");
  const c = await step(user, id, ["OPEN"], () => ({ status: "FILED", filedAt: new Date() }), (x) => `Claim #${x.number} is ${COOP_LABEL[x.status].toLowerCase()}.`);
  return `Claim #${c.number} is sent to ${c.maker}.`;
}

/** What came in (a check, a credit on the maker's invoice): paid, or paid short. */
export async function recordCoopPaymentFor(user: CurrentUser, id: string, fd: FormData): Promise<string> {
  const cents = toCents(str(fd.get("amount")) ?? "");
  if (cents == null || cents <= 0 || cents > MAX_CENTS) throw new UserError("What came in: dollars, like 125.00. For nothing, use Turned down.");
  const raw = str(fd.get("on"));
  const ymd = raw ? parseYmd(raw) : null;
  if (raw && !ymd) throw new UserError("Enter the date as a date.");
  const at = ymd ? zonedTime(ymd, 12 * 60, await shopTimeZone(user.shopId)) : new Date();
  if (at.getTime() > Date.now() + 86_400_000) throw new UserError("That date is in the future.");
  const c = await step(user, id, ["FILED"], (x) => ({ status: cents >= x.claimCents ? "PAID" : "SHORT", receivedCents: cents, receivedAt: at }), (x) => (x.status === "OPEN" ? "Mark the claim sent first." : `Claim #${x.number} is already settled. Undo that first.`));
  return cents >= c.claimCents ? `Claim #${c.number} is paid.` : `Claim #${c.number} is paid short by $${((c.claimCents - cents) / 100).toFixed(2)}.`;
}

export async function denyCoopFor(user: CurrentUser, id: string, fd: FormData | null): Promise<string> {
  const why = str(fd?.get("why"))?.slice(0, 300);
  const c = await step(
    user,
    id,
    ["FILED"],
    (x) => ({ status: "DENIED", receivedCents: 0, receivedAt: new Date(), note: why ? [x.note, `Turned down: ${why}`].filter(Boolean).join("\n").slice(0, 1000) : x.note }),
    (x) => (x.status === "OPEN" ? "Only a sent claim can be turned down." : `Claim #${x.number} is already settled. Undo that first.`),
  );
  return `Claim #${c.number} is marked turned down.`;
}

export async function undoCoopFor(user: CurrentUser, id: string): Promise<string> {
  const c = await step(
    user,
    id,
    ["FILED", "PAID", "SHORT", "DENIED"],
    (x) => (x.status === "FILED" ? { status: "OPEN", filedAt: null } : { status: "FILED", receivedCents: 0, receivedAt: null }),
    () => "There is nothing to undo.",
  );
  return `Claim #${c.number} is ${c.status === "FILED" ? "not sent yet" : "sent, waiting"} again.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

export async function coopList(shopId: string) {
  return db.coopClaim.findMany({ where: { shopId }, orderBy: [{ number: "desc" }], take: 300 });
}

/** Not sent yet with the deadline within 14 days (or past): the dashboard's line. */
export async function coopDue(shopId: string, now = new Date()) {
  const today = ymdOf(now, await shopTimeZone(shopId));
  return db.coopClaim.findMany({ where: { shopId, status: "OPEN", deadline: { not: null, lte: addDays(today, COOP_WARN_DAYS) } }, orderBy: { deadline: "asc" }, select: { id: true, number: true, maker: true, deadline: true } });
}

/** Per maker: claimed and waiting, received this year and all time. */
export async function coopTotals(shopId: string) {
  const rows = await db.coopClaim.findMany({ where: { shopId }, select: { maker: true, status: true, claimCents: true, receivedCents: true } });
  const by = new Map<string, { maker: string; waitingCents: number; receivedCents: number; unsent: number }>();
  for (const r of rows) {
    const k = r.maker.trim().toLowerCase();
    const m = by.get(k) ?? { maker: r.maker, waitingCents: 0, receivedCents: 0, unsent: 0 };
    if (r.status === "FILED") m.waitingCents += r.claimCents;
    if (r.status === "OPEN") m.unsent++;
    m.receivedCents += r.receivedCents;
    by.set(k, m);
  }
  return [...by.values()].sort((a, b) => b.waitingCents - a.waitingCents || a.maker.localeCompare(b.maker));
}

export async function coopView(shopId: string, id: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  return db.coopClaim.findFirst({ where: { id, shopId }, include: { proofs: { select: { id: true, name: true, mime: true, createdAt: true }, orderBy: { createdAt: "asc" } } } });
}

/** A proof for the browser: the signed-in company's own only. */
export async function coopProof(shopId: string, id: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  return db.coopProof.findFirst({ where: { id, shopId }, select: { name: true, mime: true, data: true } });
}
