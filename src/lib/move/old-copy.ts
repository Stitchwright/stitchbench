import "server-only";
// The old copy of a company that moved to another install (company-move-design.md section 7, package move-hub): it is
// read-only from the moment the move was confirmed, says where the company went once the hub (or the owner) says it
// moved, and is deleted by hand 30 days after that, never by itself. Hosted: Companies → Delete, by the StitchBench
// administrator, typing the company's name. Windows: the tray's "Remove the moved company..." (desktop/main.mjs, through
// /api/move/remove: the program's own door, with a one-use token as the move file's door has).
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { isPlatformAdmin } from "@/lib/shops";
import { fmtDate } from "@/lib/format";
import { deleteFrom, KEEP_MOVED_DAYS } from "./format";

/** Who deletes: the signed-in StitchBench administrator, or whoever runs the PC (the tray). */
export type Remover = { shopId: string; email: string } | "operator";

const NOT_FOUND = "Company not found.";

/** Whether the old copy may be deleted now, and from when. */
export function deletable(movedOutAt: Date | null, now = new Date()): { ok: boolean; from: Date | null } {
  if (!movedOutAt) return { ok: false, from: null };
  const from = deleteFrom(movedOutAt);
  return { ok: now.getTime() >= from.getTime(), from };
}

/**
 * Deletes the old copy of a company that moved: only one the hub (or its owner) said moved, only from 30 days after,
 * only with its name typed as it is, never the administrator's own. Everything of the company goes, including the rows
 * that have no foreign key to it (the partner messages it applied or set aside, the hub's listings and orders kept for
 * it): left behind, they would stop the company coming back to this install one day (a move never merges).
 */
export async function deleteMovedCompany(by: Remover, shopId: unknown, typedName: unknown, now = new Date()): Promise<{ name: string }> {
  if (by !== "operator" && !isPlatformAdmin(by.email)) throw new UserError(NOT_FOUND);
  const shop =
    typeof shopId === "string" && shopId && shopId.length <= 100 ? await db.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true, movedOutAt: true, timeZone: true } }) : null;
  if (!shop) throw new UserError(NOT_FOUND);
  if (!shop.movedOutAt) throw new UserError(`${shop.name} hasn't moved to another install. Only the old copy of a company that moved can be deleted here.`);
  const { ok, from } = deletable(shop.movedOutAt, now);
  if (!ok) {
    throw new UserError(
      `${shop.name} moved on ${fmtDate(shop.movedOutAt, shop.timeZone)}. Its old copy is kept ${KEEP_MOVED_DAYS} days in case the move has to be undone; it can be deleted from ${fmtDate(from!, shop.timeZone)}.`,
    );
  }
  if (by !== "operator" && by.shopId === shop.id) throw new UserError("You are signed in to this company. Sign in to another company first.");
  if (typeof typedName !== "string" || typedName.trim() !== shop.name.trim()) throw new UserError(`Type the company's name exactly as it is (${shop.name}) to delete it.`);
  const id = shop.id;
  await db.$transaction([
    // No foreign key to Shop on these two (package move-import's finding): they would outlive the company.
    db.partnerSeen.deleteMany({ where: { shopId: id } }),
    db.partnerFailure.deleteMany({ where: { shopId: id } }),
    // The hub's copies kept for it (a shopId without a foreign key): the hub sends them to the new install now.
    db.listing.deleteMany({ where: { shopId: id } }),
    db.marketOrder.deleteMany({ where: { shopId: id } }),
    // A machine can't go while a ticket or a stock unit names it; everything else goes with the company.
    db.ticket.deleteMany({ where: { shopId: id } }),
    db.stockUnit.deleteMany({ where: { shopId: id } }),
    db.shop.delete({ where: { id } }),
  ]);
  console.info(`[move] ${JSON.stringify({ company: id, deleted: shop.name, movedOut: shop.movedOutAt.toISOString(), by: by === "operator" ? "operator" : by.email })}`);
  return { name: shop.name };
}
