import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { DEFAULT_CHECKLIST } from "@/lib/service-menu";
import { PageHeader, Section } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { addUser, changePassword, saveChecklist, saveServiceItem, saveShop, setUserActive } from "@/actions/settings";

const d = (c: number) => (c / 100).toFixed(2);

export default async function SettingsPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [shop, services, users] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId } }),
    db.serviceItem.findMany({ where: { shopId: user.shopId }, orderBy: { sortOrder: "asc" } }),
    db.user.findMany({ where: { shopId: user.shopId }, orderBy: { createdAt: "asc" } }),
  ]);
  const checklist = shop.checklistItems?.length ? shop.checklistItems : DEFAULT_CHECKLIST;

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Settings" />

      {admin && (
        <Section title="Shop">
          <ActionForm action={saveShop} success="Saved" className="grid-form">
            {(
              [
                ["name", "Shop name", shop.name],
                ["phone", "Phone", shop.phone ?? ""],
                ["email", "Email", shop.email ?? ""],
                ["address", "Address (prints on invoices)", shop.address ?? ""],
                ["laborRate", "Labor rate ($/hr)", d(shop.laborRateCents)],
                ["taxRatePct", "Sales tax (%)", String(shop.taxRatePct)],
                ["partsMarkupPct", "Parts markup over cost (%)", String(shop.partsMarkupPct)],
                ["warrantyDays", "Warranty (days)", String(shop.warrantyDays)],
                ["abandonedAfterDays", "Abandoned after (days from ready-call)", String(shop.abandonedAfterDays)],
                ["storageFee", "Storage fee ($)", d(shop.storageFeeCents)],
                ["nextTicketNumber", "Next ticket number", String(shop.nextTicketNumber)],
              ] as const
            ).map(([k, label, v]) => (
              <div key={k} className="field">
                <label htmlFor={k} className="label">
                  {label}
                </label>
                <input id={k} name={k} defaultValue={v} className="input" />
              </div>
            ))}
            <div className="sm:col-span-2">
              <Submit>Save shop</Submit>
            </div>
          </ActionForm>
        </Section>
      )}

      {admin && (
        <Section title="Service checklist">
          <ActionForm action={saveChecklist} success="Checklist saved" className="space-y-2">
            <label htmlFor="items" className="label">
              One item per line. Every ticket shows these to tick off.
            </label>
            <textarea id="items" name="items" rows={12} defaultValue={checklist.join("\n")} className="textarea" />
            <Submit>Save checklist</Submit>
          </ActionForm>
        </Section>
      )}

      {admin && (
        <Section title="Service menu">
          <ul className="space-y-2">
            {services.map((s) => (
              <li key={s.id}>
                <ActionForm action={saveServiceItem.bind(null, s.id)} success="Saved" className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={`sn-${s.id}`}>
                    Service name
                  </label>
                  <input id={`sn-${s.id}`} name="name" defaultValue={s.name} className="input min-w-60 flex-1" />
                  <label className="sr-only" htmlFor={`sp-${s.id}`}>
                    Price
                  </label>
                  <input id={`sp-${s.id}`} name="price" defaultValue={d(s.priceCents)} className="input num w-28" />
                  <label className="flex items-center gap-1 text-sm">
                    <input type="checkbox" name="active" defaultChecked={s.active} className="check" /> Active
                  </label>
                  <Submit className="btn btn-sm">Save</Submit>
                </ActionForm>
              </li>
            ))}
          </ul>
          <ActionForm action={saveServiceItem.bind(null, null)} reset success="Service added" className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            <label className="sr-only" htmlFor="new-sn">
              New service
            </label>
            <input id="new-sn" name="name" className="input min-w-60 flex-1" placeholder="New service" required />
            <label className="sr-only" htmlFor="new-sp">
              Price
            </label>
            <input id="new-sp" name="price" className="input num w-28" placeholder="$" required />
            <Submit className="btn">Add service</Submit>
          </ActionForm>
          <p className="muted mt-2 text-xs">Prices on existing tickets don&apos;t change when you edit the menu.</p>
        </Section>
      )}

      {admin && (
        <Section title="People">
          <ul className="mb-4 divide-y divide-line text-sm">
            {users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <strong>{u.name}</strong> <span className="muted">{u.email}</span> <span className="pill tone-neutral">{u.role.toLowerCase()}</span>
                  {!u.active && <span className="pill tone-bad ml-1">off</span>}
                </span>
                {u.role !== "OWNER" && (
                  <ActionButton action={setUserActive.bind(null, u.id, !u.active)} className="btn btn-sm" success={u.active ? "Access removed" : "Access restored"}>
                    {u.active ? "Remove access" : "Restore access"}
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
          <ActionForm action={addUser} reset success="Account created. Give them the temporary password." className="grid-form border-t border-line pt-4">
            <div className="field">
              <label htmlFor="u-name" className="label">
                Name
              </label>
              <input id="u-name" name="name" required className="input" />
            </div>
            <div className="field">
              <label htmlFor="u-email" className="label">
                Email
              </label>
              <input id="u-email" name="email" type="email" required className="input" />
            </div>
            <div className="field">
              <label htmlFor="u-pw" className="label">
                Temporary password (8+ characters)
              </label>
              <input id="u-pw" name="password" required minLength={8} className="input" autoComplete="new-password" />
            </div>
            <div className="field">
              <label htmlFor="u-role" className="label">
                Role
              </label>
              <select id="u-role" name="role" className="select" defaultValue="TECH">
                <option value="TECH">Tech</option>
                <option value="ADMIN">Admin (can change settings)</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <Submit>Add person</Submit>
            </div>
          </ActionForm>
        </Section>
      )}

      <Section title="My password">
        <ActionForm action={changePassword} reset success="Password changed" className="grid-form">
          <div className="field">
            <label htmlFor="pw-cur" className="label">
              Current password
            </label>
            <input id="pw-cur" name="current" type="password" required className="input" autoComplete="current-password" />
          </div>
          <div className="field">
            <label htmlFor="pw-new" className="label">
              New password (8+ characters)
            </label>
            <input id="pw-new" name="next" type="password" required minLength={8} className="input" autoComplete="new-password" />
          </div>
          <div className="sm:col-span-2">
            <Submit>Change password</Submit>
          </div>
        </ActionForm>
      </Section>
      {!admin && <p className="muted text-sm">Shop settings are managed by the owner. Rates: labor {money(shop.laborRateCents)}/hr.</p>}
    </div>
  );
}
