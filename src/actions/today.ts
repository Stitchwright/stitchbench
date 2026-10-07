"use server";

// The Today page (shop-features-round-2-design.md 7.5, 7.7): notes between stores.
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { markNotesReadFor, pinNoteFor, postNoteFor, removeNoteFor } from "@/lib/store-notes";

const refresh = () => revalidatePath("/today");

export const postNote = safe(async function postNote(formData: FormData) {
  const user = await requireUser();
  await postNoteFor(user, { to: String(formData.get("to") ?? "all"), text: String(formData.get("text") ?? ""), pinned: formData.get("pinned") === "on" });
  refresh();
});

export const pinNote = safe(async function pinNote(id: string, pinned: boolean) {
  const user = await requireUser();
  await pinNoteFor(user, String(id), pinned === true);
  refresh();
});

export const removeNote = safe(async function removeNote(id: string) {
  const user = await requireUser();
  await removeNoteFor(user, String(id));
  refresh();
});

export const markNotesRead = safe(async function markNotesRead(ids: string[]) {
  const user = await requireUser();
  await markNotesReadFor(user, Array.isArray(ids) ? ids.map(String) : []);
  refresh();
});
