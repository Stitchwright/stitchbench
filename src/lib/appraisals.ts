import "server-only";
// Quilt appraisal certificates (shop-features-round-2-design.md 9.8, package appraisals). "New appraisal": the customer,
// the quilt (its name, size, maker, when it was made, techniques, materials, condition, a description), photos, the
// value and what it is for (insurance replacement, fair market, donation), and the appraiser with her credential (filled
// in from Settings). "Issue the certificate" rings the fee up at the register like a longarm order and fixes the
// certificate (number, date); it prints with the first photo. Voiding the fee's sale makes it a draft again. Every query
// filters by shopId.
import { db } from "@/lib/db";
import { PURPOSES } from "@/lib/appraisals-words";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str, toCents } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { customerFromForm } from "@/lib/customer-input";
import { completeSaleAs } from "@/lib/register-sale";
import { TENDER_METHODS, type TenderMethod } from "@/lib/register-math";
import type { CurrentUser } from "@/lib/session";

export type QuiltDetails = { title: string; widthIn: number | null; lengthIn: number | null; maker: string; made: string; techniques: string; materials: string; condition: string; description: string };
const MAX_CENTS = 10_000_000;
const MAX_PHOTO = 5 * 1024 * 1024;
const MAX_PHOTOS = 6;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function readDetails(raw: unknown): QuiltDetails {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const t = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null);
  return { title: t("title"), widthIn: n("widthIn"), lengthIn: n("lengthIn"), maker: t("maker"), made: t("made"), techniques: t("techniques"), materials: t("materials"), condition: t("condition"), description: t("description") };
}

function detailsFrom(fd: FormData): QuiltDetails {
  const t = (k: string, max = 200) => (str(fd.get(k)) ?? "").replace(/\s+/g, " ").slice(0, max);
  const inches = (k: string, words: string) => {
    const raw = str(fd.get(k));
    if (!raw) return null;
    const v = Number(raw.replace(/["in ]+$/i, ""));
    if (!Number.isFinite(v) || v <= 0 || v > 1000) throw new UserError(`${words}: inches, like 72.`);
    return Math.round(v * 10) / 10;
  };
  const title = t("title", 120);
  if (!title) throw new UserError('Name the quilt, like "Grandmother\'s Flower Garden".');
  return {
    title,
    widthIn: inches("widthIn", "The width"),
    lengthIn: inches("lengthIn", "The length"),
    maker: t("maker"),
    made: t("made", 60),
    techniques: t("techniques", 300),
    materials: t("materials", 300),
    condition: t("condition", 300),
    description: (str(fd.get("description")) ?? "").slice(0, 3000),
  };
}

async function photosFrom(fd: FormData) {
  const out: { mime: string; data: Uint8Array<ArrayBuffer> }[] = [];
  for (const f of fd.getAll("photo")) {
    if (!(f instanceof File) || f.size === 0) continue;
    if (!PHOTO_TYPES.has(f.type)) throw new UserError("Photos are JPEG, PNG or WebP.");
    if (f.size > MAX_PHOTO) throw new UserError("A photo is larger than 5 MB. Take it again at a smaller size.");
    out.push({ mime: f.type, data: new Uint8Array(await f.arrayBuffer()) });
  }
  return out;
}

async function moneyFields(user: CurrentUser, fd: FormData, shop: { appraisalFeeCents: number }) {
  const rawValue = str(fd.get("value"));
  const valueCents = rawValue ? toCents(rawValue) : 0;
  if (valueCents == null || valueCents < 0 || valueCents > MAX_CENTS) throw new UserError("The value: dollars, like 1,200.");
  let feeCents = shop.appraisalFeeCents;
  const rawFee = str(fd.get("fee"));
  if (rawFee && user.role !== "TECH") {
    const f = toCents(rawFee);
    if (f == null || f < 0 || f > 100_000) throw new UserError("The fee: dollars, like 75.");
    feeCents = f;
  }
  const p = str(fd.get("purpose")) ?? "insurance";
  return { valueCents, feeCents, purpose: p in PURPOSES ? p : "insurance" };
}

export async function appraisalSettings(shopId: string) {
  return db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { appraisalFeeCents: true, appraiserName: true, appraiserCredential: true, name: true, address: true, phone: true } });
}

export async function createAppraisalFor(user: CurrentUser, fd: FormData): Promise<{ id: string; number: number }> {
  await requireBaseWritable(user);
  const shopId = user.shopId;
  const shop = await appraisalSettings(shopId);
  const details = detailsFrom(fd);
  const money = await moneyFields(user, fd, shop);
  const photos = await photosFrom(fd);
  if (photos.length > MAX_PHOTOS) throw new UserError(`${MAX_PHOTOS} photos at most.`);
  return db.$transaction(async (tx) => {
    const c = await customerFromForm(tx, shopId, fd, user.id, "counter");
    const sh = await tx.shop.update({ where: { id: shopId }, data: { nextAppraisalNumber: { increment: 1 } }, select: { nextAppraisalNumber: true } });
    const number = sh.nextAppraisalNumber - 1;
    const a = await tx.appraisal.create({
      data: { shopId, number, customerId: c.id, name: c.name, details, ...money, appraiser: str(fd.get("appraiser"))?.slice(0, 80) ?? shop.appraiserName, credential: str(fd.get("credential"))?.slice(0, 160) ?? shop.appraiserCredential, createdById: user.id },
      select: { id: true },
    });
    for (const [i, p] of photos.entries()) await tx.appraisalPhoto.create({ data: { shopId, appraisalId: a.id, ...p, sortOrder: i } });
    return { id: a.id, number };
  });
}

async function own(shopId: string, id: string) {
  const a = await db.appraisal.findFirst({ where: { id: assertId(id), shopId } });
  if (!a) throw new UserError("Appraisal not found.");
  return a;
}

/** Changes a draft (an issued certificate stays as issued). New photos are added. */
export async function saveAppraisalFor(user: CurrentUser, id: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  const a = await own(user.shopId, id);
  if (a.issuedAt) throw new UserError(`Certificate #${a.number} is issued: it can't be changed. Start a new appraisal to replace it.`);
  const shop = await appraisalSettings(user.shopId);
  const details = detailsFrom(fd);
  const money = await moneyFields(user, fd, { appraisalFeeCents: user.role === "TECH" ? a.feeCents : shop.appraisalFeeCents });
  const photos = await photosFrom(fd);
  const have = await db.appraisalPhoto.count({ where: { appraisalId: a.id, shopId: user.shopId } });
  if (have + photos.length > MAX_PHOTOS) throw new UserError(`${MAX_PHOTOS} photos at most. Remove one first.`);
  await db.$transaction(async (tx) => {
    const r = await tx.appraisal.updateMany({ where: { id: a.id, shopId: user.shopId, issuedAt: null }, data: { details, ...money, appraiser: str(fd.get("appraiser"))?.slice(0, 80) ?? null, credential: str(fd.get("credential"))?.slice(0, 160) ?? null } });
    if (!r.count) throw new UserError("It was just issued. Reload.");
    for (const [i, p] of photos.entries()) await tx.appraisalPhoto.create({ data: { shopId: user.shopId, appraisalId: a.id, ...p, sortOrder: have + i } });
  });
  return `Saved appraisal #${a.number}.`;
}

export async function removeAppraisalPhotoFor(user: CurrentUser, photoId: string): Promise<string> {
  await requireBaseWritable(user);
  const p = await db.appraisalPhoto.findFirst({ where: { id: assertId(photoId), shopId: user.shopId }, select: { id: true, appraisal: { select: { issuedAt: true } } } });
  if (!p) throw new UserError("Photo not found.");
  if (p.appraisal.issuedAt) throw new UserError("The certificate is issued: its photos stay.");
  await db.appraisalPhoto.deleteMany({ where: { id: p.id, shopId: user.shopId } });
  return "Removed.";
}

/** Issues the certificate: the fee rung up at the register in the payment picked (none when the fee is 0), the date fixed. */
export async function issueAppraisalFor(user: CurrentUser, id: string, fd: FormData | null): Promise<string> {
  await requireBaseWritable(user);
  const shopId = user.shopId;
  const a = await own(shopId, id);
  if (a.issuedAt) throw new UserError(`Certificate #${a.number} is already issued.`);
  if (a.valueCents <= 0) throw new UserError("Give the quilt its value first.");
  if (!a.appraiser) throw new UserError("Name the appraiser first (Settings for the usual one).");
  const asked = String(fd?.get("method") ?? "CASH");
  const method: TenderMethod = (TENDER_METHODS as string[]).includes(asked) ? (asked as TenderMethod) : "CASH";
  const at = new Date();
  const claimed = await db.appraisal.updateMany({ where: { id: a.id, shopId, issuedAt: null }, data: { issuedAt: at } });
  if (!claimed.count) throw new UserError("It was just issued.");
  if (a.feeCents <= 0) return `Certificate #${a.number} is issued.`;
  try {
    const sale = await completeSaleAs(user, {
      customerId: a.customerId,
      lines: [{ description: `Quilt appraisal #${a.number}: ${readDetails(a.details).title}`.slice(0, 200), qty: 1, unitPriceCents: a.feeCents, taxable: false }],
      tenders: [{ method, amountCents: a.feeCents, note: null }],
      note: `Quilt appraisal #${a.number}`,
      clientKey: `appraisal-${a.id}-${at.getTime()}`,
    });
    await db.appraisal.updateMany({ where: { id: a.id, shopId }, data: { saleId: sale.saleId } });
    return `Certificate #${a.number} is issued; the fee is sale #${sale.number}.`;
  } catch (e) {
    await db.appraisal.updateMany({ where: { id: a.id, shopId, saleId: null, issuedAt: at }, data: { issuedAt: null } });
    throw e;
  }
}

export async function saveAppraisalSettingsFor(user: CurrentUser, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  if (user.role === "TECH") throw new UserError("Only an owner or admin can change the appraisal fee.");
  const fee = toCents(str(fd.get("fee")) ?? "0");
  if (fee == null || fee < 0 || fee > 100_000) throw new UserError("The usual fee: dollars, like 75.");
  await db.shop.update({ where: { id: user.shopId }, data: { appraisalFeeCents: fee, appraiserName: str(fd.get("appraiser"))?.slice(0, 80) ?? null, appraiserCredential: str(fd.get("credential"))?.slice(0, 160) ?? null } });
  return "Saved.";
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

export async function appraisalsFor(shopId: string, customerId?: string) {
  const rows = await db.appraisal.findMany({ where: { shopId, ...(customerId ? { customerId } : {}) }, orderBy: { number: "desc" }, take: 200, select: { id: true, number: true, name: true, customerId: true, details: true, valueCents: true, issuedAt: true, createdAt: true } });
  return rows.map((r) => ({ ...r, title: readDetails(r.details).title }));
}

export async function appraisalView(shopId: string, id: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const a = await db.appraisal.findFirst({ where: { id, shopId }, include: { photos: { select: { id: true }, orderBy: { sortOrder: "asc" } } } });
  if (!a) return null;
  const sale = a.saleId ? await db.sale.findFirst({ where: { id: a.saleId, shopId }, select: { id: true, number: true } }) : null;
  return { ...a, quilt: readDetails(a.details), sale };
}

export async function appraisalPhoto(shopId: string, id: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  return db.appraisalPhoto.findFirst({ where: { id, shopId }, select: { mime: true, data: true } });
}
