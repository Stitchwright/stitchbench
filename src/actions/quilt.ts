"use server";
// The quilt planner's actions (shop-features-round-2-design.md 5.3): a pattern's yardage typed once from its back. The
// planner itself is a page; "Suggest coordinates" is in src/actions/assistant.ts with the other Assistant buttons.
import { revalidatePath } from "next/cache";
import { noted, safe, shownOnce } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { savePatternNeedsFor, threadMatchesFor } from "@/lib/quilt";

/** "Yardage on the back" on a pattern's page: the lines typed replace what was there. */
export const savePatternYardage = safe(async (partId: string, fd: FormData) => {
  const user = await requireUser();
  const n = await savePatternNeedsFor(user, partId, String(fd.get("needs") ?? ""));
  revalidatePath(`/parts/${partId}`);
  revalidatePath("/fabric/quilt");
  return noted(n ? `Saved ${n} line${n === 1 ? "" : "s"} of yardage.` : "Yardage cleared.");
});

/** "Thread to match" under the pull list: threads on the shelf that match each fabric (no Assistant, no allowance). */
export const threadsToMatch = safe(async (fabricIds: string[]) => {
  const user = await requireUser();
  return shownOnce(JSON.stringify(await threadMatchesFor(user.shopId, Array.isArray(fabricIds) ? fabricIds : [])));
});
