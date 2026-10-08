"use server";

// Shop hop passports (shop-features-round-2-design.md 4.6): on or off, the hops from the hub, start one, invite a shop,
// take part with a code, leave, stamp a passport, send what's waiting, the organizer's drawing. Bodies in
// src/lib/hops/hops.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe } from "@/lib/action";
import { isUserError } from "@/lib/user-error";
import { str } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { drawHopWinnerFor, hopNotPresentFor, inviteCodeFor, joinHopFor, leaveHopFor, refreshHopsFor, sendWaitingFor, setHopOnFor, stampFor, startHopFor, type StampResult } from "@/lib/hops/hops";

export const setHopOn = safe(async function setHopOn(on: boolean) {
  const user = await requireUser();
  await setHopOnFor(user, on);
  revalidatePath("/", "layout");
  return noted(on ? "Shop hops are on: Shop hop is in the menu." : "Shop hops are off.");
});

export const refreshHops = safe(async function refreshHops() {
  const user = await requireUser();
  await refreshHopsFor(user);
  revalidatePath("/hops");
});

export const startHop = safe(async function startHop(fd: FormData) {
  const user = await requireUser();
  const id = await startHopFor(user, { name: str(fd.get("name")) ?? "", startsOn: str(fd.get("startsOn")) ?? "", endsOn: str(fd.get("endsOn")) ?? "", ruleKind: str(fd.get("ruleKind")) ?? "all", ruleN: Number(str(fd.get("ruleN")) ?? "") });
  redirect(`/hops/${id}`);
});

export const makeHopInvite = safe(async function makeHopInvite(hopId: string) {
  const user = await requireUser();
  const code = await inviteCodeFor(user, hopId);
  return noted(`Send this code to the shop: ${code}. They type it on their Shop hop page under "Taking part in a hop?".`);
});

export const joinHop = safe(async function joinHop(fd: FormData) {
  const user = await requireUser();
  const id = await joinHopFor(user, str(fd.get("code")) ?? "");
  redirect(`/hops/${id}`);
});

export const leaveHop = safe(async function leaveHop(hopId: string) {
  const user = await requireUser();
  await leaveHopFor(user, hopId);
  revalidatePath("/hops");
});

/** "Stamp a passport": returns the words for the big tick (new work: refused while the program is read-only, by hand). */
export async function stampPassport(hopId: string, code: string): Promise<StampResult | { error: string }> {
  try {
    const user = await requireUser();
    const r = await stampFor(user, hopId, code);
    revalidatePath(`/hops/${hopId}`);
    return r;
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

export const sendWaitingStamps = safe(async function sendWaitingStamps(hopId: string) {
  const user = await requireUser();
  const n = await sendWaitingFor(user);
  revalidatePath(`/hops/${hopId}`);
  return noted(n ? `${n} stamp${n === 1 ? "" : "s"} sent to the hub.` : "The hub still can't be reached. They'll go on the next try.");
});

export const drawHopWinner = safe(async function drawHopWinner(hopId: string, fd: FormData) {
  const user = await requireUser();
  const d = await drawHopWinnerFor(user, hopId, str(fd.get("prize")) ?? "");
  revalidatePath(`/hops/${hopId}`);
  return noted(`${d.name}!`);
});

export const hopNotPresent = safe(async function hopNotPresent(hopId: string, drawId: string, prize: string) {
  const user = await requireUser();
  await hopNotPresentFor(user, hopId, drawId);
  const d = await drawHopWinnerFor(user, hopId, prize);
  revalidatePath(`/hops/${hopId}`);
  return noted(`Drawn again: ${d.name}!`);
});
