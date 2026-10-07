import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { loadBooks } from "@/lib/books";
import { ACCOUNT_KEYS } from "@/lib/books-accounts";
import { saveBooksSettings } from "@/actions/books";
import { ActionForm, Submit } from "@/components/action-form";
import { PageHeader } from "@/components/ui";

/** Settings -> Bookkeeping: the bookkeeper's exact account names and the export's choices. Owners and admins only. */
export default async function BooksSettings() {
  const user = await requireUser();
  if (user.role === "TECH") notFound();
  const b = await loadBooks(user.shopId);
  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: "/settings", label: "Settings" }}
        title="Bookkeeping"
        sub="The names your bookkeeper uses for each account. A blank box keeps the name shown inside it. Used by Reports, Bookkeeping."
      />
      <ActionForm action={saveBooksSettings} success="Saved" className="grid-form">
        {ACCOUNT_KEYS.map((a) => (
          <div className="field" key={a.key}>
            <label htmlFor={`account:${a.key}`} className="label">
              {a.label}
            </label>
            <input id={`account:${a.key}`} name={`account:${a.key}`} className="input" defaultValue={b.accounts[a.key] ?? ""} placeholder={a.def} maxLength={100} />
          </div>
        ))}
        <div className="field">
          <label htmlFor="cardClearing" className="label">
            Card payments go to (blank: the cash and check account)
          </label>
          <input id="cardClearing" name="cardClearing" className="input" defaultValue={b.cardClearing} placeholder="Card Clearing" maxLength={100} />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="byCategory" defaultChecked={b.byCategory} /> One sales account for each kind of item (Sales - Notions, Sales - Fabric, and so on)
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="netDiscounts" defaultChecked={b.netDiscounts} /> Take discounts off the sales instead of showing them in their own account
        </label>
        <div className="sm:col-span-2">
          <Submit>Save</Submit>
        </div>
      </ActionForm>
    </div>
  );
}
