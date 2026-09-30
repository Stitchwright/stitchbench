"use server";

// Partnerships: codes, the agreement's terms, ending, syncing, and settling statements.
import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError, isUserError } from "@/lib/action";
import { requireAdmin, requireInstallAdmin, requireUser } from "@/lib/session";
import { str, toCents } from "@/lib/format";
import { termsFromForm } from "@/lib/partner-terms";
import { hubJoined } from "@/lib/hub";
import { createShopWithOwner, isPlatformAdmin } from "@/lib/shops";
import { normalizeEmail } from "@/lib/email";
import {
  acceptTerms,
  createPartnerInvite,
  endPartnership,
  monthPeriod,
  partnerLink,
  partnerQuota,
  proposeTerms,
  redeemPartnerCode,
  kickPartnerSync,
  saveLinkFromHub,
  sendToPartner,
  statementFor,
  syncPartners,
} from "@/lib/partners";

function refresh() {
  revalidatePath("/partners", "layout");
  revalidatePath("/repairs", "layout");
}

export type InviteResult = { code: string; long: string; expiresAt: string } | { error: string };

/** A code for the shop this one wants to partner with, carrying the terms offered. */
export async function makePartnerCode(formData: FormData): Promise<InviteResult> {
  try {
    const admin = await requireAdmin();
    partnerQuota(admin.shopId, "code", 20, "This company made a lot of partner codes in the last hour. Wait a while and try again.");
    const shop = await db.shop.findUniqueOrThrow({ where: { id: admin.shopId } });
    const side = str(formData.get("side")) === "retail" ? "retail" : "repair";
    const r = await createPartnerInvite(shop.id, shop.name, side, termsFromForm(formData));
    return { code: r.code, long: r.long, expiresAt: r.expiresAt };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

export const enterPartnerCode = safe(async function enterPartnerCode(formData: FormData) {
  const admin = await requireAdmin();
  const code = str(formData.get("code"));
  if (!code) throw new UserError("Type or paste the partner code.");
  partnerQuota(admin.shopId, "redeem", 10, "Too many partner codes tried in the last hour. Wait a while and try again.");
  // Not on a hub yet: the code would connect the whole install to one, which is the install administrator's call.
  if (!(await hubJoined())) await requireInstallAdmin();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: admin.shopId } });
  const r = await redeemPartnerCode(shop.id, shop.name, shop.email ?? admin.email, code);
  refresh();
  redirect(`/partners/${r.link.id}`);
});

export const acceptPartnerTerms = safe(async function acceptPartnerTerms(linkId: string, formData: FormData) {
  const admin = await requireAdmin();
  const name = str(formData.get("name"));
  if (!name) throw new UserError("Type your name to accept.");
  if (formData.get("agree") !== "on") throw new UserError("Tick the box to say you've read the terms.");
  // The version and terms on the page when it was read: newer ones that arrived meanwhile aren't accepted unseen.
  const shown = { version: Number(formData.get("version")) || null, key: str(formData.get("key")) };
  await acceptTerms(admin.shopId, linkId, name, shown);
  refresh();
});

export const proposePartnerTerms = safe(async function proposePartnerTerms(linkId: string, formData: FormData) {
  const admin = await requireAdmin();
  await proposeTerms(admin.shopId, linkId, termsFromForm(formData), admin.name);
  refresh();
});

export const endPartner = safe(async function endPartner(linkId: string, formData: FormData) {
  const admin = await requireAdmin();
  await endPartnership(admin.shopId, linkId, str(formData.get("note")));
  refresh();
});

export const syncPartnersNow = safe(async function syncPartnersNow() {
  await requireUser();
  const r = await syncPartners();
  if ("skipped" in r) throw new UserError("Nothing to sync yet: make or enter a partner code first.");
  if ("busy" in r) throw new UserError("Another sync is running right now. Try again in a minute.");
  refresh();
});

/** Record the payment that settles a month's statement; both shops see it. */
export const recordSettlement = safe(async function recordSettlement(linkId: string, formData: FormData) {
  const admin = await requireAdmin();
  const shopTz = (await db.shop.findUniqueOrThrow({ where: { id: admin.shopId }, select: { timeZone: true } })).timeZone;
  const { from, to } = monthPeriod(str(formData.get("month")), shopTz);
  const link = await partnerLink(admin.shopId, linkId);
  const st = await statementFor(admin.shopId, linkId, from, to);
  const amount = toCents(formData.get("amount"));
  if (amount == null || amount <= 0 || amount > 10_000_000) throw new UserError("Enter the amount paid.");
  // The shop that pays records it (the other shop sees it arrive), so one payment is never entered twice. From the
  // sewing shop's point of view: + it paid the repair shop.
  const net = link.side === "retail" ? amount : -amount;
  const id = crypto.randomUUID();
  const summary = { ...st.totals, balanceBefore: st.balanceCents, method: str(formData.get("method")) };
  const at = new Date();
  await db.$transaction(async (tx) => {
    await tx.settlement.create({
      data: { id, shopId: admin.shopId, linkId, periodFrom: from, periodTo: to, netCents: net, summary, note: str(formData.get("note")), byName: admin.name, paidAt: at, confirmedAt: at },
    });
    await sendToPartner(
      admin.shopId,
      link.id,
      "settle.paid",
      { id, periodFrom: from.toISOString(), periodTo: to.toISOString(), netCents: net, summary, note: str(formData.get("note")), name: admin.name, at: at.toISOString() },
      tx,
    );
  });
  refresh();
});

/** The partner says it paid: someone here confirms the money arrived, and only then does it come off the balance. */
export const confirmSettlement = safe(async function confirmSettlement(linkId: string, settlementId: string) {
  const admin = await requireAdmin();
  const r = await db.settlement.updateMany({ where: { shopId: admin.shopId, linkId, id: settlementId, confirmedAt: null }, data: { confirmedAt: new Date() } });
  if (!r.count) throw new UserError("That payment isn't waiting to be confirmed.");
  refresh();
});

/** Company settings: what this company does (repair bench, counter sales, or both), and its receipt line. */
export const saveCompanyMode = safe(async function saveCompanyMode(formData: FormData) {
  const admin = await requireAdmin();
  const doesRepair = formData.get("doesRepair") === "on";
  const sellsRetail = formData.get("sellsRetail") === "on";
  if (!doesRepair && !sellsRetail) throw new UserError("Pick at least one: repairs, or counter sales.");
  await db.shop.update({ where: { id: admin.shopId }, data: { doesRepair, sellsRetail, receiptNote: str(formData.get("receiptNote")) } });
  revalidatePath("/", "layout");
});

/**
 * A repair shop sets up StitchShop for a sewing shop it partners with, on this install: the company, its owner login,
 * and the partnership with the terms offered, all at once. Needs the StitchBench admin (who can add companies here)
 * and the hub (partners talk through it, even on the same install).
 */
export const setUpSewingShop = safe(async function setUpSewingShop(formData: FormData) {
  const admin = await requireAdmin();
  if (!isPlatformAdmin(admin.email)) throw new UserError("Only the StitchBench administrator of this install can add companies to it.");
  const hub = await db.hubState.findUnique({ where: { id: 1 } });
  if (!hub?.installKey) throw new UserError("Join the community hub first (Settings): partner shops talk through it.");
  const repair = await db.shop.findUniqueOrThrow({ where: { id: admin.shopId } });
  // The invite comes first: it needs the hub, so with the hub down nothing has been created yet (a retry isn't refused
  // for an email that already has an account). An email already in use is caught before the invite is spent on it.
  if (await db.user.findUnique({ where: { email: normalizeEmail(formData.get("email")) }, select: { id: true } })) throw new UserError("That email already has an account.");
  const invite = await createPartnerInvite(repair.id, repair.name, "repair", termsFromForm(formData));
  const created = await createShopWithOwner({
    shopName: String(formData.get("shop") ?? ""),
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    kind: "retail",
  });
  let r: Awaited<ReturnType<typeof redeemPartnerCode>>;
  try {
    r = await redeemPartnerCode(created.id, created.name, normalizeEmail(formData.get("email")), invite.code);
  } catch (e) {
    // The company and its login exist by now: the code is the way to finish, not the form again.
    refresh();
    revalidatePath("/companies");
    throw new UserError(
      `${created.name} was added, but the partnership wasn't made${isUserError(e) ? ` (${e.message})` : ""}. Ask them to sign in and enter this partner code under Partners: ${invite.code}`,
    );
  }
  // Our side of the link now too, rather than on the next sync.
  await saveLinkFromHub(repair.id, "repair", r.link);
  refresh();
  revalidatePath("/companies");
});

/** A message the hub refused goes back in the queue (after the cause is fixed, e.g. a partnership restored). */
export const resendPartnerMessage = safe(async function resendPartnerMessage(outboxId: string) {
  const admin = await requireAdmin();
  const m = await db.partnerOutbox.findFirst({ where: { id: outboxId, shopId: admin.shopId, sentAt: null } });
  if (!m) throw new UserError("That message isn't waiting any more.");
  await db.partnerOutbox.update({ where: { id: m.id }, data: { deadAt: null, nextTryAt: null, tries: 0 } });
  kickPartnerSync();
  refresh();
});
