import "server-only";
// The hub's manual repository, program side (docs/plans/manual-repository-design.md sections 3, 5 and 6.2).
//   Offering: ONE library file at a time, only when a person chooses it and ticks the statement for that file. Nothing in
//   this module runs on its own for a file: the offer action is the only way a byte of a shop's library leaves the PC
//   (AGENTS.md: the sharing rule, chosen per item, never automatic). The hub says duplicate / blocked / refused / a slot
//   (POST /v1/repository/uploads), the file is PUT to R2 on the presigned URL (this host only: safe-fetch's storageUrlOk),
//   and the hub is told it was sent (POST .../sent) and checks the stored bytes itself. ManualOffer rows are the
//   company's list, refreshed from GET /v1/repository/uploads at each sync.
//   Reading: the repository's feed (/v1/repository/changes, its own cursor HubState.repoCursor) becomes ManualLink rows
//   with origin "repository" (id repo_<manual id>); a removal deletes the row, and for a copyright notice or a
//   withdrawal it marks the LibraryDoc that came from it (withdrawnAt) so the model page can say so. The program never
//   deletes a shop's file on its own (the owner's "Delete my copy" does, src/actions/manual-repository.ts).
//   Switch: the hub keeps uploads off until REPO_UPLOADS=on there; it answers 403 "The manual repository opens soon.",
//   and this program then says so and offers nothing (HubState.repoUploads "soon").
import crypto from "node:crypto";
import fs from "node:fs";
import { db } from "@/lib/db";
import { DOC_TYPES } from "@/lib/constants";
import { modelKey } from "@/lib/format";
import { hubFetch, hubId, hubJoined, hubState, hubStatus, inBackground, sameHub, writeState, type SyncRun } from "@/lib/hub";
import { requireHubWrites } from "@/lib/hub-writes";
import { resolveInLibrary } from "@/lib/library-dir";
import { putFile, storageUrlOk } from "@/lib/safe-fetch";
import type { CurrentUser } from "@/lib/session";
import { UserError } from "@/lib/user-error";
import { REPO_MAX_BYTES, SOON, STATEMENT_VERSION, checkPdfParts, sizeWords } from "@/lib/manual-offer-pure";

export { REPO_MAX_BYTES, SOON, STATEMENT, STATEMENT_VERSION, REVIEW_NOTE, checkPdfBytes, checkPdfParts, guessFields, sizeWords } from "@/lib/manual-offer-pure";

const MB = 1024 * 1024;

export const repoLinkId = (manualId: string) => `repo_${manualId}`;
export const isRepoLink = (l: { origin?: string | null }) => l.origin === "repository";

/** Free disk space the repository downloads leave alone (design 5.3: stop below 5 GB). REPO_MIN_FREE_BYTES sets it for the checks. */
export function minFreeBytes(): number {
  const n = Number(process.env.REPO_MIN_FREE_BYTES);
  return process.env.REPO_MIN_FREE_BYTES !== undefined && Number.isFinite(n) && n >= 0 ? n : 5 * 1024 * MB;
}

/** Free bytes on the disk holding `dir`, or null where the system won't say. */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

// ---------- what an offer says ----------

export type OfferFields = { category: string; brand: string; models: string; docType: string; year: number | null; language: string; title: string | null };

const text = (v: unknown, max: number) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** The dialog's fields checked and tidied, in the hub's own rules (a quick answer; the hub checks again). Throws a UserError. */
export function cleanFields(raw: Record<string, unknown>): OfferFields {
  const brand = text(raw.brand, 60);
  if (!brand) throw new UserError("Name the brand.");
  const models = String(raw.models ?? "")
    .split(/[,;]/)
    .map((m) => m.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 20);
  if (!models.length) throw new UserError("Name at least one model.");
  const docType = DOC_TYPES.find((d) => d.toLowerCase() === String(raw.docType ?? "").toLowerCase());
  if (!docType) throw new UserError(`Choose the kind of manual: ${DOC_TYPES.join(", ")}.`);
  const category = text(raw.category, 60);
  if (!category) throw new UserError("Choose the category (Sewing, Embroidery, Serger, Vacuum ...).");
  let year: number | null = null;
  const y = String(raw.year ?? "").trim();
  if (y) {
    year = Number(y);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) throw new UserError("The year isn't right (1900 to 2100, or leave it empty).");
  }
  return { category, brand, models: models.join(", "), docType, year, language: text(raw.language, 30) ?? "English", title: text(raw.title, 200) };
}

// ---------- who may offer ----------

/**
 * Who may offer, before anything is read or sent: OWNER and ADMIN always, TECH only when the owner switched
 * "Techs may offer manuals" on (strikes land on the owner's account); the company's hub writes must be on and not moving
 * (requireHubWrites; a lapsed company is refused by safe() before it gets here). Returns the name the hub records.
 */
export async function mayOffer(user: CurrentUser): Promise<string> {
  const byName = await requireHubWrites(user);
  if (user.role === "TECH") {
    const shop = await db.shop.findUnique({ where: { id: user.shopId }, select: { techsOfferManuals: true } });
    if (!shop?.techsOfferManuals) throw new UserError("Offering a manual to the repository is for the shop owner or an admin. The owner can allow techs in Settings → StitchHub.");
  }
  if (!(await hubJoined())) throw new UserError("Join the community hub first (Settings → StitchHub).");
  const st = (await hubState())?.repoUploads;
  if (st === "soon") throw new UserError(SOON);
  if (st === "none") throw new UserError("This hub doesn't have a manual repository.");
  return byName;
}

/** Whether this person may offer, for hiding the buttons (mayOffer says why not when it throws). */
export async function canOfferNow(user: CurrentUser): Promise<boolean> {
  if (user.role === "TECH") {
    const shop = await db.shop.findUnique({ where: { id: user.shopId }, select: { techsOfferManuals: true } });
    if (!shop?.techsOfferManuals) return false;
  }
  const s = await hubState();
  return Boolean(s?.url && s.installKey && s.scope === "member" && s.repoUploads !== "soon" && s.repoUploads !== "none");
}

// ---------- checking a file before it goes anywhere ----------

/** A library file chosen by its path: inside the library and not a private folder, a real PDF, small enough, not encrypted. */
export async function checkLibraryFile(root: string, rel: string): Promise<{ full: string; size: number }> {
  const full = resolveInLibrary(root, rel);
  if (!full) throw new UserError("That file isn't in the manual library (the business-notes and own-notes folders are never offered), so it can't be offered.");
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(full);
  } catch {
    throw new UserError("That file isn't in the library any more.");
  }
  if (!st.isFile()) throw new UserError("That isn't a file.");
  const fh = await fs.promises.open(full, "r");
  try {
    const head = Buffer.alloc(Math.min(65536, st.size));
    await fh.read(head, 0, head.length, 0);
    const tailLen = Math.min(65536, st.size);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, st.size - tailLen);
    checkPdfParts(head, tail, st.size);
  } finally {
    await fh.close();
  }
  return { full, size: st.size };
}

/** sha256 of a file, streamed (a manual can be 150 MB). */
export function sha256File(full: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(full)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

// ---------- the hub's side of an offer ----------

type Slot = { uploadId: string; putUrl: string; putHeaders: Record<string, string>; expiresAt: string };
export type SlotAnswer = { kind: "duplicate"; id: string; message: string } | { kind: "blocked"; message: string } | { kind: "slot"; slot: Slot };

/** The offer, to the hub: a slot, or in words why not. 403 "opens soon" is remembered (HubState.repoUploads) and thrown as a UserError. */
export async function requestSlot(shopId: string, byName: string, f: OfferFields, file: { sha256: string; sizeBytes: number; fileName: string }): Promise<SlotAnswer> {
  let j: { duplicate?: boolean; id?: string; blocked?: boolean; message?: string } & Partial<Slot>;
  try {
    const r = await hubFetch("/v1/repository/uploads", {
      method: "POST",
      shopRef: shopId,
      json: {
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        fileName: file.fileName,
        offered: { category: f.category, brand: f.brand, models: f.models.split(/,\s*/), docType: f.docType, year: f.year, language: f.language, title: f.title },
        statement: { version: STATEMENT_VERSION, accepted: true },
        byName,
      },
    });
    j = await r.json();
  } catch (e) {
    if (hubStatus(e) === 403 && /opens soon/i.test((e as Error).message)) {
      await db.hubState.updateMany({ where: { id: 1 }, data: { repoUploads: "soon", repoProbeAt: new Date() } });
      throw new UserError(SOON);
    }
    if (hubStatus(e) === 404) throw new UserError("This hub doesn't have a manual repository.");
    throw e;
  }
  await db.hubState.updateMany({ where: { id: 1 }, data: { repoUploads: "open" } });
  if (j.duplicate) return { kind: "duplicate", id: String(j.id ?? ""), message: j.message ?? "That file is already in the repository." };
  if (j.blocked) return { kind: "blocked", message: j.message ?? "That file was removed from the repository and can't be offered again." };
  if (!j.uploadId || !j.putUrl) throw new UserError("The hub didn't give an upload address. Try again later.");
  return { kind: "slot", slot: { uploadId: String(j.uploadId), putUrl: String(j.putUrl), putHeaders: (j.putHeaders ?? {}) as Record<string, string>, expiresAt: String(j.expiresAt ?? "") } };
}

type Sent = { state: string; reason?: string | null };

/** What the hub's states mean here. */
export function offerState(hub: string, was?: string): { state: string; keep?: boolean } {
  switch (hub) {
    case "slot":
    case "sent":
      return { state: was === "SENDING" || !was ? "SENDING" : was };
    case "pending":
      return { state: "WAITING" };
    case "approved":
      return { state: "PUBLISHED" };
    case "duplicate":
      return { state: "DUPLICATE" };
    case "removed":
      return { state: "REMOVED" };
    default: // refused, rejected
      return { state: "NOT_ACCEPTED" };
  }
}

async function tellSent(shopId: string, uploadId: string): Promise<Sent> {
  const r = await hubFetch(`/v1/repository/uploads/${hubId(uploadId)}/sent`, { method: "POST", shopRef: shopId, json: {} });
  return (await r.json()) as Sent;
}

const now = () => new Date();

async function recordSent(offerId: string, sent: Sent) {
  const st = offerState(sent.state, "SENDING");
  await db.manualOffer.updateMany({ where: { id: offerId }, data: { state: st.state, reason: sent.reason ?? null } });
}

// ---------- offering from the library (the Windows program and a self-hosted server) ----------

export type OfferResult = { id: string; state: string; message: string };

/**
 * Offer ONE library file. Every check first (who, the statement ticked for this file, the file itself), then the hub, then
 * the PUT in the background. Throws a UserError in words for anything the person can fix; the hub's answer duplicate /
 * blocked is a result, not an error (a row says so).
 */
export async function offerLibraryFile(user: CurrentUser, root: string, rel: string, raw: Record<string, unknown>, accepted: boolean, o: { background?: boolean } = {}): Promise<OfferResult> {
  const byName = await mayOffer(user);
  if (!accepted) throw new UserError("Tick the statement for this file first.");
  const f = cleanFields(raw);
  const { full, size } = await checkLibraryFile(root, rel);
  const sha256 = await sha256File(full);
  const fileName = rel.split("\\").pop() ?? "manual.pdf";
  await refuseRepeat(user.shopId, sha256);
  const answer = await requestSlot(user.shopId, byName, f, { sha256, sizeBytes: size, fileName });
  const base = { shopId: user.shopId, userId: user.id, byName, path: rel, fileName, sha256, sizeBytes: size, ...f, statementVersion: STATEMENT_VERSION, statementAt: now() };
  if (answer.kind === "duplicate") {
    const row = await db.manualOffer.create({ data: { ...base, state: "DUPLICATE", hubManualId: answer.id || null, reason: answer.message } });
    await noteRepositoryCopy(rel, answer.id, sha256);
    return { id: row.id, state: "DUPLICATE", message: answer.message };
  }
  if (answer.kind === "blocked") {
    const row = await db.manualOffer.create({ data: { ...base, state: "BLOCKED", reason: answer.message } });
    return { id: row.id, state: "BLOCKED", message: answer.message };
  }
  const row = await db.manualOffer.create({ data: { ...base, state: "SENDING", hubUploadId: answer.slot.uploadId } });
  const send = () => sendLibraryOffer(row.id, root, answer.slot);
  if (o.background === false) await send();
  else void inBackground(send).catch((e) => console.error("manual repository: sending an offer:", e instanceof Error ? e.message : e));
  return { id: row.id, state: "SENDING", message: "Sending to the repository. It waits for the hub owner's review before other shops can download it." };
}

/** The same file offered twice by one company: say so rather than ask the hub again. */
async function refuseRepeat(shopId: string, sha256: string) {
  const prior = await db.manualOffer.findFirst({ where: { shopId, sha256, state: { in: ["SENDING", "WAITING", "PUBLISHED", "DUPLICATE"] } }, select: { state: true } });
  if (prior) throw new UserError(prior.state === "SENDING" ? "You are already offering that file; it is being sent." : "Your company has already offered that file; see the offers list below.");
}

/** The library's copy knows it is the repository's (so the queue never downloads it back): its hash and the repository's id. */
async function noteRepositoryCopy(rel: string, manualId: string, sha256: string) {
  const data: { sha256: string; linkId?: string } = { sha256 };
  if (/^[A-Za-z0-9_-]{1,80}$/.test(manualId)) data.linkId = repoLinkId(manualId);
  await db.libraryDoc.updateMany({ where: { path: rel }, data });
}

/** PUT the file to its slot and say it was sent. A failure that isn't the hub's answer leaves the offer SENDING; the next sync tries again with a new slot. */
export async function sendLibraryOffer(offerId: string, root: string, slot?: Slot): Promise<string> {
  const offer = await db.manualOffer.findUnique({ where: { id: offerId } });
  if (!offer || offer.state !== "SENDING" || !offer.path) return offer?.state ?? "FAILED";
  const fail = async (reason: string) => {
    await db.manualOffer.update({ where: { id: offer.id }, data: { state: "FAILED", reason } });
    return "FAILED";
  };
  if (!slot) {
    // A retry from the background: whoever offered it must still be allowed to (techs may have been switched off, the
    // company's hub writes stopped or the hub left since).
    const by = offer.userId ? await db.user.findUnique({ where: { id: offer.userId }, select: { id: true, shopId: true, role: true, name: true, email: true, active: true } }) : null;
    if (!by || !by.active || by.shopId !== offer.shopId) return fail("The person who offered it can't offer manuals any more. Offer it again.");
    try {
      await mayOffer(by);
    } catch (e) {
      if (e instanceof UserError) return fail(e.message);
      return "SENDING"; // the hub not answering: the next sync asks again
    }
  }
  let chk: { full: string; size: number };
  try {
    chk = await checkLibraryFile(root, offer.path);
  } catch (e) {
    return fail(e instanceof UserError ? e.message : "The file couldn't be read.");
  }
  if (chk.size !== offer.sizeBytes || (await sha256File(chk.full)) !== offer.sha256) return fail("The file changed after it was chosen. Offer it again.");
  await db.manualOffer.update({ where: { id: offer.id }, data: { tries: { increment: 1 } } });
  try {
    let s = slot;
    if (!s) {
      const f = cleanFields({ ...offer });
      const a = await requestSlot(offer.shopId, offer.byName, f, { sha256: offer.sha256, sizeBytes: offer.sizeBytes, fileName: offer.fileName });
      if (a.kind === "duplicate") {
        await db.manualOffer.update({ where: { id: offer.id }, data: { state: "DUPLICATE", hubManualId: a.id || null, reason: a.message } });
        await noteRepositoryCopy(offer.path, a.id, offer.sha256);
        return "DUPLICATE";
      }
      if (a.kind === "blocked") {
        await db.manualOffer.update({ where: { id: offer.id }, data: { state: "BLOCKED", reason: a.message } });
        return "BLOCKED";
      }
      s = a.slot;
      await db.manualOffer.update({ where: { id: offer.id }, data: { hubUploadId: s.uploadId } });
    }
    const put = await putFile(s.putUrl, { headers: { ...s.putHeaders, "Content-Length": String(chk.size) }, file: chk.full, timeoutMs: 10 * 60_000 });
    if (put.status < 200 || put.status >= 300) throw new Error(`storage answered ${put.status}`);
    const sent = await tellSent(offer.shopId, s.uploadId);
    await recordSent(offer.id, sent);
    return offerState(sent.state, "SENDING").state;
  } catch (e) {
    // Not an answer (the network, storage down): stays SENDING with the reason; the next sync tries again, three times in all.
    const why = e instanceof Error ? e.message : String(e);
    const tries = (await db.manualOffer.findUnique({ where: { id: offer.id }, select: { tries: true } }))?.tries ?? 0;
    if (tries >= 3) return fail(`Couldn't send it after ${tries} tries: ${why}`);
    await db.manualOffer.update({ where: { id: offer.id }, data: { reason: `Will try again: ${why}` } });
    return "SENDING";
  }
}

// ---------- offering from a browser's own folder (hosted: no library on the server) ----------

/**
 * Hosted: the browser checked and hashed the file (it never reaches this server); this asks the hub for a slot and keeps
 * the row. The browser PUTs to R2 on the URL it gets back, then calls finishHostedOffer. The server re-checks what it can:
 * the fields, the size, the hash's shape; the hub checks the bytes.
 */
export async function hostedOfferStart(
  user: CurrentUser,
  raw: Record<string, unknown>,
  accepted: boolean,
  file: { sha256: string; sizeBytes: number; fileName: string; path?: string | null },
): Promise<{ id: string; state: string; message: string; put?: { url: string; headers: Record<string, string> } }> {
  const byName = await mayOffer(user);
  if (!accepted) throw new UserError("Tick the statement for this file first.");
  const f = cleanFields(raw);
  const sha256 = String(file.sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new UserError("The file's checksum is missing. Pick the file again.");
  const size = Math.floor(Number(file.sizeBytes));
  if (!Number.isFinite(size) || size < 8) throw new UserError("The file's size is missing. Pick the file again.");
  if (size > REPO_MAX_BYTES) throw new UserError(`That file is ${sizeWords(size)}; the repository takes up to ${sizeWords(REPO_MAX_BYTES)}.`);
  const fileName = (text(file.fileName, 200) ?? "manual.pdf").replace(/[\\/]+/g, "_");
  await refuseRepeat(user.shopId, sha256);
  const answer = await requestSlot(user.shopId, byName, f, { sha256, sizeBytes: size, fileName });
  const base = { shopId: user.shopId, userId: user.id, byName, path: text(file.path, 500), fileName, sha256, sizeBytes: size, ...f, statementVersion: STATEMENT_VERSION, statementAt: now() };
  if (answer.kind === "duplicate") {
    const row = await db.manualOffer.create({ data: { ...base, state: "DUPLICATE", hubManualId: answer.id || null, reason: answer.message } });
    return { id: row.id, state: "DUPLICATE", message: answer.message };
  }
  if (answer.kind === "blocked") {
    const row = await db.manualOffer.create({ data: { ...base, state: "BLOCKED", reason: answer.message } });
    return { id: row.id, state: "BLOCKED", message: answer.message };
  }
  if (!storageUrlOk(answer.slot.putUrl)) throw new UserError("The hub's upload address isn't one this program will send a file to.");
  const row = await db.manualOffer.create({ data: { ...base, state: "SENDING", hubUploadId: answer.slot.uploadId } });
  return { id: row.id, state: "SENDING", message: "Sending to the repository.", put: { url: answer.slot.putUrl, headers: answer.slot.putHeaders } };
}

/** The browser's PUT finished: tell the hub (it checks the stored file) and keep its answer. Another company's offer is "not found". */
export async function hostedOfferFinish(user: CurrentUser, offerId: string): Promise<OfferResult> {
  await mayOffer(user);
  const offer = await db.manualOffer.findFirst({ where: { id: offerId, shopId: user.shopId } });
  if (!offer || !offer.hubUploadId) throw new UserError("That offer was not found.");
  if (offer.state !== "SENDING") return { id: offer.id, state: offer.state, message: offer.reason ?? "" };
  const sent = await tellSent(user.shopId, offer.hubUploadId);
  await recordSent(offer.id, sent);
  const st = offerState(sent.state, "SENDING").state;
  return { id: offer.id, state: st, message: st === "NOT_ACCEPTED" ? (sent.reason ?? "The hub didn't accept that file.") : "Sent. It waits for the hub owner's review before other shops can download it." };
}

/** The browser couldn't send it (the PUT failed): the row says so instead of staying SENDING. */
export async function hostedOfferFail(user: CurrentUser, offerId: string, why: string): Promise<void> {
  await db.manualOffer.updateMany({ where: { id: offerId, shopId: user.shopId, state: "SENDING" }, data: { state: "FAILED", reason: text(why, 300) ?? "The browser couldn't send the file." } });
}

// ---------- the company's offers, from the hub ----------

/**
 * Bring this install's offers up to date from the hub (GET /v1/repository/uploads, one call per company that has a live
 * offer) and retry the ones whose sending was cut short. Never throws.
 */
export async function refreshOffers(root: string | null): Promise<void> {
  try {
    const open = await db.manualOffer.findMany({ where: { state: { in: ["SENDING", "WAITING", "PUBLISHED"] } }, select: { shopId: true }, distinct: ["shopId"] });
    for (const { shopId } of open) {
      const { uploads } = (await (await hubFetch("/v1/repository/uploads", { shopRef: shopId })).json()) as { uploads: { id: string; state: string; reason: string | null; manualId: string | null }[] };
      for (const u of uploads ?? []) {
        const row = await db.manualOffer.findFirst({ where: { shopId, hubUploadId: u.id } });
        if (!row) continue;
        // A local SENDING stays SENDING until the file was sent (the hub's "slot" means the same).
        if ((u.state === "slot" || u.state === "sent") && row.state !== "SENDING") continue;
        const st = offerState(u.state, row.state).state;
        const reason = u.reason ?? (st === "REMOVED" ? "Removed from the repository after a copyright notice." : null);
        if (st !== row.state || (u.manualId ?? null) !== row.hubManualId || (reason ?? null) !== (row.reason ?? null)) {
          await db.manualOffer.update({ where: { id: row.id }, data: { state: st, reason: st === "SENDING" ? row.reason : reason, hubManualId: u.manualId ?? row.hubManualId } });
        }
      }
    }
    if (root) {
      const stuck = await db.manualOffer.findMany({ where: { state: "SENDING", path: { not: null }, updatedAt: { lt: new Date(Date.now() - 3 * 60_000) } }, select: { id: true } });
      for (const s of stuck) await sendLibraryOffer(s.id, root);
    }
  } catch (e) {
    if (hubStatus(e) !== 404) console.error("manual repository: offers:", e instanceof Error ? e.message : e);
  }
}

export type OfferRow = Awaited<ReturnType<typeof offersFor>>[number];

/** This company's offers, newest first. */
export async function offersFor(shopId: string, take = 100) {
  return db.manualOffer.findMany({ where: { shopId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take });
}

export const OFFER_WORDS: Record<string, { label: string; tone: string }> = {
  SENDING: { label: "Sending", tone: "tone-wait" },
  WAITING: { label: "Waiting for review", tone: "tone-wait" },
  PUBLISHED: { label: "In the repository", tone: "tone-ready" },
  NOT_ACCEPTED: { label: "Not accepted", tone: "tone-bad" },
  DUPLICATE: { label: "Already there", tone: "tone-neutral" },
  BLOCKED: { label: "Can't be offered again", tone: "tone-bad" },
  REMOVED: { label: "Removed after a copyright notice", tone: "tone-bad" },
  FAILED: { label: "Couldn't be sent", tone: "tone-bad" },
};

// ---------- the feed ----------

export type RepoItem = {
  id: string;
  removed?: boolean;
  why?: string;
  category?: string | null;
  brand?: string;
  models?: string[] | string;
  modelKeys?: string[];
  docType?: string | null;
  year?: number | null;
  language?: string | null;
  title?: string | null;
  fileName?: string | null;
  sizeBytes?: number | null;
  pages?: number | null;
  sha256?: string | null;
  sha1?: string | null;
  sourceUrl?: string | null;
};

const idOk = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s);
const hex = (s: unknown, n: number) => (typeof s === "string" && new RegExp(`^[0-9a-f]{${n}}$`, "i").test(s) ? s.toLowerCase() : null);
const int = (v: unknown, max = 2_000_000_000) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : null);

export const WHY: Record<string, string> = { copyright: "removed from the repository after a copyright notice", withdrawn: "withdrawn from the repository" };

/** A page of the feed into ManualLink rows (one statement) and LibraryDoc marks. Rows with a bad id or no brand are skipped. */
export async function saveRepositoryItems(items: RepoItem[]): Promise<{ saved: number; removed: number }> {
  const gone = items.filter((m) => m && m.removed && idOk(m.id));
  const kept = items.filter((m) => m && !m.removed && idOk(m.id) && typeof m.brand === "string" && m.brand.trim());
  const rows = kept.map((m) => {
    const models = (Array.isArray(m.models) ? m.models : String(m.models ?? "").split(/,\s*/)).map((x) => String(x).trim()).filter(Boolean);
    const keys = (Array.isArray(m.modelKeys) && m.modelKeys.length ? m.modelKeys : models.map(modelKey)).map((k) => modelKey(String(k))).filter(Boolean);
    const brand = m.brand!.trim().slice(0, 80);
    const docType = typeof m.docType === "string" && m.docType ? m.docType.slice(0, 40) : null;
    return {
      id: repoLinkId(m.id),
      category: typeof m.category === "string" && m.category.trim() ? m.category.trim().slice(0, 80) : null,
      brand,
      models: models.join(", ").slice(0, 300),
      modelKeys: keys.slice(0, 30),
      docType,
      title: (typeof m.title === "string" && m.title.trim() ? m.title.trim() : `${brand} ${models[0] ?? ""} ${docType ?? "manual"}`.trim()).slice(0, 250),
      fileName: typeof m.fileName === "string" && m.fileName.trim() ? m.fileName.trim().slice(0, 200) : null,
      url: `stitchhub:repository/${m.id}`,
      source: "StitchHub repository",
      updatedAt: new Date().toISOString(),
      sizeBytes: int(m.sizeBytes),
      sha256: hex(m.sha256, 64),
      sha1: hex(m.sha1, 40),
      year: int(m.year, 2100),
      language: typeof m.language === "string" ? m.language.slice(0, 30) : null,
      pages: int(m.pages, 100000),
    };
  });
  if (rows.length) {
    await db.$executeRaw`
      INSERT INTO "ManualLink" (id, category, brand, models, "modelKeys", "docType", title, "fileName", url, source, status, "updatedAt", origin, "sizeBytes", sha256, sha1, year, language, pages)
      SELECT id, category, brand, models, "modelKeys", "docType", title, "fileName", url, source, 'ok', "updatedAt", 'repository', "sizeBytes", sha256, sha1, year, language, pages
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(id text, category text, brand text, models text, "modelKeys" text[], "docType" text, title text, "fileName" text,
        url text, source text, "updatedAt" timestamp, "sizeBytes" int, sha256 text, sha1 text, year int, language text, pages int)
      ON CONFLICT (id) DO UPDATE SET category = EXCLUDED.category, brand = EXCLUDED.brand, models = EXCLUDED.models, "modelKeys" = EXCLUDED."modelKeys",
        "docType" = EXCLUDED."docType", title = EXCLUDED.title, "fileName" = EXCLUDED."fileName", url = EXCLUDED.url, source = EXCLUDED.source, status = 'ok',
        "updatedAt" = EXCLUDED."updatedAt", "sizeBytes" = EXCLUDED."sizeBytes", sha256 = EXCLUDED.sha256, sha1 = EXCLUDED.sha1, year = EXCLUDED.year,
        language = EXCLUDED.language, pages = EXCLUDED.pages
      WHERE "ManualLink".origin = 'repository'`;
    // Restored after a counter-notice: a copy held here is no longer marked.
    await db.libraryDoc.updateMany({ where: { linkId: { in: rows.map((r) => r.id) }, withdrawnAt: { not: null } }, data: { withdrawnAt: null, withdrawnWhy: null } });
  }
  if (gone.length) {
    const ids = gone.map((m) => repoLinkId(m.id));
    await db.manualLink.deleteMany({ where: { id: { in: ids }, origin: "repository" } });
    await db.manualDownload.deleteMany({ where: { linkId: { in: ids }, status: "QUEUED" } });
    for (const m of gone) {
      if (m.why === "replaced") continue;
      await db.libraryDoc.updateMany({ where: { linkId: repoLinkId(m.id) }, data: { withdrawnAt: new Date(), withdrawnWhy: m.why === "copyright" ? "copyright" : "withdrawn" } });
    }
    // "replaced" (a better scan took its place): the copy here is as good as it was; nothing is marked.
  }
  return { saved: rows.length, removed: gone.length };
}

const PROBE_EVERY_MS = 60 * 60_000;

/** Asks the hub whether it takes offers, without making one: an empty request is refused 403 "opens soon" while uploads are off there, and is refused some other way (400) when they are on. */
async function probeUploads(run: SyncRun, s: { repoUploads: string | null; repoProbeAt: Date | null }) {
  if (s.repoProbeAt && Date.now() - s.repoProbeAt.getTime() < PROBE_EVERY_MS && s.repoUploads) return;
  let answer: string | null = null;
  try {
    await hubFetch("/v1/repository/uploads", { method: "POST", shopRef: null, json: {} });
    answer = "open";
  } catch (e) {
    const st = hubStatus(e);
    if (st === 403 && /opens soon/i.test((e as Error).message)) answer = "soon";
    else if (st === 404) answer = "none";
    else if (st >= 400 && st < 500 && st !== 429) answer = "open";
  }
  if (answer) await writeState(run, { repoUploads: answer, repoProbeAt: new Date() });
}

/**
 * The repository part of a sync (called from the hub sync after the links): whether the hub takes offers, the feed from
 * the repository's own cursor, the company's offers refreshed, and interrupted sends retried. A hub without a repository
 * (404) leaves everything as it was. Throws only for a feed that failed halfway, after keeping the pages it got.
 */
export async function pullRepository(run: SyncRun, root: string | null): Promise<{ items: number } | { none: true }> {
  const s = await hubState();
  if (!s?.url || !s.installKey) return { none: true };
  await probeUploads(run, s);
  let since = s.repoCursor ?? "0";
  let items = 0;
  for (let page = 0; page < 500; page++) {
    let ch: { manuals: RepoItem[]; next: string; more: boolean };
    try {
      ch = (await (await hubFetch(`/v1/repository/changes?since=${encodeURIComponent(since)}&limit=1000`)).json()) as typeof ch;
    } catch (e) {
      if (hubStatus(e) === 404) return { none: true };
      throw e;
    }
    if (!(await sameHub(run))) return { items };
    await saveRepositoryItems(ch.manuals ?? []);
    items += (ch.manuals ?? []).length;
    since = String(ch.next);
    if (!(await writeState(run, { repoCursor: since }))) return { items };
    if (!ch.more) break;
  }
  await refreshOffers(root);
  return { items };
}

// ---------- downloading one repository file ----------

/** The hub's short-lived URL for a repository manual (id: the ManualLink's, repo_<manual id>). The hub's answers 404 (removed) and 429 (slow down) keep their status. */
export async function repositoryUrl(linkId: string): Promise<{ url: string; sha256: string | null; sizeBytes: number | null }> {
  const manualId = linkId.replace(/^repo_/, "");
  const j = (await (await hubFetch(`/v1/repository/files/${hubId(manualId)}/url`, { method: "POST", json: {} })).json()) as { url?: string; sha256?: string; sizeBytes?: number };
  if (!j.url || !storageUrlOk(j.url)) throw new UserError("The hub gave a download address this program won't use. Try again later.");
  return { url: j.url, sha256: hex(j.sha256, 64), sizeBytes: int(j.sizeBytes) };
}

// ---------- "Delete my copy" ----------

/**
 * A copy the repository took down (marked withdrawnAt): the owner's own press of "Delete my copy" removes the file, its
 * sidecar and its row. Refuses a file that isn't marked, so the program never deletes a shop's manual on its own account.
 */
export async function deleteWithdrawnCopyAt(root: string, docPath: string): Promise<void> {
  const doc = await db.libraryDoc.findUnique({ where: { path: docPath } });
  if (!doc || !doc.withdrawnAt) throw new UserError("That manual isn't marked as removed from the repository, so it isn't deleted here.");
  const full = resolveInLibrary(root, doc.path);
  if (full) {
    await fs.promises.rm(full, { force: true });
    await fs.promises.rm(`${full}.json`, { force: true });
  }
  await db.libraryDoc.delete({ where: { path: doc.path } });
}

// ---------- totals for the confirm text of "Download everything" ----------

/** Repository files in these links not yet held (by link, or by hash), with their size: "1,240 files, about 4.4 GB". Database only; the queue itself checks the disk. */
export async function repositoryTotals(links: { id: string; origin: string; sha256: string | null; sha1: string | null; sizeBytes: number | null }[]): Promise<{ files: number; bytes: number }> {
  const repo = links.filter((l) => l.origin === "repository");
  if (!repo.length) return { files: 0, bytes: 0 };
  const have = await db.libraryDoc.findMany({ where: { OR: [{ linkId: { startsWith: "repo_" } }, { sha256: { not: null } }, { sha1: { not: null } }] }, select: { linkId: true, sha256: true, sha1: true } });
  const held = new Set(have.flatMap((d) => [d.linkId, d.sha256, d.sha1]).filter((x): x is string => !!x));
  let files = 0;
  let bytes = 0;
  for (const l of repo) {
    if (held.has(l.id) || (l.sha256 && held.has(l.sha256)) || (l.sha1 && held.has(l.sha1))) continue;
    files += 1;
    bytes += l.sizeBytes ?? 0;
  }
  return { files, bytes };
}
