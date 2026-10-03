"use server";

// Machines a sewing shop takes in for its partner repair shop, from the counter to the customer taking it home.
import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { fmtDay } from "@/lib/zoned";
import { shopTimeZone } from "@/lib/shop-zone";
import { safe, UserError, isUserError } from "@/lib/action";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireUser } from "@/lib/session";
import { modelKey, str, toCents } from "@/lib/format";
import { normalizeTerms } from "@/lib/partner-terms";
import { kickPartnerSync, MAX_MONEY, sendToPartner, type JobEvent } from "@/lib/partners";
import type { Prisma } from "@/generated/prisma/client";
import { sameText } from "@/lib/input";
import { answerRetailEstimate } from "@/lib/estimate-answer";
import { applyNotifyBy, needNotifyBy } from "@/lib/customer-input";
import { recordConsent } from "@/lib/messaging/consent";
import { isNotifyBy } from "@/components/notify-by-field";

const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);

function refresh(id?: string) {
  revalidatePath("/repairs");
  if (id) revalidatePath(`/repairs/${id}`);
  revalidatePath("/");
}

/** "Mary Smith" -> "Mary S." : all the repair shop needs to match the machine to the tag. */
function shortName(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

async function retailJob(shopId: string, id: string) {
  const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id } } });
  if (!j || j.side !== "retail") throw new UserError("Repair not found.");
  return j;
}

/** Take a machine in at the counter: the customer and their machine stay here; the repair shop gets the job. */
export async function takeInMachine(formData: FormData): Promise<{ id: string } | { error: string }> {
  try {
    const user = await requireUser();
    await requireBaseWritable(user); // new work: refused while the program is read-only
    const shopId = user.shopId;
    const linkId = str(formData.get("linkId"));
    const link = linkId ? await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id: linkId } } }) : null;
    if (!link || link.side !== "retail") throw new UserError("Pick the repair shop the machine goes to.");
    if (link.status !== "ACTIVE") throw new UserError(`The partnership with ${link.partnerName} has ended.`);

    // Everything is checked before anything is written, and a new customer is made in the same transaction as the job:
    // a refused intake leaves no customer behind for the corrected retry to duplicate.
    // Customer: an existing one, or a new one typed in.
    const pickedCustomerId = str(formData.get("customerId"));
    // "How should we tell them": a non-blank valid value, or none (blank keeps a picked customer's earlier answer). With
    // Marketing on and a channel ready, a customer who hasn't been asked yet must be asked now.
    const typedNotify = str(formData.get("notifyBy"));
    if (typedNotify != null && !isNotifyBy(typedNotify)) throw new UserError("Pick how to tell them.");
    const notifyBy = typedNotify;
    const needNotify = await needNotifyBy(shopId);
    let customerName: string;
    let newCustomer: { name: string; phone: string; email: string | null; notifyBy: string } | null = null;
    if (pickedCustomerId) {
      const c = await db.customer.findFirst({ where: { id: pickedCustomerId, shopId } });
      if (!c) throw new UserError("Customer not found.");
      if (needNotify && c.notifyBy === "" && !notifyBy) throw new UserError("Ask how they'd like to be told (text, email or a call).");
      customerName = c.name;
    } else {
      const name = str(formData.get("customerName"));
      const phone = str(formData.get("customerPhone"));
      if (!name || !phone) throw new UserError("Enter the customer's name and phone, so you can call them when it's ready.");
      if (needNotify && !notifyBy) throw new UserError("Ask how they'd like to be told (text, email or a call).");
      newCustomer = { name, phone, email: str(formData.get("customerEmail")), notifyBy: notifyBy ?? "" };
      customerName = name;
    }
    const brand = str(formData.get("brand"));
    const model = str(formData.get("model"));
    if (!brand || !model) throw new UserError("Enter the machine's brand and model.");
    const serial = str(formData.get("serial"));
    const problem = str(formData.get("problem"));
    if (!problem) throw new UserError("Say what's wrong with it, in the customer's words.");
    const accessories = formData.getAll("accessories").map(String).filter(Boolean);
    const otherAcc = str(formData.get("accessoriesOther"));
    if (otherAcc) accessories.push(...otherAcc.split(",").map((x) => x.trim()).filter(Boolean));
    const photos: { mime: string; data: Buffer }[] = [];
    for (const f of formData.getAll("photo")) {
      if (!(f instanceof File) || !f.size) continue;
      if (!IMAGE.has(f.type) || f.size > 2_000_000) throw new UserError("Photos must be pictures under 2 MB.");
      photos.push({ mime: f.type, data: Buffer.from(await f.arrayBuffer()) });
    }
    if (photos.length > 6) throw new UserError("Six photos at most.");
    // They travel to the repair shop inside one hub message (4 MB at most, and base64 grows them by a third).
    if (photos.reduce((a, p) => a + p.data.length, 0) > 2_600_000) throw new UserError("The photos are too large together. Take fewer, or smaller ones.");

    const terms = normalizeTerms(link.terms);
    const existing = serial ? await db.machine.findFirst({ where: { shopId, serial: sameText(serial), modelKey: modelKey(model) } }) : null;
    const id = crypto.randomUUID();
    const at = new Date();
    const machineType = str(formData.get("machineType"));
    const serviceRequested = str(formData.get("serviceRequested"));
    const preApprovedCents = toCents(formData.get("preApproved"));
    // Checked as the repair shop's install checks it: past that, it would refuse the job after the tag was printed.
    if (preApprovedCents != null && (preApprovedCents < 0 || preApprovedCents > MAX_MONEY)) throw new UserError("Check the pre-approved amount.");
    await db.$transaction(async (tx) => {
      let customerId: string;
      if (pickedCustomerId) {
        customerId = pickedCustomerId;
        if (notifyBy) await applyNotifyBy(tx, shopId, customerId, formData, user.id, "intake");
      } else {
        customerId = (await tx.customer.create({ data: { shopId, ...newCustomer! } })).id;
        if (notifyBy) await recordConsent(tx, { shopId, customerId, channel: "any", event: "notify_pref", source: "intake", detail: notifyBy, byUserId: user.id });
      }
      const machine = existing ?? (await tx.machine.create({ data: { shopId, brand, model, modelKey: modelKey(model), serial, machineType, customerId } }));
      const sh = await tx.shop.update({ where: { id: shopId }, data: { nextTagNumber: { increment: 1 } }, select: { nextTagNumber: true } });
      const tag = String(sh.nextTagNumber - 1);
      await tx.repairJob.create({
        data: {
          id,
          shopId,
          linkId: link.id,
          side: "retail",
          tag,
          customerId,
          machineId: machine.id,
          customerName: shortName(customerName),
          brand,
          model,
          serial,
          machineType,
          problem,
          serviceRequested,
          accessories,
          preApprovedCents,
          commissionPct: terms.repairCommissionPct,
          events: [{ at: at.toISOString(), status: "AT_SHOP_AWAITING_PICKUP", note: `Taken in by ${user.name}` }] as Prisma.InputJsonValue,
          createdAt: at,
        },
      });
      for (const p of photos) {
        await tx.machinePhoto.create({ data: { shopId, machineId: machine.id, kind: "CONDITION", caption: `At intake, tag ${tag}`, mime: p.mime, data: new Uint8Array(p.data) } });
      }
      await sendToPartner(
        shopId,
        link.id,
        "job.new",
        {
          id,
          tag,
          customerName: shortName(customerName),
          brand,
          model,
          serial,
          machineType,
          problem,
          serviceRequested,
          accessories,
          preApprovedCents,
          note: str(formData.get("note")),
          photos: photos.map((p) => ({ mime: p.mime, data: p.data.toString("base64"), caption: `At intake, tag ${tag}` })),
          at: at.toISOString(),
        },
        tx,
      );
    });
    refresh();
    return { id };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

/** The customer's answer to the repair shop's estimate. */
export const answerEstimate = safe(async function answerEstimate(jobId: string, approval: "APPROVED" | "DECLINED", formData: FormData) {
  const user = await requireUser();
  if (approval !== "APPROVED" && approval !== "DECLINED") throw new UserError("Approve or decline.");
  const job = await retailJob(user.shopId, jobId);
  if (job.status !== "WAITING_CUSTOMER_OK") throw new UserError("The repair shop isn't waiting for an answer on this one.");
  const approvedCents = approval === "APPROVED" ? (toCents(formData.get("approved")) ?? job.totalCents) : null;
  if (approvedCents != null && (approvedCents < 0 || approvedCents > MAX_MONEY)) throw new UserError("Check the approved amount.");
  const note = str(formData.get("note"));
  const at = new Date();
  // Recorded only if nobody answered first (an estimate link or a text reply may have): the job's history and the
  // message to the repair shop are written by answerRetailEstimate.
  const recorded = await db.$transaction((tx) => answerRetailEstimate(tx, { shopId: user.shopId, job, approval, approvedCents, note, byName: user.name, via: "counter", at }));
  if (!recorded) throw new UserError("The customer's answer is already recorded (maybe by link). Reload the page.");
  refresh(job.id);
});

/** The customer took the machine home without paying here (paid the repair shop, or nothing was owed). */
export const markPickedUp = safe.whileLapsed("markPickedUp")(async function markPickedUp(jobId: string) {
  const user = await requireUser();
  const job = await retailJob(user.shopId, jobId);
  if (job.pickedUpAt) return;
  if (!["READY_IN_TRUCK", "READY_FOR_PICKUP", "RETURNED_UNREPAIRED"].includes(job.status)) throw new UserError("It isn't back from the repair shop yet.");
  const at = new Date();
  const events = [...((job.events as JobEvent[]) ?? []), { at: at.toISOString(), status: "COLLECTED", note: `Handed back by ${user.name}` }];
  await db.$transaction(async (tx) => {
    await tx.repairJob.update({ where: { shopId_id: { shopId: user.shopId, id: job.id } }, data: { pickedUpAt: at, status: "COLLECTED", events: events as Prisma.InputJsonValue } });
    await sendToPartner(user.shopId, job.linkId, "job.pickedup", { id: job.id, at: at.toISOString() }, tx);
  });
  refresh(job.id);
});

/** The customer changed their mind before the repair shop collected the machine. */
export const cancelJob = safe(async function cancelJob(jobId: string, formData: FormData) {
  const user = await requireUser();
  const job = await retailJob(user.shopId, jobId);
  if (job.status !== "AT_SHOP_AWAITING_PICKUP") throw new UserError("The repair shop already has it. Ask them to send it back unrepaired.");
  // On a run the repair shop recorded as collected: it is in their truck even if their job.update hasn't arrived yet.
  const taken = await db.partnerRun.findFirst({ where: { shopId: user.shopId, linkId: job.linkId, collected: { has: job.id } }, select: { startsAt: true } });
  if (taken) throw new UserError(`It went to the repair shop on the run of ${fmtDay(taken.startsAt, await shopTimeZone(user.shopId))}. Ask them to send it back unrepaired.`);
  const note = str(formData.get("note"));
  const at = new Date();
  const events = [...((job.events as JobEvent[]) ?? []), { at: at.toISOString(), status: "RETURNED_UNREPAIRED", note: `Cancelled at the counter${note ? `: ${note}` : ""}` }];
  await db.$transaction(async (tx) => {
    await tx.repairJob.update({
      where: { shopId_id: { shopId: user.shopId, id: job.id } },
      data: { status: "RETURNED_UNREPAIRED", pickedUpAt: at, events: events as Prisma.InputJsonValue },
    });
    await sendToPartner(user.shopId, job.linkId, "job.cancel", { id: job.id, note, at: at.toISOString() }, tx);
  });
  refresh(job.id);
});

/** Repair shop: a note the sewing shop sees on the job (what's wrong, what it'll cost, when it's back). */
export const saveNoteForShop = safe(async function saveNoteForShop(ticketId: string, formData: FormData) {
  const user = await requireUser();
  const job = await db.repairJob.findFirst({ where: { shopId: user.shopId, ticketId, side: "repair" } });
  if (!job) throw new UserError("This ticket didn't come from a partner shop.");
  await db.repairJob.update({ where: { shopId_id: { shopId: user.shopId, id: job.id } }, data: { repairNote: str(formData.get("repairNote")) } });
  kickPartnerSync();
  revalidatePath(`/tickets/${ticketId}`);
});
