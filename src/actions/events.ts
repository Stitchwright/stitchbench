"use server";

// Retreats, trunk shows and other events (shop-features-round-2-design.md 4.5): payments at the counter or by pay link,
// "Ask for the balances", a ticket at the door, check-in and the door prize drawing. Bodies in src/lib/events.ts.
import { revalidatePath } from "next/cache";
import { noted, safe, UserError } from "@/lib/action";
import { money, str, toCents } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { checkInFor, drawFor, notPresentFor, removeEventPaymentFor, sellDoorTicketFor, sendBalanceLinksFor, sendEventLinkFor, takeEventPaymentFor } from "@/lib/events";

function refresh(classId: string) {
  revalidatePath(`/classes/${classId}`);
  revalidatePath(`/classes/${classId}/door`);
  revalidatePath(`/classes/${classId}/lists`);
}

function typedCents(fd: FormData): number | null {
  const raw = str(fd.get("amount"));
  if (!raw) return null;
  const c = toCents(raw);
  if (c == null) throw new UserError("Type the amount like 150 or $150.00, or leave it empty.");
  return c;
}

export const takeEventPayment = safe(async function takeEventPayment(classId: string, enrollmentId: string, fd: FormData) {
  const user = await requireUser();
  const r = await takeEventPaymentFor(user, enrollmentId, { cents: typedCents(fd), method: str(fd.get("method")) ?? "CASH" });
  refresh(classId);
  revalidatePath("/register/sales");
  return noted(`${money(r.cents)} taken. It's in today's register sales.`);
});

export const sendEventLink = safe(async function sendEventLink(classId: string, enrollmentId: string, fd: FormData) {
  const user = await requireUser();
  const told = await sendEventLinkFor(user, enrollmentId, { cents: typedCents(fd), send: str(fd.get("send")) === "none" ? "none" : "usual" });
  refresh(classId);
  revalidatePath("/register/pay-links");
  return noted(told);
});

export const sendBalanceLinks = safe(async function sendBalanceLinks(classId: string) {
  const user = await requireUser();
  const told = await sendBalanceLinksFor(user, classId);
  refresh(classId);
  return noted(told);
});

export const removeEventPayment = safe(async function removeEventPayment(classId: string, paymentId: string) {
  const user = await requireUser();
  await removeEventPaymentFor(user, paymentId);
  refresh(classId);
});

export const sellDoorTicket = safe(async function sellDoorTicket(classId: string, fd: FormData) {
  const user = await requireUser();
  const name = await sellDoorTicketFor(user, classId, fd);
  refresh(classId);
  return noted(`Ticket sold to ${name}. She's checked in.`);
});

export const checkIn = safe(async function checkIn(classId: string, enrollmentId: string, on: boolean) {
  const user = await requireUser();
  await checkInFor(user, enrollmentId, on);
  refresh(classId);
});

export const drawName = safe(async function drawName(classId: string, fd: FormData) {
  const user = await requireUser();
  const d = await drawFor(user, classId, str(fd.get("prize")) ?? "");
  refresh(classId);
  return noted(`${d.name}!`);
});

export const notPresent = safe(async function notPresent(classId: string, drawId: string) {
  const user = await requireUser();
  const prize = await notPresentFor(user, drawId);
  const d = await drawFor(user, classId, prize);
  refresh(classId);
  return noted(`Drawn again: ${d.name}!`);
});
