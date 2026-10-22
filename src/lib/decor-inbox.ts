import "server-only";
// The StitchFoundry inbox on the program's side (docs/plans/decorators-proposal.md, package D5 cloud inbox; the hub's side is
// StitchHub src/inbox.mjs): a designer sends an embroidery file from StitchFoundry through the shared Foundry Account, the file waits on
// the hub, and the shop takes it into a decorating order. The bytes go between this program and the hub's bucket; what comes back is
// somebody else's file, so it is checked (its size and SHA-256 against what the hub listed) before anything is made of it.
import crypto from "node:crypto";
import { hubFetch, hubJoined, hubStatus } from "@/lib/hub";
import { checkBucketUrl } from "@/lib/offsite/hub-store";
import { UserError } from "@/lib/user-error";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireModule } from "@/lib/modules";
import { MAX_DESIGN_BYTES } from "@/lib/embroidery-file";
import { addPlacementFor, adoptMockupFor, createOrderFor } from "@/lib/decor";
import type { CurrentUser } from "@/lib/session";

export type InboxMeta = { job?: string; customer?: string; garment?: string; placement?: string; notes?: string; due?: string; quantity?: number; stitches?: number; colors?: number; widthMm?: number; heightMm?: number; runMinutes?: number; threads?: string[]; design?: string; format?: string; hoop?: string; fabric?: string; trims?: number; colorChanges?: number; threadM?: number; bobbinM?: number };
/** A picture of the design that came with the file (PNG or JPEG). */
export type InboxPreview = { size: number; sha256: string; type: "image/png" | "image/jpeg" };
export type InboxItem = { id: string; fileName: string; size: number; sha256: string; meta: InboxMeta; preview: InboxPreview | null; createdAt: string; expiresAt: string };
/** ok: the list; not-joined: this install is on no hub; not-linked: this company isn't tied to a StitchHub account; not-offered: the hub has no inbox (an older hub, or the Foundry sign-in is off there); offline. */
export type InboxView = { state: "ok" | "not-joined" | "not-linked" | "not-offered" | "offline"; items: InboxItem[] };

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const whole = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
const real = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

/** What the hub said about a file, held to the shapes the hub promises (it is another computer's answer). */
export function cleanItemMeta(raw: unknown): InboxMeta {
  const r = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: InboxMeta = {};
  for (const k of ["job", "customer", "garment", "placement"] as const) {
    const v = text(r[k], 120);
    if (v) out[k] = v;
  }
  const notes = text(r.notes, 500);
  if (notes) out.notes = notes;
  if (typeof r.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.due)) out.due = r.due;
  const q = whole(r.quantity, 1, 100_000);
  if (q != null) out.quantity = q;
  const st = whole(r.stitches, 0, 5_000_000);
  if (st != null) out.stitches = st;
  const c = whole(r.colors, 1, 100);
  if (c != null) out.colors = c;
  const rm = whole(r.runMinutes, 0, 100_000);
  if (rm != null) out.runMinutes = rm;
  for (const k of ["widthMm", "heightMm"] as const) {
    const v = real(r[k], 0, 2000);
    if (v != null) out[k] = v;
  }
  for (const k of ["design", "hoop", "fabric"] as const) {
    const v = text(r[k], 120);
    if (v) out[k] = v;
  }
  if (typeof r.format === "string" && /^[a-z0-9]{2,8}$/i.test(r.format.trim())) out.format = r.format.trim().toLowerCase();
  const tr = whole(r.trims, 0, 100_000);
  if (tr != null) out.trims = tr;
  const cc = whole(r.colorChanges, 0, 1000);
  if (cc != null) out.colorChanges = cc;
  for (const k of ["threadM", "bobbinM"] as const) {
    const v = real(r[k], 0, 1_000_000);
    if (v != null) out[k] = v;
  }
  if (Array.isArray(r.threads)) {
    const t = r.threads.map((x) => text(x, 60)).filter(Boolean).slice(0, 100);
    if (t.length) out.threads = t;
  }
  return out;
}

function cleanItem(raw: unknown): InboxItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(r.id) ? r.id : null;
  const size = whole(r.size, 1, MAX_DESIGN_BYTES);
  const sha = typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) ? r.sha256 : null;
  const fileName = text(r.fileName, 120);
  if (!id || size == null || !sha || !fileName) return null;
  // A preview the hub described wrongly is left out; the file itself is still good.
  const pv = typeof r.preview === "object" && r.preview !== null ? (r.preview as Record<string, unknown>) : null;
  const psize = pv ? whole(pv.size, 1, MAX_PREVIEW_BYTES) : undefined;
  const psha = pv && typeof pv.sha256 === "string" && /^[0-9a-f]{64}$/.test(pv.sha256) ? pv.sha256 : null;
  const ptype: InboxPreview["type"] | null = pv?.type === "image/png" || pv?.type === "image/jpeg" ? pv.type : null;
  const preview = psize != null && psha && ptype ? { size: psize, sha256: psha, type: ptype } : null;
  return { id, fileName, size, sha256: sha, meta: cleanItemMeta(r.meta), preview, createdAt: text(r.createdAt, 40), expiresAt: text(r.expiresAt, 40) };
}

/** The files waiting for this company on the hub. Never throws: a hub that is down or has no inbox is a state, not an error. */
export async function inboxFor(shopId: string): Promise<InboxView> {
  if (!(await hubJoined())) return { state: "not-joined", items: [] };
  try {
    const r = await hubFetch(`/v1/inbox/list?shopRef=${encodeURIComponent(shopId)}`, { shopRef: shopId, quick: true });
    const j = (await r.json()) as { linked?: unknown; items?: unknown };
    if (j.linked !== true) return { state: "not-linked", items: [] };
    const items = (Array.isArray(j.items) ? j.items : []).map(cleanItem).filter((x): x is InboxItem => x !== null).slice(0, 100);
    return { state: "ok", items };
  } catch (e) {
    // 404: an older hub, or one where the Foundry sign-in is off, has no inbox. Anything else: not reachable just now.
    return { state: hubStatus(e) === 404 ? "not-offered" : "offline", items: [] };
  }
}

/** The file's bytes (and its preview's, if it has one and the hub gave an address) from the hub's bucket, held to the size and SHA-256 the hub listed. */
async function download(shopId: string, item: InboxItem): Promise<{ file: Uint8Array<ArrayBuffer>; preview: Uint8Array<ArrayBuffer> | null; previewNote: string }> {
  const a = (await (await hubFetch("/v1/inbox/get", { method: "POST", json: { shopRef: shopId, id: item.id }, shopRef: shopId })).json()) as { url?: unknown; previewUrl?: unknown };
  const r = await fetch(checkBucketUrl(a.url), { redirect: "manual", signal: AbortSignal.timeout(2 * 60_000) });
  if (!r.ok) throw new UserError(`The file store didn't give the file (${r.status}). Try again.`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length !== item.size || crypto.createHash("sha256").update(buf).digest("hex") !== item.sha256) throw new UserError("What came back isn't the file the hub listed (its size or checksum is different), so it wasn't used.");
  // The picture is a nicety: whatever goes wrong with it, the design itself is still taken, and the answer says the picture wasn't.
  let preview: Uint8Array<ArrayBuffer> | null = null;
  let previewNote = "";
  if (item.preview) {
    try {
      if (typeof a.previewUrl !== "string") throw new Error("no address");
      const pr = await fetch(checkBucketUrl(a.previewUrl), { redirect: "manual", signal: AbortSignal.timeout(60_000) });
      if (!pr.ok) throw new Error(`status ${pr.status}`);
      const pb = new Uint8Array(await pr.arrayBuffer());
      if (pb.length !== item.preview.size || crypto.createHash("sha256").update(pb).digest("hex") !== item.preview.sha256) throw new Error("checksum");
      preview = pb;
    } catch {
      previewNote = " The preview picture couldn't be fetched, so it wasn't used.";
    }
  }
  return { file: buf, preview, previewNote };
}

/** The decoration form's fields for a file: where it goes, and what StitchFoundry said (the file itself wins where it can be read). */
function placementForm(item: InboxItem, buf: Uint8Array<ArrayBuffer>, location: string): FormData {
  const m = item.meta;
  const fd = new FormData();
  fd.set("location", location);
  fd.set("method", "EMBROIDERY");
  fd.set("file", new File([buf], item.fileName));
  if (m.stitches) fd.set("stitches", String(m.stitches));
  if (m.colors) fd.set("colors", String(m.colors));
  if (m.widthMm != null) fd.set("width", String(m.widthMm));
  if (m.heightMm != null) fd.set("height", String(m.heightMm));
  const note = [m.job ? `StitchFoundry job ${m.job}` : "", m.design ? `Design: ${m.design}` : "", m.hoop ? `Hoop ${m.hoop}` : "", m.fabric ? `Fabric: ${m.fabric}` : "", m.threads?.length ? `Threads: ${m.threads.join(", ")}` : "", m.notes ?? ""].filter(Boolean).join(". ").slice(0, 300);
  if (note) fd.set("note", note);
  return fd;
}

const placeName = (v: FormData | string | null, item: InboxItem) => text(typeof v === "string" ? v : (v?.get("location") as string | null), 40) || item.meta.placement?.slice(0, 40) || "Left chest";

/**
 * Takes a waiting file into an order: an open order of the shop's (`orderId`), or a new one for the customer in `newOrder` (the form's
 * customer and title). The file is downloaded and checked, added as a decoration, and only then taken off the hub. If the hub can't be told,
 * the order stands and the file may show in the inbox again: the answer says so.
 */
export async function takeInboxItemFor(user: CurrentUser, itemId: string, target: { orderId: string | null; newOrder: FormData | null; location: string | null }): Promise<{ orderId: string; text: string }> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const shopId = user.shopId;
  const view = await inboxFor(shopId);
  if (view.state !== "ok") throw new UserError(view.state === "offline" ? "The hub can't be reached just now. Try again in a minute." : "There is no StitchFoundry inbox for this shop yet.");
  const item = view.items.find((i) => i.id === itemId);
  if (!item) throw new UserError("That file isn't in the inbox any more (someone took it, or it ran out).");
  const got = await download(shopId, item);
  const buf = got.file;
  let orderId = target.orderId;
  let made = "";
  if (!orderId) {
    if (!target.newOrder) throw new UserError("Pick an order, or start a new one.");
    const o = await createOrderFor(user, target.newOrder);
    orderId = o.id;
    made = `Started order #${o.number}. `;
  }
  const said = await addPlacementFor(user, orderId, placementForm(item, buf, placeName(target.location, item)));
  let picture = got.previewNote;
  if (got.preview) {
    try {
      const ext = item.preview?.type === "image/jpeg" ? "jpg" : "png";
      const base = item.fileName.replace(/\.[A-Za-z0-9]{2,4}$/, "") || "preview";
      picture = (await adoptMockupFor(user, orderId, `${base}-preview.${ext}`, got.preview)) ? " The preview picture was saved as the order's mock-up." : " The order already has a mock-up (or the picture isn't usable), so the preview picture wasn't used.";
    } catch {
      picture = " The preview picture couldn't be saved.";
    }
  }
  let told = "";
  try {
    await hubFetch("/v1/inbox/take", { method: "POST", json: { shopRef: shopId, id: item.id }, shopRef: shopId });
  } catch {
    told = " The hub couldn't be told it was taken, so the file may show in the inbox again: don't add it twice.";
  }
  return { orderId, text: `${made}${said}${picture}${told}` };
}
