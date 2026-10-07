"use server";
// Settings -> Bookkeeping and "Exported through" (later-round-1-design.md 3.4). Both change no business record, so both work
// while the program is read-only. Owners and admins only; each is on the audit log.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe } from "@/lib/action";
import { UserError } from "@/lib/user-error";
import { requireAdmin } from "@/lib/session";
import { str } from "@/lib/format";
import { actorOf, audit, diff } from "@/lib/audit";
import { ACCOUNT_KEYS, cleanAccount, readAccounts } from "@/lib/books-accounts";
import { loadBooks } from "@/lib/books";

export const saveBooksSettings = safe.whileLapsed("saveBooksSettings")(async function saveBooksSettings(formData: FormData) {
  const user = await requireAdmin();
  const accounts: Record<string, string> = {};
  for (const a of ACCOUNT_KEYS) {
    const v = cleanAccount(str(formData.get(`account:${a.key}`)) ?? "");
    if (v.length > 100) throw new UserError(`${a.label}: that name is too long.`);
    if (v && v !== a.def) accounts[a.key] = v;
  }
  const before = await loadBooks(user.shopId);
  const next = {
    accounts,
    byCategory: formData.get("byCategory") === "on",
    netDiscounts: formData.get("netDiscounts") === "on",
    cardClearing: cleanAccount(str(formData.get("cardClearing")) ?? ""),
  };
  await db.$transaction(async (tx) => {
    await tx.booksSettings.upsert({
      where: { shopId: user.shopId },
      create: { shopId: user.shopId, ...next },
      update: next,
    });
    const changes = diff(
      { accounts: JSON.stringify(before.accounts), byCategory: before.byCategory, netDiscounts: before.netDiscounts, cardClearing: before.cardClearing },
      { accounts: JSON.stringify(readAccounts(next.accounts)), byCategory: next.byCategory, netDiscounts: next.netDiscounts, cardClearing: next.cardClearing },
      ["accounts", "byCategory", "netDiscounts", "cardClearing"],
    );
    if (changes) await audit(tx, actorOf(user), { action: "books.settings", subjectType: "Shop", subjectId: user.shopId, subjectLabel: "Bookkeeping names", changes });
  });
  revalidatePath("/settings/books");
  revalidatePath("/reports");
});

/** Marks every day through `through` (a "YYYY-MM-DD" shop day) as sent to the bookkeeper: the next export starts the day after. */
export const markBooksExported = safe.whileLapsed("markBooksExported")(async function markBooksExported(through: string) {
  const user = await requireAdmin();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through) || Number.isNaN(new Date(`${through}T00:00:00Z`).getTime())) throw new UserError("Pick the last day that was exported.");
  const before = await loadBooks(user.shopId);
  await db.$transaction(async (tx) => {
    await tx.booksSettings.upsert({ where: { shopId: user.shopId }, create: { shopId: user.shopId, exportedThrough: through }, update: { exportedThrough: through } });
    await audit(tx, actorOf(user), {
      action: "books.exported",
      subjectType: "Shop",
      subjectId: user.shopId,
      subjectLabel: "Bookkeeping export",
      changes: { exportedThrough: [before.exportedThrough, through] },
    });
  });
  revalidatePath("/reports");
});
