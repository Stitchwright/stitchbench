"use server";

// Layaway (tax-machine-sales-layaway-design.md section 4): the register's start, payment and pick-up (they return what
// the receipt link needs, or an error), the layaway page's cancel, and Settings → Layaway. Bodies in src/lib/layaway.ts.
import { revalidatePath } from "next/cache";
import { safe, isUserError } from "@/lib/action";
import { requireAdmin, requireUser } from "@/lib/session";
import { cancelLayawayAs, listLayaways, remindLayawayAs, payLayawayAs, pickUpLayawayAs, pickUpQuote, saveLayawaySettingsFor, startLayawayAs, type StartInput } from "@/lib/layaway";
import type { Tender } from "@/lib/register-math";
import { shopTimeZone } from "@/lib/shop-zone";
import { ymdOf } from "@/lib/zoned";

function refresh(id?: string) {
  revalidatePath("/register", "layout");
  revalidatePath("/layaways", "layout");
  revalidatePath("/units", "layout");
  revalidatePath("/parts", "layout");
  if (id) revalidatePath(`/layaways/${id}`);
  revalidatePath("/");
}

type Done = { saleId: string; number: number; layawayId?: string; layawayNumber?: number } | { error: string };

async function attempt(fn: () => Promise<Done>): Promise<Done> {
  try {
    return await fn();
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

export async function startLayaway(input: StartInput): Promise<Done> {
  return attempt(async () => {
    const r = await startLayawayAs(await requireUser(), input);
    refresh(r.layawayId);
    return { saleId: r.saleId, number: r.saleNumber, layawayId: r.layawayId, layawayNumber: r.number };
  });
}

export async function payLayaway(layawayId: string, amountCents: number, tender: Tender, clientKey: string | null): Promise<Done> {
  return attempt(async () => {
    const r = await payLayawayAs(await requireUser(), { layawayId, amountCents, tender, clientKey });
    refresh(layawayId);
    return { saleId: r.saleId, number: r.number };
  });
}

export async function pickUpLayaway(layawayId: string, tender: Tender | null, clientKey: string | null): Promise<Done> {
  return attempt(async () => {
    const r = await pickUpLayawayAs(await requireUser(), { layawayId, tender, clientKey });
    refresh(layawayId);
    return { saleId: r.saleId, number: r.number };
  });
}

/** The register's layaway panel: the customer's open layaways (or every open one), with what is left and today's pick-up total. */
export async function openLayaways(customerId: string | null) {
  const user = await requireUser();
  const rows = await listLayaways(user.shopId, "OPEN", customerId);
  const today = ymdOf(new Date(), await shopTimeZone(user.shopId));
  return Promise.all(
    rows.slice(0, 30).map(async (l) => ({
      id: l.id,
      number: l.number,
      customer: l.customer?.name ?? "",
      items: l.lines.map((x) => x.description).join(", "),
      paidCents: l.paidCents,
      leftCents: l.leftCents,
      behindCents: l.behindCents,
      // What to suggest: what they're behind, else the next planned payment (never more than is left).
      nextCents: Math.min(l.leftCents, l.plan.find((p) => p.due >= today)?.cents ?? l.leftCents),
      pickUpCents: (await pickUpQuote(user.shopId, l.id)).dueCents,
    })),
  );
}

export const cancelLayaway = safe(async function cancelLayaway(layawayId: string, formData: FormData) {
  const user = await requireAdmin();
  const refund = formData.get("refund") === "money" ? "money" : "credit";
  const r = await cancelLayawayAs(user, { layawayId, refund, method: String(formData.get("method") ?? "CASH"), reason: String(formData.get("reason") ?? "").trim() || null });
  refresh(layawayId);
  return r;
});

export const saveLayawaySettings = safe(async function saveLayawaySettings(formData: FormData) {
  const user = await requireAdmin();
  await saveLayawaySettingsFor(user, formData);
  revalidatePath("/settings/sales");
});

/** A friendly reminder about a payment, through the shop's messages (Marketing on). */
export const remindLayaway = safe(async function remindLayaway(layawayId: string) {
  const user = await requireUser();
  await remindLayawayAs(user, layawayId);
  revalidatePath(`/layaways/${layawayId}`);
});
