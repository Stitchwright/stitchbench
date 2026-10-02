"use server";

// Staff shifts (scheduling-messaging-design.md 12.4): admins with Scheduling. The work is in src/lib/shifts.ts.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { copyWeekAs, deleteShiftAs, saveShiftAs } from "@/lib/shifts";

function refresh() {
  revalidatePath("/shifts", "layout");
  revalidatePath("/calendar", "layout");
  revalidatePath("/register");
  revalidatePath("/");
}

export const saveShift = safe(async function saveShift(shiftId: string | null, fd: FormData) {
  const user = await requireUser();
  await saveShiftAs(user, shiftId, fd);
  refresh();
});

export const deleteShift = safe(async function deleteShift(shiftId: string) {
  const user = await requireUser();
  await deleteShiftAs(user, shiftId);
  refresh();
});

/** "Copy last week" (or any week onto any other); then the target week. */
export const copyWeek = safe(async function copyWeek(fd: FormData) {
  const user = await requireUser();
  const r = await copyWeekAs(user, fd);
  refresh();
  redirect(`/shifts?week=${r.to}`);
});
