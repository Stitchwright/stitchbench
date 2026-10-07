"use server";

// Clubs (fabric-smarts-design.md section 4a, package F7): start and change a club, add members (card billing on the shop's
// own Stripe, or pay at pickup), the card link, pause, resume and cancel, and the monthly pick list. Bodies in
// src/lib/clubs.ts. Each is refused while the program key has lapsed (safe() with no exception: new membership work).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe, shownOnce } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { addMemberFor, cancelMemberFor, cardLinkFor, closeClubFor, markPaidFor, markPickDoneFor, takeBackPaidFor, pauseMemberFor, resumeMemberFor, saveClubFor, saveMemberFor, setMonthFor, undoPickFor } from "@/lib/clubs";

const refresh = (clubId?: string) => {
  revalidatePath("/fabric");
  if (clubId) revalidatePath(`/fabric/clubs/${clubId}`);
};

export const startClub = safe(async function startClub(formData: FormData) {
  const user = await requireAdmin();
  const r = await saveClubFor(user, null, formData);
  refresh();
  redirect(`/fabric/clubs/${r.id}`);
});

export const saveClub = safe(async function saveClub(clubId: string, formData: FormData) {
  const user = await requireAdmin();
  const r = await saveClubFor(user, clubId, formData);
  refresh(clubId);
  return noted(r.text);
});

export const closeClub = safe(async function closeClub(clubId: string, close: boolean) {
  const user = await requireUser();
  const text = await closeClubFor(user, clubId, close);
  refresh(clubId);
  return noted(text);
});

export const addClubMember = safe(async function addClubMember(clubId: string, formData: FormData) {
  const user = await requireUser();
  const text = await addMemberFor(user, clubId, formData);
  refresh(clubId);
  return noted(text);
});

export const saveClubMember = safe(async function saveClubMember(clubId: string, memberId: string, formData: FormData) {
  const user = await requireUser();
  const text = await saveMemberFor(user, memberId, formData);
  refresh(clubId);
  return noted(text);
});

/** The Stripe page for the member's card: shown to staff once (it is the customer's own payment page), never kept. */
export const startCardLink = safe(async function startCardLink(clubId: string, memberId: string) {
  const user = await requireUser();
  const url = await cardLinkFor(user, memberId);
  refresh(clubId);
  return shownOnce(url);
});

export const pauseMember = safe(async function pauseMember(clubId: string, memberId: string) {
  const user = await requireUser();
  const text = await pauseMemberFor(user, memberId);
  refresh(clubId);
  return noted(text);
});

export const resumeMember = safe(async function resumeMember(clubId: string, memberId: string) {
  const user = await requireUser();
  const text = await resumeMemberFor(user, memberId);
  refresh(clubId);
  return noted(text);
});

export const cancelMember = safe(async function cancelMember(clubId: string, memberId: string) {
  const user = await requireUser();
  const text = await cancelMemberFor(user, memberId);
  refresh(clubId);
  return noted(text);
});

export const setClubMonth = safe(async function setClubMonth(clubId: string, month: string, formData: FormData) {
  const user = await requireUser();
  const text = await setMonthFor(user, clubId, month, formData);
  refresh(clubId);
  return noted(text);
});

export const markPickDone = safe(async function markPickDone(clubId: string, memberId: string, month: string, formData: FormData) {
  const user = await requireUser();
  const text = await markPickDoneFor(user, clubId, memberId, month, formData);
  refresh(clubId);
  return noted(text);
});

export const undoPick = safe(async function undoPick(clubId: string, memberId: string, month: string) {
  const user = await requireUser();
  const text = await undoPickFor(user, clubId, memberId, month);
  refresh(clubId);
  return noted(text);
});

export const markMemberPaid = safe(async function markMemberPaid(clubId: string, memberId: string, month: string, formData: FormData) {
  const user = await requireUser();
  const text = await markPaidFor(user, clubId, memberId, month, formData);
  refresh(clubId);
  return noted(text);
});

export const takeBackMemberPaid = safe(async function takeBackMemberPaid(clubId: string, memberId: string, month: string) {
  const user = await requireAdmin();
  const text = await takeBackPaidFor(user, clubId, memberId, month);
  refresh(clubId);
  return noted(text);
});
