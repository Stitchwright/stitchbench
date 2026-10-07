import "server-only";
// Print and cut jobs (shop-features-round-2-design.md 6.5, package make-jobs, Maker Shop): the longarm work order's pattern
// for the shop's 3D printer, resin printer, laser or cutter. A job: who it is for, what it is ("20 acrylic name tags"),
// the customer's file (kept until 30 days after pickup, then deleted), the machine, the material from stock, and "Work
// out the price" (machine time x the shop's rate + material used x its price + a set-up fee, from Settings and filled in).
// Quoted, approved (by the estimate link or at the counter), printing or cutting, ready (the ready message), collected
// (billed at the register like a longarm order). The shop decides what it will make: "Turn it down" with a reason, and
// the laser's never-cut list (PVC and vinyl give off chlorine gas). Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str, toCents } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireModule } from "@/lib/modules";
import { moduleOn, requireOn } from "@/lib/module-gate";
import { customerFromForm } from "@/lib/customer-input";
import { completeSaleAs } from "@/lib/register-sale";
import { TENDER_METHODS, saleTotals, type TenderMethod } from "@/lib/register-math";
import { exemptCertificate } from "@/lib/tax-exempt";
import { shopTimeZone } from "@/lib/shop-zone";
import { parseYmd, zonedTime } from "@/lib/zoned";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView, publicBaseUrl } from "@/lib/messaging/settings";
import { firstName } from "@/lib/messaging/templates";
import { createEstimateLink, estimateContent } from "@/lib/estimate-links";
import {
  FILE_KEEP_DAYS,
  MAKE_KIND_LABEL,
  MAKE_MOVES,
  MATERIAL_TYPES,
  MAX_FILE_BYTES,
  OPEN_MAKE,
  isMakeKind,
  makePrice,
  materialMeasure,
  neverCutHit,
  statusLabel,
  type MakeKind,
  type MakeStatus,
} from "@/lib/make-jobs-math";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@/generated/prisma/client";
import { currentStoreId } from "@/lib/stores";

const DAY = 86_400_000;
const MAX_CENTS = 10_000_000;

// ---------------------------------------------------------------------------------------------------------------
// Settings

export async function makeSettings(shopId: string) {
  return db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { makeRateCents: true, makeSetupCents: true, makeNeverCut: true } });
}

/** The machine's hourly rate, the set-up fee and the laser's never-cut list. Owner or admin. */
export async function saveMakeSettingsFor(user: CurrentUser, fd: FormData): Promise<string> {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change the job prices.");
  await requireModule(user, "maker");
  const rate = toCents(str(fd.get("rate")) ?? "");
  const setup = toCents(str(fd.get("setup")) ?? "0");
  if (rate == null || rate < 0 || rate > 100_000) throw new UserError("The machine's rate: dollars an hour, like 20.");
  if (setup == null || setup < 0 || setup > 100_000) throw new UserError("The set-up fee: dollars, like 5 (0 for none).");
  const never = (str(fd.get("neverCut")) ?? "").replace(/\s+/g, " ").slice(0, 300);
  await db.shop.update({ where: { id: user.shopId }, data: { makeRateCents: rate, makeSetupCents: setup, makeNeverCut: never } });
  return "Saved the job prices.";
}

// ---------------------------------------------------------------------------------------------------------------
// The material and the price

/** The supplies on hand a kind of job can use (the form's material list). */
export async function materialsFor(shopId: string) {
  const parts = await db.part.findMany({
    where: { shopId, itemType: { in: [...new Set(Object.values(MATERIAL_TYPES).flat())] }, consignLinkId: null },
    select: { id: true, partNumber: true, description: true, kind: true, itemType: true, priceCents: true, specs: true, material: true, qtyOnHand: true },
    orderBy: { description: "asc" },
    take: 500,
  });
  return parts.map((p) => ({ ...p, measure: materialMeasure(p) }));
}

type Fields = {
  title: string;
  kind: MakeKind;
  machineMinutes: number;
  materialPartId: string | null;
  materialName: string | null;
  materialQty: number;
  materialUnit: string | null;
  materialCents: number;
  rateCents: number;
  setupCents: number;
  quoteCents: number;
  taxable: boolean;
  dueAt: Date | null;
  note: string | null;
};

/** The form's fields, checked, and the price worked out. A tech's job takes the shop's rate and set-up fee. */
async function fieldsFrom(user: CurrentUser, fd: FormData): Promise<Fields> {
  const shopId = user.shopId;
  const title = (str(fd.get("title")) ?? "").replace(/\s+/g, " ").slice(0, 120);
  if (!title) throw new UserError('Say what it is, like "20 acrylic name tags".');
  const kind = str(fd.get("kind")) ?? "PRINT";
  if (!isMakeKind(kind)) throw new UserError("Pick the machine: 3D print, resin print, laser or cutter.");
  const hours = Number(str(fd.get("hours")) ?? "0");
  const mins = Number(str(fd.get("minutes")) ?? "0");
  const minutes = Math.round((Number.isFinite(hours) ? hours : NaN) * 60 + (Number.isFinite(mins) ? mins : NaN));
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 60 * 24 * 14) throw new UserError("The machine time: hours and minutes, up to two weeks.");
  const settings = await makeSettings(shopId);
  const typedRate = str(fd.get("rate"));
  const typedSetup = str(fd.get("setup"));
  let rateCents = settings.makeRateCents;
  let setupCents = settings.makeSetupCents;
  if (user.role !== "TECH") {
    if (typedRate) {
      const r = toCents(typedRate);
      if (r == null || r < 0 || r > 100_000) throw new UserError("The rate: dollars an hour.");
      rateCents = r;
    }
    if (typedSetup) {
      const s = toCents(typedSetup);
      if (s == null || s < 0 || s > 100_000) throw new UserError("The set-up fee: dollars.");
      setupCents = s;
    }
  }
  let materialPartId: string | null = null;
  let materialName: string | null = null;
  let materialUnit: string | null = null;
  let unitCents: number | null = null;
  const qty = Number((str(fd.get("materialQty")) ?? "0").replace(/[^\d.]/g, "") || "0");
  const partId = str(fd.get("materialPartId"));
  if (partId) {
    const p = await db.part.findFirst({ where: { id: assertId(partId), shopId }, select: { id: true, description: true, kind: true, itemType: true, priceCents: true, specs: true, material: true } });
    if (!p) throw new UserError("That material isn't in your inventory.");
    if (kind === "LASER") {
      const hit = neverCutHit(settings.makeNeverCut, p);
      if (hit) throw new UserError(`The laser never cuts ${hit}: it gives off harmful fumes. Turn the job down or pick another material.`);
    }
    const m = materialMeasure(p);
    if (m.unitCents == null && qty > 0) throw new UserError(`${p.description} has no price yet: give it one on its page, or leave the material out.`);
    materialPartId = p.id;
    materialName = p.description;
    materialUnit = m.unit;
    unitCents = m.unitCents;
  } else if (kind === "LASER") {
    const typed = str(fd.get("materialName"));
    const hit = typed ? neverCutHit(settings.makeNeverCut, { name: typed }) : null;
    if (hit) throw new UserError(`The laser never cuts ${hit}: it gives off harmful fumes.`);
    materialName = typed?.slice(0, 80) ?? null;
  } else materialName = str(fd.get("materialName"))?.slice(0, 80) ?? null;
  if (!Number.isFinite(qty) || qty < 0 || qty > 100_000) throw new UserError("How much material: a number (grams, ml or sheets).");
  const price = makePrice({ minutes, rateCents, materialQty: qty, materialUnitCents: unitCents, setupCents });
  if (price.totalCents > MAX_CENTS) throw new UserError("That comes to more than $100,000. Check the time and the material.");
  const dueRaw = str(fd.get("due"));
  const dueYmd = dueRaw ? parseYmd(dueRaw) : null;
  if (dueRaw && !dueYmd) throw new UserError("Enter the due date as a date.");
  const tz = await shopTimeZone(shopId);
  return {
    title,
    kind,
    machineMinutes: minutes,
    materialPartId,
    materialName,
    materialQty: qty,
    materialUnit,
    materialCents: price.materialCents,
    rateCents,
    setupCents: price.setupCents,
    quoteCents: price.totalCents,
    taxable: !fd.has("taxable") || fd.getAll("taxable").map(String).includes("on"),
    dueAt: dueYmd ? zonedTime(dueYmd, 12 * 60, tz) : null,
    note: str(fd.get("note"))?.slice(0, 1000) ?? null,
  };
}

/** The customer's file from the form, checked: 10 MB at most. Null when none was chosen. */
async function fileFrom(fd: FormData): Promise<{ name: string; mime: string; data: Uint8Array<ArrayBuffer> } | null> {
  const f = fd.get("file");
  if (!(f instanceof File) || f.size === 0) return null;
  if (f.size > MAX_FILE_BYTES) throw new UserError(`That file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB. Ask for a smaller one, or keep it on the shop's computer.`);
  const name = f.name.replace(/[^\w .()-]+/g, "_").slice(-120) || "file";
  return { name, mime: (f.type || "application/octet-stream").slice(0, 100), data: new Uint8Array(await f.arrayBuffer()) };
}

// ---------------------------------------------------------------------------------------------------------------
// The job's steps

export async function createJobFor(user: CurrentUser, fd: FormData): Promise<{ id: string; number: number }> {
  await requireBaseWritable(user);
  await requireModule(user, "maker");
  const shopId = user.shopId;
  const data = await fieldsFrom(user, fd);
  const file = await fileFrom(fd);
  // Taken in at this store (7.1): made on its machines.
  const here = await currentStoreId(user);
  return db.$transaction(async (tx) => {
    const customer = await customerFromForm(tx, shopId, fd, user.id, "counter");
    const sh = await tx.shop.update({ where: { id: shopId }, data: { nextMakeJobNumber: { increment: 1 } }, select: { nextMakeJobNumber: true } });
    const number = sh.nextMakeJobNumber - 1;
    const j = await tx.makeJob.create({
      data: { shopId, locationId: here, number, customerId: customer.id, name: customer.name, createdById: user.id, ...data, ...(file ? { fileName: file.name, fileMime: file.mime, fileData: file.data } : {}) },
      select: { id: true },
    });
    return { id: j.id, number };
  });
}

async function ownJob(shopId: string, id: string) {
  const j = await db.makeJob.findFirst({ where: { id: assertId(id), shopId } });
  if (!j) throw new UserError("Job not found.");
  return j;
}

/** Changes an open job's details and price (and its file, when one is chosen). */
export async function saveJobFor(user: CurrentUser, id: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "maker");
  const j = await ownJob(user.shopId, id);
  if (!OPEN_MAKE.includes(j.status as MakeStatus) || j.status === "READY") throw new UserError(`A ${statusLabel(j.status, j.kind).toLowerCase()} job can't be changed.`);
  const data = await fieldsFrom(user, fd);
  const file = await fileFrom(fd);
  const r = await db.makeJob.updateMany({ where: { id: j.id, shopId: user.shopId, status: j.status }, data: { ...data, ...(file ? { fileName: file.name, fileMime: file.mime, fileData: file.data, fileDeleteAfter: null } : {}) } });
  if (r.count !== 1) throw new UserError("The job changed while you were looking. Reload and try again.");
  return `Saved: $${(data.quoteCents / 100).toFixed(2)} before tax.`;
}

/** Moves a job one step (see MAKE_MOVES); Ready tells the customer when Messages is on. */
export async function setJobStatusFor(user: CurrentUser, id: string, to: string): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "maker");
  const j = await ownJob(user.shopId, id);
  if (to === "COLLECTED") throw new UserError("Collect it to take payment and hand it over.");
  if (!(MAKE_MOVES[j.status] ?? []).includes(to as MakeStatus)) throw new UserError(`A ${statusLabel(j.status, j.kind).toLowerCase()} job can't go to ${statusLabel(to, j.kind).toLowerCase()}.`);
  const at = new Date();
  const stamps: Prisma.MakeJobUpdateManyMutationInput =
    to === "APPROVED" ? { approvedAt: j.approvedAt ?? at, startedAt: null, readyAt: null } : to === "WORKING" ? { startedAt: j.startedAt ?? at, readyAt: null } : to === "READY" ? { readyAt: at } : to === "QUOTED" ? { approvedAt: null } : to === "CANCELLED" ? { closedAt: at, fileDeleteAfter: new Date(at.getTime() + FILE_KEEP_DAYS * DAY) } : {};
  const r = await db.makeJob.updateMany({ where: { id: j.id, shopId: user.shopId, status: j.status }, data: { status: to, ...stamps } });
  if (r.count !== 1) throw new UserError("The job changed while you were looking. Reload and try again.");
  let told = "";
  if (to === "READY" && j.customerId && (await moduleOn(user.shopId, "marketing"))) {
    const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true } });
    const body = `Hi ${firstName(j.name)}, your ${j.title} (job #${j.number}) is ready to pick up at ${shop.name}.${shop.phone ? ` Questions? Call ${shop.phone}.` : ""}`;
    const q = await db.$transaction((tx) =>
      queueToCustomer(tx, {
        shopId: user.shopId,
        customerId: j.customerId!,
        kind: "order_notice",
        channels: "preferred",
        content: (ch) => (ch === "email" ? { subject: `Your ${j.title} is ready`, body } : { body }),
        dedupeKey: `make:${j.id}:ready:${at.toISOString().slice(0, 10)}`,
        refType: "make_job",
        refId: j.id,
        byUserId: user.id,
      }),
    );
    told = q.queued.length ? " The customer is told it's ready." : " The customer couldn't be messaged: call them.";
  }
  return `Job #${j.number} is ${statusLabel(to, j.kind).toLowerCase()}.${told}`;
}

/** The shop won't make it (copied logos, weapons, unsafe materials): turned down with the reason, kept as a record. */
export async function turnDownFor(user: CurrentUser, id: string, why: string): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "maker");
  const j = await ownJob(user.shopId, id);
  const reason = String(why ?? "").trim().slice(0, 300);
  if (!reason) throw new UserError("Say why, in a few words (the customer may ask).");
  if (!["QUOTED", "APPROVED"].includes(j.status)) throw new UserError(`A ${statusLabel(j.status, j.kind).toLowerCase()} job can't be turned down.`);
  const at = new Date();
  const r = await db.makeJob.updateMany({ where: { id: j.id, shopId: user.shopId, status: j.status }, data: { status: "TURNED_DOWN", turnedDownWhy: reason, closedAt: at, fileDeleteAfter: new Date(at.getTime() + FILE_KEEP_DAYS * DAY) } });
  if (r.count !== 1) throw new UserError("The job changed while you were looking. Reload and try again.");
  return `Job #${j.number} is turned down.`;
}

/**
 * The customer picks it up and pays: the job is billed as a register sale (machine time, material, set-up fee, taxed at
 * the shop's rate if taxable) in the payment picked, and is marked collected; its file is deleted 30 days later.
 */
export async function collectJobFor(user: CurrentUser, id: string, fd: FormData | null): Promise<string> {
  const shopId = user.shopId;
  await requireModule(user, "maker");
  const j = await ownJob(shopId, id);
  const asked = String(fd?.get("method") ?? "CASH");
  const method: TenderMethod = (TENDER_METHODS as string[]).includes(asked) ? (asked as TenderMethod) : "CASH";
  const at = new Date();
  const claimed = await db.makeJob.updateMany({ where: { id: j.id, shopId, status: "READY", saleId: null }, data: { status: "COLLECTED", collectedAt: at, closedAt: at, fileDeleteAfter: new Date(at.getTime() + FILE_KEEP_DAYS * DAY) } });
  if (claimed.count !== 1) throw new UserError(j.status === "READY" ? "That job was just collected." : `Only a ready job can be collected (this one is ${statusLabel(j.status, j.kind).toLowerCase()}).`);
  try {
    if (j.quoteCents <= 0) return `Job #${j.number} is collected (no charge).`;
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { taxRatePct: true } });
    const hours = j.machineMinutes / 60;
    const machineCents = j.quoteCents - j.materialCents - j.setupCents;
    const lines = [
      ...(machineCents > 0 ? [{ description: `${MAKE_KIND_LABEL[j.kind as MakeKind] ?? "Job"} #${j.number}: ${j.title} (${hours.toFixed(hours % 1 ? 2 : 0)} h)`.slice(0, 200), qty: 1, unitPriceCents: machineCents, taxable: j.taxable }] : []),
      ...(j.materialCents > 0 ? [{ description: `Material: ${j.materialQty} ${j.materialUnit === "sheet" ? (j.materialQty === 1 ? "sheet" : "sheets") : j.materialUnit ?? ""} ${j.materialName ?? ""}`.replace(/\s+/g, " ").trim().slice(0, 200), qty: 1, unitPriceCents: j.materialCents, taxable: j.taxable }] : []),
      ...(j.setupCents > 0 ? [{ description: `Set-up, job #${j.number}`, qty: 1, unitPriceCents: j.setupCents, taxable: j.taxable }] : []),
    ];
    const exempt = j.customerId ? exemptCertificate(await db.customer.findFirst({ where: { id: j.customerId, shopId }, select: { taxExemptId: true, taxExemptUntil: true } })) : null;
    const total = saleTotals(lines, 0, exempt ? 0 : shop.taxRatePct, []).total;
    const sale = await completeSaleAs(user, { customerId: j.customerId, lines, tenders: [{ method, amountCents: total, note: null }], note: `Print or cut job #${j.number}`, clientKey: `make-${j.id}-${at.getTime()}` });
    await db.makeJob.updateMany({ where: { id: j.id, shopId }, data: { saleId: sale.saleId } });
    return `Job #${j.number} is collected: sale #${sale.number} in the register.`;
  } catch (e) {
    // Nothing was billed: it is still waiting on the shelf.
    await db.makeJob.updateMany({ where: { id: j.id, shopId, status: "COLLECTED", saleId: null }, data: { status: "READY", collectedAt: null, closedAt: null, fileDeleteAfter: null } });
    throw e;
  }
}

/** Voiding the sale a job was collected on: it is back on the shelf (ready), its file kept again. */
export async function uncollectJobsOfSale(tx: Prisma.TransactionClient, shopId: string, saleId: string): Promise<void> {
  await tx.makeJob.updateMany({ where: { shopId, saleId, status: "COLLECTED" }, data: { status: "READY", collectedAt: null, closedAt: null, saleId: null, fileDeleteAfter: null } });
}

/** Files past their 30 days (after pickup, cancelling or turning down) are deleted; the job keeps the file's name. */
export async function purgeJobFiles(shopId: string | null, now = new Date()): Promise<number> {
  const r = await db.makeJob.updateMany({ where: { ...(shopId ? { shopId } : {}), fileDeleteAfter: { lte: now }, fileData: { not: null } }, data: { fileData: null } });
  return r.count;
}

/** The quote by the estimate link, for the customer to approve or decline (Marketing; a public address). */
export async function sendQuoteFor(user: CurrentUser, id: string, input: { email: boolean; sms: boolean; note: string | null }): Promise<string> {
  const shopId = user.shopId;
  await requireModule(user, "maker");
  await requireOn(user, "marketing");
  const j = await ownJob(shopId, id);
  if (j.status !== "QUOTED") throw new UserError("Only a quoted job's price goes out for approval.");
  if (!j.customerId) throw new UserError("This job has no customer to send it to.");
  if (j.quoteCents <= 0) throw new UserError("Work out the price first.");
  if (!publicBaseUrl()) throw new UserError("This install has no public address, so there are no quote links. Call them with the price instead.");
  const channels = [...(input.email ? (["email"] as const) : []), ...(input.sms ? (["sms"] as const) : [])];
  if (!channels.length) throw new UserError("Pick email, text or both.");
  const [shop, ms, customer] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true } }),
    messagingView(shopId),
    db.customer.findFirstOrThrow({ where: { id: j.customerId, shopId }, select: { name: true, phone: true } }),
  ]);
  const machineCents = j.quoteCents - j.materialCents - j.setupCents;
  const lines = [
    ...(machineCents > 0 ? [{ description: `Machine time (${(j.machineMinutes / 60).toFixed(2)} h)`, amountCents: machineCents }] : []),
    ...(j.materialCents > 0 ? [{ description: `Material: ${j.materialQty} ${j.materialUnit ?? ""} ${j.materialName ?? ""}`.replace(/\s+/g, " ").trim(), amountCents: j.materialCents }] : []),
    ...(j.setupCents > 0 ? [{ description: "Set-up", amountCents: j.setupCents }] : []),
  ];
  const note = input.note?.trim().slice(0, 500) || "We decide what we'll print or cut.";
  await db.$transaction(async (tx) => {
    const link = await createEstimateLink(tx, { shopId, makeJobId: j.id, customerId: j.customerId!, totalCents: j.quoteCents, lines, note, days: ms.estimateLinkDays, byUserId: user.id });
    await tx.makeJob.updateMany({ where: { id: j.id, shopId }, data: { estimateLinkId: link.id } });
    const s = { target: "job" as const, customerId: j.customerId!, customerName: customer.name, customerPhone: customer.phone, machine: j.title, ref: `job #${j.number}`, lines, totalCents: j.quoteCents };
    const r = await queueToCustomer(tx, {
      shopId,
      customerId: j.customerId!,
      kind: "estimate",
      channels: [...channels],
      content: (ch) => estimateContent(ms, shop, s, note, link.maskedUrl, ch),
      dedupeKey: `estimate:${link.id}`,
      notAfter: link.expiresAt,
      refType: "estimate",
      refId: link.id,
      byUserId: user.id,
      ms,
    });
    if (!r.queued.length) throw new UserError("Not sent: they can't be reached by the way picked. Call them with the price.");
  });
  return `The quote for job #${j.number} is on its way.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

export type JobRow = { id: string; number: number; name: string; customerId: string | null; title: string; kind: string; status: string; quoteCents: number; dueAt: Date | null; createdAt: Date; overdue: boolean };

/** Open jobs first (soonest due), then the latest closed ones. Files past their days are deleted on the way. */
export async function jobsFor(shopId: string, o: { closed?: boolean; take?: number } = {}, now = new Date()): Promise<JobRow[]> {
  await purgeJobFiles(shopId, now);
  const rows = await db.makeJob.findMany({
    where: { shopId, status: o.closed ? { in: ["COLLECTED", "CANCELLED", "TURNED_DOWN"] } : { in: OPEN_MAKE } },
    select: { id: true, number: true, name: true, customerId: true, title: true, kind: true, status: true, quoteCents: true, dueAt: true, createdAt: true },
    orderBy: o.closed ? [{ number: "desc" }] : [{ dueAt: { sort: "asc", nulls: "last" } }, { number: "asc" }],
    take: o.take ?? 200,
  });
  return rows.map((r) => ({ ...r, overdue: !!r.dueAt && r.status !== "READY" && r.dueAt.getTime() < now.getTime() }));
}

export async function jobView(shopId: string, id: string) {
  await purgeJobFiles(shopId);
  const j = await db.makeJob.findFirst({ where: { id, shopId }, omit: { fileData: true } });
  if (!j) return null;
  const [hasFile, sale, link] = await Promise.all([
    db.makeJob.count({ where: { id: j.id, shopId, fileData: { not: null } } }),
    j.saleId ? db.sale.findFirst({ where: { id: j.saleId, shopId }, select: { id: true, number: true } }) : null,
    j.estimateLinkId ? db.estimateLink.findFirst({ where: { id: j.estimateLinkId, shopId }, select: { answer: true, answeredAt: true, answerNote: true, expiresAt: true, revokedAt: true } }) : null,
  ]);
  return { ...j, hasFile: hasFile > 0, sale, link };
}

/** The file for download: this company's own job only, while it is kept. */
export async function jobFile(shopId: string, id: string): Promise<{ name: string; mime: string; data: Uint8Array } | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const j = await db.makeJob.findFirst({ where: { id, shopId }, select: { fileName: true, fileMime: true, fileData: true, fileDeleteAfter: true } });
  if (!j?.fileData || (j.fileDeleteAfter && j.fileDeleteAfter <= new Date())) return null;
  return { name: j.fileName ?? "file", mime: j.fileMime ?? "application/octet-stream", data: j.fileData };
}
