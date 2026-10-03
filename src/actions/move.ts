"use server";

// Settings → Company → "Move this company" (company-move-design.md sections 7 and 8). Bodies: src/lib/move/export.ts.
// Both work while the program is read-only (safe.whileLapsed): a lapsed company may leave, and Cancel is what lifts the
// move's own freeze. Owner only (the body checks; the platform administrator too).
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { cancelMove, startMove } from "@/lib/move/export";
import { requireUser } from "@/lib/session";

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
