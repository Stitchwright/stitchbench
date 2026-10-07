"use server";

// Classes and workshops (scheduling-messaging-design.md 12.1). Thin wrappers: who is asking, the work in
// src/lib/class-actions.ts (so the check script can drive it with a user), then the pages are refreshed.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import {
  addMeetingsAs,
  cancelEnrollmentAs,
  cancelMeetingAs,
  deleteClassAs,
  deleteMeetingAs,
  enrollAs,
  messageClassAs,
  moveUpAs,
  saveClassAs,
  saveMeetingAs,
  setClassStatusAs,
  setEnrollmentFeeAs,
  applyClassCreditAs,
} from "@/lib/class-actions";

function refresh(classId?: string | null, customerId?: string | null) {
  revalidatePath("/classes");
  revalidatePath("/classes/print");
  if (classId) {
    revalidatePath(`/classes/${classId}`);
    revalidatePath(`/classes/${classId}/roster`);
  }
  if (customerId) revalidatePath(`/customers/${customerId}`);
  revalidatePath("/register");
  revalidatePath("/");
}

/** A new class (with its first meeting and repeats) goes to its page; an edit stays. */
export const saveClass = safe(async function saveClass(classId: string | null, fd: FormData) {
  const user = await requireUser();
  const id = await saveClassAs(user, classId, fd);
  refresh(id);
  if (!classId) redirect(`/classes/${id}`);
});

export const addMeetings = safe(async function addMeetings(classId: string, fd: FormData) {
  const user = await requireUser();
  await addMeetingsAs(user, classId, fd);
  refresh(classId);
});

export const saveMeeting = safe(async function saveMeeting(meetingId: string, fd: FormData) {
  const user = await requireUser();
  refresh(await saveMeetingAs(user, meetingId, fd));
});

export const cancelMeeting = safe(async function cancelMeeting(meetingId: string, fd: FormData) {
  const user = await requireUser();
  refresh(await cancelMeetingAs(user, meetingId, fd));
});

export const deleteMeeting = safe(async function deleteMeeting(meetingId: string) {
  const user = await requireUser();
  refresh(await deleteMeetingAs(user, meetingId));
});

export const setClassStatus = safe(async function setClassStatus(classId: string, status: string, fd: FormData) {
  const user = await requireUser();
  await setClassStatusAs(user, classId, status, fd);
  refresh(classId);
});

export const deleteClass = safe(async function deleteClass(classId: string) {
  const user = await requireUser();
  await deleteClassAs(user, classId);
  refresh();
  redirect("/classes");
});

export const enroll = safe(async function enroll(classId: string, fd: FormData) {
  const user = await requireUser();
  const customerId = await enrollAs(user, classId, fd);
  refresh(classId, customerId);
});

export const cancelEnrollment = safe(async function cancelEnrollment(enrollmentId: string, fd: FormData) {
  const user = await requireUser();
  const r = await cancelEnrollmentAs(user, enrollmentId, fd);
  refresh(r.classId, r.customerId);
});

export const moveUp = safe(async function moveUp(enrollmentId: string, fd: FormData) {
  const user = await requireUser();
  const r = await moveUpAs(user, enrollmentId, fd);
  refresh(r.classId, r.customerId);
});

export const setEnrollmentFee = safe(async function setEnrollmentFee(enrollmentId: string, fd: FormData) {
  const user = await requireUser();
  const r = await setEnrollmentFeeAs(user, enrollmentId, fd);
  refresh(r.classId, r.customerId);
});

/** A seat paid with an owner's class that came with a machine (unitId), or (null) back to the class's price. */
export const applyClassCredit = safe(async function applyClassCredit(enrollmentId: string, unitId: string | null) {
  const user = await requireUser();
  const r = await applyClassCreditAs(user, enrollmentId, unitId);
  refresh(r.classId, r.customerId);
});

export const messageClass = safe(async function messageClass(classId: string, fd: FormData) {
  const user = await requireUser();
  await messageClassAs(user, classId, fd);
  refresh(classId);
});
