"use server";

// The hub's manual repository (docs/plans/manual-repository-design.md sections 3 and 5.4): offering ONE library file the
// person chose (the dialog's own submit: nothing here runs for a file on its own), the "Techs may offer manuals" switch,
// "Delete my copy" for a manual the repository took down, and the hosted install's browser paths. The hosted ones return
// data to the browser (a PUT address, a download address), so they are hand-rolled and gate themselves (BY_HAND in
// src/lib/lapse-allow.ts); the others are safe() actions.
import { revalidatePath } from "next/cache";
import { asCompany } from "@/lib/acting-company";
import { isUserError, noted, safe, UserError } from "@/lib/action";
import { db } from "@/lib/db";
import { lapseGuard } from "@/lib/lapse-guard";
import { libraryDir } from "@/lib/library-dir";
import { NO_LIBRARY } from "@/lib/manual-downloads";
import { deleteWithdrawnCopyAt, hostedOfferFail, hostedOfferFinish, hostedOfferStart, offerLibraryFile, repositoryUrl, type OfferResult } from "@/lib/manual-repository";
import { isInstallAdmin, requireAdmin, requireUser } from "@/lib/session";

function refresh() {
  revalidatePath("/", "layout");
}

const fieldsOf = (fd: FormData) => Object.fromEntries(["category", "brand", "models", "docType", "year", "language", "title"].map((k) => [k, fd.get(k)]));

/**
 * Offer one file from the shop PC's library: the dialog's submit, with the statement ticked for this file. The file is
 * read through resolveInLibrary (the private folders are refused), checked, hashed and sent in the background.
 */
export const offerManual = safe(async function offerManual(formData: FormData) {
  const user = await requireUser();
  const root = libraryDir();
  if (!root) throw new UserError(NO_LIBRARY);
  const rel = String(formData.get("path") ?? "");
  const r = await offerLibraryFile(user, root, rel, fieldsOf(formData), formData.get("accepted") === "on");
  refresh();
  return noted(r.message);
});

/** The owner's switch: techs may offer manuals (strikes land on the owner's account, so it is off until the owner says). */
export const setTechsOfferManuals = safe(async function setTechsOfferManuals(on: boolean) {
  const user = await requireUser();
  if (user.role !== "OWNER") throw new UserError("Only the shop owner can allow techs to offer manuals.");
  await db.shop.update({ where: { id: user.shopId }, data: { techsOfferManuals: on === true } });
  refresh();
});

/**
 * "Delete my copy": the manual was taken down (a copyright notice, or withdrawn) and this install's copy is marked. The
 * program never deletes a shop's file by itself; a person does, here, for one marked file. The sidecar goes with it.
 */
export const deleteWithdrawnCopy = safe(async function deleteWithdrawnCopy(docPath: string) {
  // The library is the install's, not one company's: its owner or admin, or with several companies its administrator.
  const user = await requireAdmin();
  if (!(await isInstallAdmin(user))) throw new UserError("Several companies share this StitchBench, so only its administrator can delete a manual from the library.");
  const root = libraryDir();
  if (!root) throw new UserError(NO_LIBRARY);
  await deleteWithdrawnCopyAt(root, docPath);
  refresh();
});

// ---------- hosted: the browser reads, hashes and sends the file itself ----------

type Out<T> = ({ ok: true } & T) | { ok?: false; error: string };

async function gated<T>(fn: (user: Awaited<ReturnType<typeof requireUser>>) => Promise<T>): Promise<Out<T>> {
  try {
    const user = await requireUser();
    await lapseGuard(user);
    const value = await asCompany(user.shopId, () => fn(user));
    return { ok: true, ...value };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

export type HostedOfferInput = {
  category: string;
  brand: string;
  models: string;
  docType: string;
  year?: string | number | null;
  language?: string;
  title?: string;
  accepted: boolean;
  sha256: string;
  sizeBytes: number;
  fileName: string;
  path?: string | null;
};

/** Hosted offer, step 1: the hub's answer and, for a slot, the address the browser PUTs the file to. */
export async function startHostedOffer(input: HostedOfferInput): Promise<Out<{ id: string; state: string; message: string; put?: { url: string; headers: Record<string, string> } }>> {
  return gated((user) => {
    const { accepted, sha256, sizeBytes, fileName, path, ...fields } = input;
    return hostedOfferStart(user, fields, accepted === true, { sha256, sizeBytes, fileName, path });
  });
}

/** Hosted offer, step 2: the browser's PUT is done; the hub checks the stored file. */
export async function finishHostedOffer(offerId: string): Promise<Out<OfferResult>> {
  return gated(async (user) => {
    const r = await hostedOfferFinish(user, String(offerId));
    refresh();
    return r;
  });
}

/** Hosted offer, step 2 when the PUT failed in the browser. */
export async function failHostedOffer(offerId: string, why: string): Promise<Out<{ done: true }>> {
  return gated(async (user) => {
    await hostedOfferFail(user, String(offerId), String(why));
    refresh();
    return { done: true as const };
  });
}

/** Hosted download: the hub's short-lived address for a repository manual (the browser fetches it and saves it into the tech's folder, else as a plain download). */
export async function repositoryDownloadInfo(linkId: string): Promise<Out<{ url: string; sha256: string | null; sizeBytes: number | null; fileName: string; brand: string; category: string | null }>> {
  return gated(async () => {
    const l = await db.manualLink.findUnique({ where: { id: String(linkId) } });
    if (!l || l.origin !== "repository") throw new UserError("That manual was not found. Sync with the hub and try again.");
    const t = await repositoryUrl(l.id);
    return { ...t, sha256: l.sha256 ?? t.sha256, fileName: l.fileName ?? `${l.brand}_${l.models.split(/,\s*/)[0]}_${l.docType ?? "Manual"}.pdf`, brand: l.brand, category: l.category };
  });
}
