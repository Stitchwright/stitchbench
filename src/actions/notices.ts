"use server";

// Automatic notices, by hand (scheduling-messaging-design.md section 9.5): record a notice given by hand, send the ready
// or uncollected-machine notice now, and "It's back at the counter" for a partner job. Gates per 6.3: only sendNoticeNow
// needs Marketing; the others are counter work and custody records, so they always work.
import { revalidatePath } from "next/cache";
import { safe, UserError, isUserError } from "@/lib/action";
import { assertId } from "@/lib/input";
import { str } from "@/lib/format";
import { requireAdmin, requireUser } from "@/lib/session";
import { requireOn } from "@/lib/module-gate";
import { recordBack, recordManual, sendNow, type NoticeTarget } from "@/lib/notices/hooks";

function refresh(target: { ticketId?: string | null; jobId?: string | null }) {
  if (target.ticketId) revalidatePath(`/tickets/${target.ticketId}`);
  if (target.jobId) revalidatePath(`/repairs/${target.jobId}`);
  revalidatePath("/repairs");
  revalidatePath("/messages", "layout");
  revalidatePath("/");
}

/** Exactly one of a ticket or a partner job, as plain ids (checked against the shop by the work itself). */
function targetOf(t: { ticketId?: string; jobId?: string }): NoticeTarget {
  if (!t || (!t.ticketId === !t.jobId)) throw new UserError("Not found.");
  return t.ticketId ? { ticketId: assertId(t.ticketId) } : { jobId: assertId(t.jobId) };
}

/** A notice given by hand (a letter, certified mail, a call): kept as proof. No module check. */
export const recordManualNotice = safe(async function recordManualNotice(target: { ticketId?: string; jobId?: string }, fd: FormData) {
  const user = await requireUser();
  const t = targetOf(target);
  await recordManual(user, t, { stage: str(fd.get("stage")), how: str(fd.get("how")), date: str(fd.get("date")), text: str(fd.get("text")), tracking: str(fd.get("tracking")) });
  refresh(t);
});

/** Send the ready notice again, or the uncollected-machine notice that is due now (an owner or admin). Needs Marketing. */
export const sendNoticeNow = safe(async function sendNoticeNow(target: { ticketId?: string; jobId?: string }, kind: "ready" | "abandon") {
  const user = kind === "abandon" ? await requireAdmin() : await requireUser();
  await requireOn(user, "marketing");
  if (kind !== "ready" && kind !== "abandon") throw new UserError("Not found.");
  const t = targetOf(target);
  await sendNow(user, t, kind);
  refresh(t);
});

/** "It's back at the counter" for one partner job. Returns the line to show ("Recorded. A text goes to ..."). */
export async function markBackAtCounter(jobId: string): Promise<{ ok: true; note: string } | { error: string }> {
  try {
    const user = await requireUser();
    const id = assertId(jobId);
    const note = await recordBack(user, [id], { single: true });
    refresh({ jobId: id });
    return { ok: true, note };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

/** The same for the jobs ticked on /repairs ("These are back"), at most 100. */
export async function markManyBack(fd: FormData): Promise<{ ok: true; note: string } | { error: string }> {
  try {
    const user = await requireUser();
    const ids = [...new Set(fd.getAll("jobIds").map((v) => assertId(v)))];
    if (!ids.length) throw new UserError("Tick the ones that are back.");
    if (ids.length > 100) throw new UserError("Pick at most 100 at a time.");
    const note = await recordBack(user, ids, { single: false });
    refresh({});
    return { ok: true, note };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}
