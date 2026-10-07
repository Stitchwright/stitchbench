"use server";

// Pay links sent by staff (shop-features-round-2-design.md 1.3): make and send one, send it again, take it back.
// Bodies in src/lib/pay-links.ts.
import { revalidatePath } from "next/cache";
import { noted, safe, UserError } from "@/lib/action";
import { str, toCents } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { cancelPayLinkFor, makePayLinkFor, resendPayLinkFor, type PayLine } from "@/lib/pay-links";

/** The form's lines: description, amount, how many and taxed, one set per row (blank rows skipped). */
function linesOf(fd: FormData): PayLine[] {
  const what = fd.getAll("what").map((v) => String(v));
  const amounts = fd.getAll("amount").map((v) => String(v));
  const qtys = fd.getAll("qty").map((v) => String(v));
  const taxed = fd.getAll("taxed").map((v) => String(v));
  const out: PayLine[] = [];
  for (let i = 0; i < Math.max(what.length, amounts.length); i++) {
    const d = (what[i] ?? "").trim();
    const a = (amounts[i] ?? "").trim();
    if (!d && !a) continue;
    const cents = toCents(a);
    if (cents == null || cents <= 0) throw new UserError(`Line ${i + 1}: type the amount, like 25 or $25.00.`);
    if (!d) throw new UserError(`Line ${i + 1}: say what the ${a} is for.`);
    const q = Number((qtys[i] ?? "").trim() || "1");
    out.push({ description: d, unitPriceCents: cents, qty: Number.isFinite(q) && q > 0 ? q : 1, taxable: taxed.includes(String(i)) });
  }
  return out;
}

export const sendPayLink = safe(async function sendPayLink(formData: FormData) {
  const user = await requireUser();
  const r = await makePayLinkFor(user, {
    customerId: str(formData.get("customerId")),
    lines: linesOf(formData),
    note: str(formData.get("note")),
    send: str(formData.get("send")) === "none" ? "none" : "usual",
  });
  revalidatePath("/register/pay-links");
  return noted(`Pay link #${r.number} made. ${r.told}`);
});

export const resendPayLink = safe(async function resendPayLink(id: string) {
  const user = await requireUser();
  const told = await resendPayLinkFor(user, id);
  revalidatePath("/register/pay-links");
  return noted(told);
});

export const cancelPayLink = safe(async function cancelPayLink(id: string) {
  const user = await requireUser();
  await cancelPayLinkFor(user, id);
  revalidatePath("/register/pay-links");
});
