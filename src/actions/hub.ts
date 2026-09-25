"use server";

// The community hub: joining, syncing, manual links (add / fix / roll back / download), shared notes.
import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { hubFetch, joinHub, leaveHub, parseInvite, reportUsageNextSync, saveLink, syncHub, type HubLink, type LinkRevision } from "@/lib/hub";
import { libraryDir } from "@/lib/library-dir";

const UA = "StitchBench (manual download for a repair shop's own library)";
const MAX_PDF = 300 * 1024 * 1024;

function refresh() {
  revalidatePath("/", "layout");
}

export const joinCommunityHub = safe(async function joinCommunityHub(formData: FormData) {
  const admin = await requireAdmin();
  // Either the member invite (code or file contents) or the hub address + join key typed in.
  const invite = str(formData.get("invite"));
  const inv = invite ? parseInvite(invite) : { url: str(formData.get("url")), joinKey: str(formData.get("joinKey")), discord: null };
  if (!inv.url || !inv.joinKey) throw new UserError("Paste the invite, or enter the hub address and the join key.");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: admin.shopId } });
  await joinHub(inv.url, inv.joinKey, shop.name, shop.email ?? admin.email);
  if (inv.discord) await db.hubState.update({ where: { id: 1 }, data: { discordUrl: inv.discord } });
  await syncHub();
  refresh();
});

export const syncCommunityHub = safe(async function syncCommunityHub() {
  await requireUser();
  reportUsageNextSync();
  await syncHub();
  refresh();
});

export const leaveCommunityHub = safe(async function leaveCommunityHub() {
  await requireAdmin();
  await leaveHub();
  refresh();
});

// ---------- manual links ----------

function linkFields(formData: FormData) {
  const url = str(formData.get("url"));
  const brand = str(formData.get("brand"));
  const models = str(formData.get("models"));
  if (!brand || !models) throw new UserError("Enter the brand and model(s).");
  if (!url || !/^https?:\/\//i.test(url)) throw new UserError("The link must start with http:// or https://");
  return { brand, models, url, docType: str(formData.get("docType")), title: str(formData.get("title")), note: str(formData.get("note")) };
}

export const addManualLink = safe(async function addManualLink(formData: FormData) {
  const user = await requireUser();
  const link = (await (await hubFetch("/v1/links", { method: "POST", json: { ...linkFields(formData), byName: user.name } })).json()) as HubLink;
  await saveLink(link);
  refresh();
});

export const editManualLink = safe(async function editManualLink(linkId: string, formData: FormData) {
  const user = await requireUser();
  const link = (await (await hubFetch(`/v1/links/${linkId}`, { method: "PUT", json: { ...linkFields(formData), byName: user.name } })).json()) as HubLink;
  await saveLink(link);
  refresh();
});

export const revertManualLink = safe(async function revertManualLink(linkId: string, revisionId: string) {
  const user = await requireUser();
  const link = (await (await hubFetch(`/v1/links/${linkId}/revert`, { method: "POST", json: { revisionId, byName: user.name } })).json()) as HubLink;
  await saveLink(link);
  refresh();
});

export const removeManualLink = safe(async function removeManualLink(linkId: string) {
  const user = await requireUser();
  const link = (await (await hubFetch(`/v1/links/${linkId}`, { method: "DELETE", json: { byName: user.name } })).json()) as HubLink;
  await saveLink(link);
  refresh();
});

/** A link's versions, newest first (straight from the hub). */
export async function manualLinkHistory(linkId: string): Promise<{ revisions: LinkRevision[] } | { error: string }> {
  try {
    await requireUser();
    return { revisions: (await (await hubFetch(`/v1/links/${linkId}/history`)).json()) as LinkRevision[] };
  } catch (e) {
    return { error: e instanceof UserError ? e.message : "Couldn't load the history from the hub." };
  }
}

function inboxName(dir: string, wanted: string) {
  const base = wanted.replace(/\.pdf$/i, "").replace(/[^\w\-+.() ]+/g, "_").slice(0, 150) || "manual";
  let name = `${base}.pdf`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} (${i}).pdf`;
  return name;
}

/** Fetch a linked manual from where it's published into <library>\_inbox, to be identified and filed. */
export const downloadManualLink = safe(async function downloadManualLink(linkId: string) {
  await requireUser();
  const root = libraryDir();
  if (!root) throw new UserError("Downloading into the manual library works in the StitchBench program on the shop PC.");
  const l = await db.manualLink.findUnique({ where: { id: linkId } });
  if (!l) throw new UserError("That link is gone. Sync with the hub and try again.");
  const report = () => hubFetch(`/v1/links/${linkId}/report`, { method: "POST", json: { ok: false } }).catch(() => {});
  let r: Response;
  try {
    r = await fetch(l.url, { redirect: "follow", headers: { "User-Agent": UA, Accept: "application/pdf,*/*" }, signal: AbortSignal.timeout(180_000) });
  } catch {
    await report();
    throw new UserError("The site didn't answer. Open the link in a browser instead; if it's dead, fix the link for everyone.");
  }
  if (!r.ok) {
    await report();
    throw new UserError(`The site answered ${r.status}. Try the link in a browser; if it's dead, fix it for everyone.`);
  }
  if (Number(r.headers.get("content-length") ?? 0) > MAX_PDF) throw new UserError("That file is too large to download here.");
  const data = Buffer.from(await r.arrayBuffer());
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new UserError("That link opens a web page, not the PDF itself. Open it in a browser and save the manual from there.");
  }
  const inbox = path.join(root, "_inbox");
  await fs.promises.mkdir(inbox, { recursive: true });
  const name = inboxName(inbox, l.fileName ?? `${l.brand}_${l.models.replace(/,\s*/g, "+")}_${l.docType ?? "Manual"}`);
  await fs.promises.writeFile(path.join(inbox, name), data);
});

// ---------- shared notes ----------

export const removeHubPost = safe(async function removeHubPost(postId: string) {
  await requireUser();
  const p = await db.hubPost.findUnique({ where: { id: postId }, select: { mine: true } });
  if (!p?.mine) throw new UserError("Only the shop that shared a note can remove it.");
  await hubFetch(`/v1/posts/${postId}`, { method: "DELETE" });
  await db.hubPost.delete({ where: { id: postId } });
  await db.sharedPost.deleteMany({ where: { hubId: postId } });
  refresh();
});
