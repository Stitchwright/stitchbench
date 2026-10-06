"use server";

// Bringing in a customer list (scheduling-messaging-design.md 11.2): admins, with Marketing on. The counts and the
// problems come back to the page, so this is a data action, not safe().
import { revalidatePath } from "next/cache";
import { requireBaseWritable } from "@/lib/base-gate";
import { isUserError } from "@/lib/user-error";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { actorOf, audit } from "@/lib/audit";
import { requireOn } from "@/lib/module-gate";
import { importCustomersAs, type ImportResult, type ImportRow } from "@/lib/messaging/campaigns";

export type { ImportResult, ImportRow };

export async function importCustomers(rows: ImportRow[]): Promise<({ ok: true } & ImportResult) | { error: string }> {
  try {
    const user = await requireAdmin();
    await requireBaseWritable(user);
    await requireOn(user, "marketing");
    const r = await importCustomersAs(user, rows);
    await audit(db, actorOf(user), {
      action: "import.customers",
      subjectType: "Customers",
      subjectLabel: `${r.added} added, ${r.matched} already here`,
      changes: { added: [0, r.added], matched: [0, r.matched], unsubscribed: [0, r.unsubscribed] },
    });
    revalidatePath("/customers");
    revalidatePath("/messages/opt-outs");
    return { ok: true, ...r };
  } catch (e) {
    if (isUserError(e)) return { error: e.message };
    throw e;
  }
}
