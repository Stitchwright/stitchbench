"use server";

// Live sales (shop-features-round-2-design.md 4.3): start one, today's show, claims, send each buyer her pay link, let
// unpaid claims go. Bodies in src/lib/live-sales.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { noted, safe, UserError } from "@/lib/action";
import { str, toCents } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { claimFor, dropClaimFor, letGoFor, resendBuyerFor, sendLinksFor, setPickFor, startLiveSaleFor, undropClaimFor } from "@/lib/live-sales";

const page = (id: string) => `/register/live/${id}`;

/** "2 3/8", "2.375", "1 1/2" or "3": a quantity typed the forgiving way. */
function qtyOf(raw: string | null): number {
  const t = (raw ?? "").trim();
  const m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t) ?? /^()(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[1] || 0) + Number(m[2]) / Number(m[3]);
  return Number(t || "1");
}

export const startLiveSale = safe(async function startLiveSale(formData: FormData) {
  const user = await requireUser();
  const id = await startLiveSaleFor(user, { name: str(formData.get("name")), holdHours: Number(str(formData.get("holdHours")) ?? 48) });
  redirect(page(id));
});

export const claimItem = safe(async function claimItem(saleId: string, formData: FormData) {
  const user = await requireUser();
  const priceRaw = str(formData.get("price"));
  const price = priceRaw ? toCents(priceRaw) : null;
  if (priceRaw && price == null) throw new UserError("Type the price like 12 or $12.00.");
  await claimFor(user, saleId, {
    partId: str(formData.get("partId")) ?? "",
    customerId: str(formData.get("customerId")),
    name: str(formData.get("name")),
    phone: str(formData.get("phone")),
    qty: qtyOf(str(formData.get("qty"))),
    priceCents: price,
  });
  revalidatePath(page(saleId));
});

export const setPick = safe(async function setPick(saleId: string, partId: string, on: boolean) {
  const user = await requireUser();
  await setPickFor(user, saleId, partId, on);
  revalidatePath(page(saleId));
});

export const dropClaim = safe(async function dropClaim(saleId: string, claimId: string) {
  const user = await requireUser();
  await dropClaimFor(user, claimId);
  revalidatePath(page(saleId));
});

export const undropClaim = safe(async function undropClaim(saleId: string, claimId: string) {
  const user = await requireUser();
  await undropClaimFor(user, claimId);
  revalidatePath(page(saleId));
});

export const sendLivePayLinks = safe(async function sendLivePayLinks(saleId: string) {
  const user = await requireUser();
  const told = await sendLinksFor(user, saleId);
  revalidatePath(page(saleId));
  revalidatePath("/register/live");
  return noted(told);
});

export const letGoClaims = safe(async function letGoClaims(saleId: string, webOrderId: string) {
  const user = await requireUser();
  await letGoFor(user, saleId, webOrderId);
  revalidatePath(page(saleId));
});

export const resendLiveLink = safe(async function resendLiveLink(saleId: string, webOrderId: string) {
  const user = await requireUser();
  const told = await resendBuyerFor(user, saleId, webOrderId);
  revalidatePath(page(saleId));
  return noted(told);
});
