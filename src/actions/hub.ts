"use server";

// The community hub: joining, syncing, manual links (add / fix / roll back / download), shared notes.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError, isUserError } from "@/lib/action";
import { requireAdmin, requireInstallAdmin, requireUser } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/shops";
import { str } from "@/lib/format";
import { byWhom, hubFetch, hubId, hubReachable, joinHub, leaveHub, parseInvite, reportUsageNextSync, saveLink, syncHub, usageSettingChanged, type HubLink, type LinkRevision } from "@/lib/hub";
import { libraryDir } from "@/lib/library-dir";
import { alreadyHave, downloadLink, DownloadFailed, haveIndex, NO_LIBRARY, reportLink } from "@/lib/manual-downloads";
import { requireHubWrites } from "@/lib/hub-writes";
import { actorOf, audit } from "@/lib/audit";

function refresh() {
  revalidatePath("/", "layout");
}

// The hub connection is shared by every company on this install: with several, only the StitchBench administrator
// joins or leaves (requireInstallAdmin).
export const joinCommunityHub = safe.whileLapsed("joinCommunityHub")(async function joinCommunityHub(formData: FormData) {
  const admin = await requireInstallAdmin();
  // Either the member invite (code or file contents) or the hub address + join key typed in.
  const invite = str(formData.get("invite"));
  const inv = invite ? parseInvite(invite) : { url: str(formData.get("url")), joinKey: str(formData.get("joinKey")), discord: null };
  if (!inv.url || !inv.joinKey) throw new UserError("Paste the invite, or enter the hub address and the join key.");
  const shop = await db.shop.findUniqueOrThrow({ where: { id: admin.shopId } });
  await joinHub(inv.url, inv.joinKey, shop.name, shop.email ?? admin.email);
  await audit(db, actorOf(admin), { action: "hub.join", subjectType: "Hub", subjectLabel: new URL(inv.url).host });
  if (inv.discord) await db.hubState.update({ where: { id: 1 }, data: { discordUrl: inv.discord } });
  await syncHub();
  refresh();
});

export const syncCommunityHub = safe.whileLapsed("syncCommunityHub")(async function syncCommunityHub() {
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
  const was = (await db.shop.findUniqueOrThrow({ where: { id: admin.shopId }, select: { shareUsage: true } })).shareUsage;
  await db.$transaction(async (tx) => {
    await tx.shop.update({ where: { id: admin.shopId }, data: { shareUsage: on === true } });
    if (was !== (on === true)) await audit(tx, actorOf(admin), { action: "hub.usage", subjectType: "Shop", subjectId: admin.shopId, subjectLabel: "Parts used shared with the community", changes: { shareUsage: [was, on === true] } });
  });
  // Sent (or taken back) with the next sync.
  usageSettingChanged(admin.shopId);
  revalidatePath("/parts/most-used");
});

export const leaveCommunityHub = safe.whileLapsed("leaveCommunityHub")(async function leaveCommunityHub() {
  const admin = await requireInstallAdmin();
  await leaveHub();
  await audit(db, actorOf(admin), { action: "hub.leave", subjectType: "Hub", subjectLabel: "StitchHub" });
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

// Each change names the person and the company making it (byWhom): the hub's history shows the company, not the install.
// requireHubWrites refuses a company whose sharing the StitchBench administrator switched off, and names the writer.
export const addManualLink = safe(async function addManualLink(formData: FormData) {
  const user = await requireUser();
  const byName = await requireHubWrites(user);
  const link = (await (await hubFetch("/v1/links", { method: "POST", json: { ...linkFields(formData), ...(await byWhom(user)), byName } })).json()) as HubLink;
  await saveLink(link);
  refresh();
});

export const editManualLink = safe(async function editManualLink(linkId: string, formData: FormData) {
  const user = await requireUser();
  const byName = await requireHubWrites(user);
  const link = (await (await hubFetch(`/v1/links/${hubId(linkId)}`, { method: "PUT", json: { ...linkFields(formData), ...(await byWhom(user)), byName } })).json()) as HubLink;
  await saveLink(link);
  refresh();
});

export const revertManualLink = safe(async function revertManualLink(linkId: string, revisionId: string) {
  const user = await requireUser();
  const byName = await requireHubWrites(user);
  const link = (await (await hubFetch(`/v1/links/${hubId(linkId)}/revert`, { method: "POST", json: { revisionId, ...(await byWhom(user)), byName } })).json()) as HubLink;
  await saveLink(link);
  refresh();
});

export const removeManualLink = safe(async function removeManualLink(linkId: string) {
  const user = await requireUser();
  const byName = await requireHubWrites(user);
  const link = (await (await hubFetch(`/v1/links/${hubId(linkId)}`, { method: "DELETE", json: { ...(await byWhom(user)), byName } })).json()) as HubLink;
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

/**
 * Fetch a linked manual from where it's published into <library>\_inbox, to be identified and filed. Links come from
 * other shops through the hub, so only public web servers are fetched (never the shop's own network), and the
 * download stops at the size limit.
 */
/**
 * Download one link into the library now: filed under Category\Brand with a LibraryDoc row when the link says enough
 * (category, brand, model, kind of manual), else into _inbox. A link already here is not fetched again.
 */
export const downloadManualLink = safe(async function downloadManualLink(linkId: string) {
  await requireUser();
  const root = libraryDir();
  if (!root) throw new UserError(NO_LIBRARY);
  const l = await db.manualLink.findUnique({ where: { id: linkId } });
  if (!l) throw new UserError("That link is gone. Sync with the hub and try again.");
  const have = await alreadyHave(l, root, await haveIndex());
  if (have) throw new UserError(`It's already in the library: ${have}`);
  try {
    await downloadLink(l, root);
  } catch (e) {
    if (e instanceof DownloadFailed && e.report) await reportLink(l.id);
    throw e;
  }
  refresh();
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
    isPlatformAdmin(user.email) || (own != null && own.shopId === user.shopId && (own.authorId === user.id || user.role !== "TECH")) || ((soleCompany || ownCompany) && user.role !== "TECH");
  if (!allowed) throw new UserError("Only whoever shared this note, or their shop's owner or admin, can remove it.");
  await hubFetch(`/v1/posts/${hubId(postId)}`, { method: "DELETE" });
  await db.hubPost.delete({ where: { id: postId } });
  await db.sharedPost.deleteMany({ where: { hubId: postId, shopId: own?.shopId ?? user.shopId } });
  refresh();
});
