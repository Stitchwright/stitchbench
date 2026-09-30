"use server";

// The community hub: joining, syncing, manual links (add / fix / roll back / download), shared notes.
import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError, isUserError } from "@/lib/action";
import { requireAdmin, requireInstallAdmin, requireUser } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/shops";
import { fetchPublic, TooLarge } from "@/lib/safe-fetch";
import { str } from "@/lib/format";
import { hubFetch, hubId, hubReachable, joinHub, leaveHub, parseInvite, reportUsageNextSync, saveLink, syncHub, usageSettingChanged, type HubLink, type LinkRevision } from "@/lib/hub";
import { libraryDir } from "@/lib/library-dir";

const UA = "StitchBench (manual download for a repair shop's own library)";
const MAX_PDF = 300 * 1024 * 1024;

function refresh() {
  revalidatePath("/", "layout");
}

// The hub connection is shared by every company on this install: with several, only the StitchBench administrator
// joins or leaves (requireInstallAdmin).
export const joinCommunityHub = safe(async function joinCommunityHub(formData: FormData) {
  const admin = await requireInstallAdmin();
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
  // A dead line says so in seconds, not after every request of a sync has waited out its time.
  await hubReachable();
  reportUsageNextSync();
  await syncHub();
  refresh();
});

/** Whether this company offers its monthly parts counts to the community's most-used list (owner or admin). */
export const setUsageSharing = safe(async function setUsageSharing(on: boolean) {
  const admin = await requireAdmin();
  await db.shop.update({ where: { id: admin.shopId }, data: { shareUsage: on === true } });
  // Sent (or taken back) with the next sync.
  usageSettingChanged(admin.shopId);
  revalidatePath("/parts/most-used");
});

export const leaveCommunityHub = safe(async function leaveCommunityHub() {
  await requireInstallAdmin();
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
  const link = (await (await hubFetch(`/v1/links/${hubId(linkId)}`, { method: "PUT", json: { ...linkFields(formData), byName: user.name } })).json()) as HubLink;
  await saveLink(link);
  refresh();
});

export const revertManualLink = safe(async function revertManualLink(linkId: string, revisionId: string) {
  const user = await requireUser();
  const link = (await (await hubFetch(`/v1/links/${hubId(linkId)}/revert`, { method: "POST", json: { revisionId, byName: user.name } })).json()) as HubLink;
  await saveLink(link);
  refresh();
});

export const removeManualLink = safe(async function removeManualLink(linkId: string) {
  const user = await requireUser();
  const link = (await (await hubFetch(`/v1/links/${hubId(linkId)}`, { method: "DELETE", json: { byName: user.name } })).json()) as HubLink;
  await saveLink(link);
  refresh();
});

/** A link's versions, newest first (straight from the hub). */
export async function manualLinkHistory(linkId: string): Promise<{ revisions: LinkRevision[] } | { error: string }> {
  try {
    await requireUser();
    return { revisions: (await (await hubFetch(`/v1/links/${hubId(linkId)}/history`)).json()) as LinkRevision[] };
  } catch (e) {
    return { error: isUserError(e) ? e.message : "Couldn't load the history from the hub." };
  }
}

function inboxName(dir: string, wanted: string) {
  const base = wanted.replace(/\.pdf$/i, "").replace(/[^\w\-+.() ]+/g, "_").slice(0, 150) || "manual";
  let name = `${base}.pdf`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} (${i}).pdf`;
  return name;
}

/**
 * Fetch a linked manual from where it's published into <library>\_inbox, to be identified and filed. Links come from
 * other shops through the hub, so only public web servers are fetched (never the shop's own network), and the
 * download stops at the size limit.
 */
export const downloadManualLink = safe(async function downloadManualLink(linkId: string) {
  await requireUser();
  const root = libraryDir();
  if (!root) throw new UserError("Downloading into the manual library works in the StitchBench program on the shop PC.");
  const l = await db.manualLink.findUnique({ where: { id: linkId } });
  if (!l) throw new UserError("That link is gone. Sync with the hub and try again.");
  const report = () => hubFetch(`/v1/links/${hubId(linkId)}/report`, { method: "POST", json: { ok: false } }).catch(() => {});
  let got: Awaited<ReturnType<typeof fetchPublic>>;
  try {
    got = await fetchPublic(l.url, { headers: { "User-Agent": UA, Accept: "application/pdf,*/*" }, timeoutMs: 180_000, maxBytes: MAX_PDF });
  } catch (e) {
    if (e instanceof TooLarge) throw new UserError("That file is too large to download here.");
    await report();
    throw new UserError(e instanceof Error && /private network|login in it|Only web/.test(e.message) ? `${e.message} It can't be downloaded here.` : "The site didn't answer. Open the link in a browser instead; if it's dead, fix the link for everyone.");
  }
  if (!got.response.ok || !got.body) {
    await report();
    throw new UserError(`The site answered ${got.response.status}. Try the link in a browser; if it's dead, fix it for everyone.`);
  }
  const data = got.body;
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new UserError("That link opens a web page, not the PDF itself. Open it in a browser and save the manual from there.");
  }
  const inbox = path.join(root, "_inbox");
  await fs.promises.mkdir(inbox, { recursive: true });
  const name = inboxName(inbox, l.fileName ?? `${l.brand}_${l.models.replace(/,\s*/g, "+")}_${l.docType ?? "Manual"}`);
  await fs.promises.writeFile(path.join(inbox, name), data, { flag: "wx" });
});

// ---------- shared notes ----------

export const removeHubPost = safe(async function removeHubPost(postId: string) {
  const user = await requireUser();
  const p = await db.hubPost.findUnique({ where: { id: postId }, select: { mine: true, shopRef: true } });
  if (!p?.mine) throw new UserError("Only the shop that shared a note can remove it.");
  // Same rule as before it reached the hub: its author, their shop's owner or admin, or the StitchBench administrator.
  const own = await db.sharedPost.findFirst({ where: { hubId: postId }, select: { shopId: true, authorId: true } });
  // With no local copy (an older backup was restored, or it was deleted while uploading), the owner or an admin of the
  // company can still remove it when this install holds just that one company.
  // The hub also says which company shared it, so that company's owner or admin can too on an install with several.
  const soleCompany = !own && (await db.shop.count()) === 1;
  const ownCompany = !own && p.shopRef === user.shopId;
  const allowed =
    isPlatformAdmin(user.email) ||
    (own != null && own.shopId === user.shopId && (own.authorId === user.id || user.role !== "TECH")) ||
    ((soleCompany || ownCompany) && user.role !== "TECH");
  if (!allowed) throw new UserError("Only whoever shared this note, or their shop's owner or admin, can remove it.");
  await hubFetch(`/v1/posts/${hubId(postId)}`, { method: "DELETE" });
  await db.hubPost.delete({ where: { id: postId } });
  await db.sharedPost.deleteMany({ where: { hubId: postId, shopId: own?.shopId ?? user.shopId } });
  refresh();
});
