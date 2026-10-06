import "server-only";
// The bodies of the Assistant's actions (src/actions/assistant.ts is a thin wrapper: who is signed in, revalidatePath),
// kept here so scripts/checks/assistant.check.ts can call them with a user and no web request. Each one is a button a
// person pressed; the signed-in company's rows only; a ticket or call of another company is "not found".
import { db } from "@/lib/db";
import { requireOn } from "@/lib/module-gate";
import type { CurrentUser } from "@/lib/session";
import { UserError } from "@/lib/user-error";
import { runAssistant } from "./client";
import { causeSources, ticketContext, voiceFor } from "./context";
import { DRAFT_KINDS, type DraftKind } from "./features";
import { buildCustomerMessage, buildLikelyCauses, buildPartnerNote, buildPlateRead, buildWriteUp, parsePlate, type Built, type Plate } from "./prompts";

const MAX_TEXT = 3000;

/** "Draft it": the shorthand typed in the field (not yet saved) as plain sentences, or the text of a message. Returns the log row's id. */
export async function draftText(user: CurrentUser, o: { ticketId: string; kind: string; shorthand?: string; instruction?: string }): Promise<string> {
  await requireOn(user, "assistant");
  if (!(DRAFT_KINDS as readonly string[]).includes(o.kind)) throw new UserError("That isn't something the Assistant drafts.");
  const k = o.kind as DraftKind;
  const ctx = await ticketContext(user.shopId, o.ticketId);
  const voice = await voiceFor(user.shopId);
  // A note to the sewing shop is for a ticket that is a partner's repair job (this company's, by its ticket).
  const job = k === "partner_note" ? await db.repairJob.findFirst({ where: { shopId: user.shopId, ticketId: o.ticketId, side: "repair" }, select: { id: true } }) : null;
  if (k === "partner_note" && !job) throw new UserError("This ticket isn't a partner shop's repair.");
  const opts = { shorthand: String(o.shorthand ?? "").slice(0, MAX_TEXT), instruction: o.instruction, firstName: ctx.firstName, totalCents: ctx.totalCents };
  const built: Built =
    k === "work_done" || k === "diagnosis"
      ? buildWriteUp(k, ctx.facts, voice, ctx.redaction, opts)
      : k === "partner_note"
        ? buildPartnerNote(ctx.facts, null, voice, ctx.redaction, opts)
        : buildCustomerMessage(k, ctx.facts, voice, ctx.redaction, opts);
  const { row } = await runAssistant({
    shopId: user.shopId,
    userId: user.id,
    built,
    target: { ticketId: o.ticketId, machineId: ctx.ids.machineId, ...(job ? { repairJobId: job.id } : {}) },
    serials: ctx.redaction.serials,
  });
  return row.id;
}

/** "What's likely wrong" (and "Ask again with what I found"): up to five causes with their sources. Returns the log row's id. */
export async function likelyCauses(user: CurrentUser, o: { ticketId: string; instruction?: string }): Promise<string> {
  await requireOn(user, "assistant");
  const ctx = await ticketContext(user.shopId, o.ticketId);
  const sources = await causeSources(user.shopId, ctx);
  const built = buildLikelyCauses(ctx.facts, sources, ctx.redaction, { instruction: o.instruction });
  const { row } = await runAssistant({ shopId: user.shopId, userId: user.id, built, target: { ticketId: o.ticketId, machineId: ctx.ids.machineId }, serials: ctx.redaction.serials });
  return row.id;
}

/** "Use this" / "Helped" (true), "Not useful" (false), on a call of this company; returns its ticket (to refresh). */
export async function markCall(user: CurrentUser, callId: string, accepted: boolean): Promise<string | null> {
  await requireOn(user, "assistant");
  const r = await db.assistantCall.updateMany({ where: { id: String(callId), shopId: user.shopId }, data: { accepted: accepted === true } });
  if (!r.count) throw new UserError("Answer not found.");
  return (await db.assistantCall.findFirst({ where: { id: String(callId), shopId: user.shopId }, select: { ticketId: true } }))?.ticketId ?? null;
}

/**
 * "Read the plate": one photo (shrunk in the browser) through the hub. Haiku first; when it was guessing, the same photo
 * goes once more to the stronger model. No module needed: the hub counts 20 free reads a month.
 */
export async function plateRead(user: Pick<CurrentUser, "id" | "shopId">, data: string, mediaType: string): Promise<{ plate: Plate; retried: boolean }> {
  const type = mediaType === "image/png" || mediaType === "image/webp" ? mediaType : "image/jpeg";
  const photo = { mediaType: type, data: String(data ?? "").replace(/^data:[^,]*,/, "") } as const;
  if (!/^[A-Za-z0-9+/=]{100,}$/.test(photo.data)) throw new UserError("Take the photo again: it didn't come through.");
  const brands = (await db.machine.groupBy({ by: ["brand"], where: { shopId: user.shopId }, _count: { brand: true }, orderBy: { _count: { brand: "desc" } }, take: 60 })).map((b) => b.brand);
  const mask = (text: string) => {
    const p = parsePlate(text);
    return p?.serial ? [p.serial] : [];
  };
  const first = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildPlateRead(brands, false), photo, needsModule: false, serialsFrom: mask });
  let plate = parsePlate(first.text);
  let retried = false;
  if (!plate?.sure) {
    retried = true;
    const second = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildPlateRead(brands, true), photo, needsModule: false, serialsFrom: mask }).catch(() => null);
    const better = second ? parsePlate(second.text) : null;
    if (better) plate = better;
  }
  if (!plate) throw new UserError("The Assistant couldn't read a make or model from that photo. Take it again, closer and straight on, or type them in.");
  return { plate, retried };
}

export async function saveSettings(user: Pick<CurrentUser, "shopId" | "role">, o: { draftOn: boolean; causesOn: boolean; plateOn: boolean; manualsOn?: boolean; offerFirstNames: boolean; voice: string | null }) {
  if (user.role === "TECH") throw new UserError("Only the shop owner or an admin can change this.");
  if ((o.voice ?? "").length > 900) throw new UserError("Keep the sample to a few sentences (900 characters).");
  const data = { ...o, voice: o.voice?.trim() || null };
  await db.assistantSettings.upsert({ where: { shopId: user.shopId }, create: { shopId: user.shopId, ...data }, update: data });
}
