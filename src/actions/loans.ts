"use server";

// Loaner and demo machines (shop-features-round-2-design.md 1.7): lend one (its deposit rung up: returns what the
// receipt link needs, or an error), mark it back, set what a machine is for, the loaner settings. Bodies in src/lib/loans.ts.
import { revalidatePath } from "next/cache";
import { isUserError, noted, safe } from "@/lib/action";
import { str, toCents } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { backFor, lendFor, saveLoanerSettingsFor, setUnitUseFor, type LendInput } from "@/lib/loans";

function refresh() {
  revalidatePath("/units", "layout");
  revalidatePath("/tickets", "layout");
  revalidatePath("/customers", "layout");
  revalidatePath("/");
}

export async function lendMachine(input: LendInput): Promise<{ loanId: string; saleId: string | null; number: number | null } | { error: string }> {
  try {
    const r = await lendFor(await requireUser(), input);
    refresh();
    return { loanId: r.loanId, saleId: r.saleId, number: r.saleNumber };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}

export const loanBack = safe(async function loanBack(loanId: string, formData: FormData) {
  const keep = str(formData.get("keep"));
  const r = await backFor(await requireUser(), loanId, { conditionBack: str(formData.get("conditionBack")), keepCents: keep ? toCents(keep) : 0, method: str(formData.get("method")) });
  refresh();
  return noted(r.keptCents ? `Back. $${(r.keptCents / 100).toFixed(2)} of the deposit kept${r.backCents ? `, $${(r.backCents / 100).toFixed(2)} given back` : ""}.` : r.backCents ? `Back. Give her the $${(r.backCents / 100).toFixed(2)} deposit.` : "Back. Thank you!");
});

export const setUnitUse = safe(async function setUnitUse(unitId: string, formData: FormData) {
  await setUnitUseFor(await requireUser(), unitId, formData);
  refresh();
});

export const saveLoanerSettings = safe(async function saveLoanerSettings(formData: FormData) {
  await saveLoanerSettingsFor(await requireUser(), formData);
  revalidatePath("/units/loans");
});
