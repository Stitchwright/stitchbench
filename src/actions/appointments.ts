"use server";

// Appointments and the calendar (scheduling-messaging-design.md 12.2). Thin wrappers: who is asking, the work in
// src/lib/appointment-actions.ts (so the check script can drive it), then the pages are refreshed.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { bookAs, rescheduleApptAs, saveApptTypeAs, setApptStatusAs } from "@/lib/appointment-actions";

function refresh(id?: string | null) {
  revalidatePath("/calendar");
  revalidatePath("/calendar/new");
  revalidatePath("/calendar/types");
  if (id) revalidatePath(`/calendar/appointments/${id}`);
  revalidatePath("/register");
  revalidatePath("/");
}

export const saveApptType = safe(async function saveApptType(typeId: string | null, fd: FormData) {
  const user = await requireUser();
  await saveApptTypeAs(user, typeId, fd);
  refresh();
});

/** Book (or block) a time; then the calendar on that day. */
export const book = safe(async function book(fd: FormData) {
  const user = await requireUser();
  const r = await bookAs(user, fd);
  refresh(r.id);
  redirect(`/calendar?date=${r.ymd}`);
});

export const rescheduleAppt = safe(async function rescheduleAppt(id: string, fd: FormData) {
  const user = await requireUser();
  const r = await rescheduleApptAs(user, id, fd);
  refresh(r.id);
});

export const setApptStatus = safe(async function setApptStatus(id: string, status: string, fd: FormData) {
  const user = await requireUser();
  await setApptStatusAs(user, id, status, fd);
  refresh(id);
});
