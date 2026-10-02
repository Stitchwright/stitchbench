"use server";

// Bringing in a customer list (scheduling-messaging-design.md 11.2): admins, with Marketing on. The counts and the
// problems come back to the page, so this is a data action, not safe().
import { revalidatePath } from "next/cache";
import { isUserError } from "@/lib/action";
import { requireAdmin } from "@/lib/session";
import { requireOn } from "@/lib/module-gate";
import { importCustomersAs, type ImportResult, type ImportRow } from "@/lib/messaging/campaigns";

export type { ImportResult, ImportRow };

export async function importCustomers(rows: ImportRow[]): Promise<({ ok: true } & ImportResult) | { error: string }> {
  try {
    const user = await requireAdmin();
    await requireOn(user, "marketing");
    const r = await importCustomersAs(user, rows);
    revalidatePath("/customers");
    revalidatePath("/messages/opt-outs");
    return { ok: true, ...r };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}
