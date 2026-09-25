"use server";

// Partnerships: codes, the agreement's terms, ending, syncing, and settling statements.
import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { str, toCents } from "@/lib/format";
import { termsFromForm } from "@/lib/partner-terms";
import { createShopWithOwner, isPlatformAdmin } from "@/lib/shops";
import {
  acceptTerms,
  createPartnerInvite,
  endPartnership,
  monthPeriod,
  partnerLink,
  proposeTerms,
  redeemPartnerCode,
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
    const shop = await db.shop.findUniqueOrThrow({ where: { id: admin.shopId } });
    const side = str(formData.get("side")) === "retail" ? "retail" : "repair";
    const r = await createPartnerInvite(shop.id, shop.name, side, termsFromForm(formData));
    return { code: r.code, long: r.long, expiresAt: r.expiresAt };
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
}

export const enterPartnerCode = safe(async function enterPartnerCode(formData: FormData) {
  const admin = await requireAdmin();
  const code = str(formData.get("code"));
  if (!code) throw new UserError("Type or paste the partner code.");
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
  await acceptTerms(admin.shopId, linkId, name);
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
  refresh();
});

/** Record the payment that settles a month's statement; both shops see it. */
export const recordSettlement = safe(async function recordSettlement(linkId: string, formData: FormData) {
  const admin = await requireAdmin();
  const { from, to } = monthPeriod(str(formData.get("month")));
  const link = await partnerLink(admin.shopId, linkId);
  const st = await statementFor(admin.shopId, linkId, from, to);
  const amount = toCents(formData.get("amount"));
  if (amount == null || amount <= 0) throw new UserError("Enter the amount paid.");
  // Who paid whom, from the sewing shop's point of view: + it paid the repair shop.
  const direction = str(formData.get("direction"));
  const net = direction === "repair-paid" ? -amount : amount;
  const id = crypto.randomUUID();
  const summary = { ...st.totals, balanceBefore: st.balanceCents, method: str(formData.get("method")) };
  const at = new Date();
  await db.$transaction(async (tx) => {
    await tx.settlement.create({
      data: { id, shopId: admin.shopId, linkId, periodFrom: from, periodTo: to, netCents: net, summary, note: str(formData.get("note")), byName: admin.name, paidAt: at },
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
  const created = await createShopWithOwner({
    shopName: String(formData.get("shop") ?? ""),
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    kind: "retail",
  });
  const invite = await createPartnerInvite(repair.id, repair.name, "repair", termsFromForm(formData));
  const r = await redeemPartnerCode(created.id, created.name, str(formData.get("email")), invite.code);
  // Our side of the link now too, rather than on the next sync.
  await saveLinkFromHub(repair.id, "repair", r.link);
  refresh();
  revalidatePath("/companies");
});
