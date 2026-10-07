"use server";

// Settings → Company → "Move this company" (company-move-design.md sections 7 and 8), and the hub's part of a move
// (package move-hub). Bodies: src/lib/move/export.ts, hub-step.ts, old-copy.ts. Every one works while the program is
// read-only (safe.whileLapsed): a lapsed company may leave, Cancel is what lifts the move's own freeze, the old copy's
// "The move is done" is made while it is frozen, re-pointing the hub is the connection itself, and deleting an old copy
// is the administrator's (their own company's standing is beside the point, as with setCompanyModule).
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { cancelMove, confirmMovedOut, startMove } from "@/lib/move/export";
import { repointHubFor } from "@/lib/move/hub-step";
import { deleteMovedCompany } from "@/lib/move/old-copy";
import { requirePlatformAdmin, requireUser } from "@/lib/session";
import { assertId } from "@/lib/input";

function refresh() {
  revalidatePath("/", "layout");
}

/** The owner confirms: the company is frozen and the file is ready to download. */
export const startCompanyMove = safe.whileLapsed("startCompanyMove")(async function startCompanyMove(fd: FormData) {
  const user = await requireUser();
  await startMove(user, user.shopId, { to: fd.get("to"), agreed: fd.get("agreed") === "on" });
  refresh();
});

/** Cancel the move: the freeze lifted, the company carries on here. */
export const cancelCompanyMove = safe.whileLapsed("cancelCompanyMove")(async function cancelCompanyMove() {
  const user = await requireUser();
  await cancelMove(user, user.shopId);
  refresh();
});

/** "The move is done" on the old copy, when the hub can't say so (design section 7). Owner only (the body checks). */
export const confirmCompanyMoved = safe.whileLapsed("confirmCompanyMoved")(async function confirmCompanyMoved() {
  const user = await requireUser();
  await confirmMovedOut(user, user.shopId);
  refresh();
});

/** "Re-point the hub" for a company that came here from a move file: its owner (Settings → Company) or the administrator (Companies). */
export const repointCompanyHub = safe.whileLapsed("repointCompanyHub")(async function repointCompanyHub(shopId: string) {
  const user = await requireUser();
  await repointHubFor(user, assertId(shopId));
  refresh();
});

/** Companies → Delete, for the old copy of a company that moved, 30 days on, its name typed (the administrator). */
export const removeMovedCompany = safe.whileLapsed("removeMovedCompany")(async function removeMovedCompany(fd: FormData) {
  const admin = await requirePlatformAdmin();
  await deleteMovedCompany(admin, fd.get("shopId"), fd.get("name"));
  revalidatePath("/companies");
});
