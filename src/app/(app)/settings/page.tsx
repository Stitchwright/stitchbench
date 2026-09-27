import Link from "next/link";
import { db } from "@/lib/db";
import { isInstallAdmin, requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { DEFAULT_CHECKLIST } from "@/lib/service-menu";
import { PageHeader, Section } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import {
  addUser,
  changePassword,
  resetUserPassword,
  saveChecklist,
  savePriceListNote,
  saveServiceItem,
  saveShop,
  setUserActive,
} from "@/actions/settings";
import { joinCommunityHub, leaveCommunityHub, syncCommunityHub } from "@/actions/hub";
import { InviteInput } from "@/components/invite-input";
import { saveCompanyMode } from "@/actions/partners";

const d = (c: number) => (c / 100).toFixed(2);

/** Joining StitchHub, the community server: manual links, shared notes and photos, figure snapshots. */
async function CommunityHub({ admin }: { admin: boolean }) {
  const [s, links, notes, figures] = await Promise.all([db.hubState.findUnique({ where: { id: 1 } }), db.manualLink.count(), db.hubPost.count(), db.hubFigure.count()]);
  const joined = Boolean(s?.url && s.installKey);
  return (
    <Section title="Community hub">
      {joined ? (
        <div className="space-y-3 text-sm">
          <p>
            Connected to {s!.hubName ? <strong>{s!.hubName}</strong> : null} <span className="mono">{s!.url}</span>
            {s!.joinedAt && <> since {s!.joinedAt.toLocaleDateString()}</>}. Syncs every 10 minutes.
          </p>
          <p className="muted">
            {links} manual links · {notes} shared notes · {figures} figure snapshots · last sync {s!.lastSyncAt ? s!.lastSyncAt.toLocaleString() : "not yet"}
          </p>
          {s!.discordUrl && (
            <p>
              Community chat:{" "}
              <a href={s!.discordUrl} target="_blank" rel="noreferrer" className="link">
                {s!.discordUrl}
              </a>
            </p>
          )}
          {s!.lastError && <p className="pill tone-bad inline-block">Last sync failed: {s!.lastError}</p>}
          <div className="flex flex-wrap gap-2">
            <ActionButton action={syncCommunityHub} className="btn btn-sm" success="Synced with the hub">
              Sync now
            </ActionButton>
            {admin && (
              <ActionButton action={leaveCommunityHub} className="btn btn-sm btn-danger" confirm="Disconnect from the hub?" success="Disconnected">
                Leave the hub
              </ActionButton>
            )}
          </div>
        </div>
      ) : admin ? (
        <ActionForm action={joinCommunityHub} success="Joined the community hub" className="space-y-3">
          <p className="muted text-sm">
            The hub shares manual links (never the manuals themselves), tech notes and photos, and manual figure snapshots between shops. Your customers,
            tickets and prices never leave this StitchBench. The hub admin gives you an invite (a code or a .stitchhub file).
          </p>
          <InviteInput />
          <details>
            <summary className="link cursor-pointer text-sm">Or type the hub address and join key</summary>
            <div className="grid-form mt-2">
              <div className="field">
                <label htmlFor="hub-url" className="label">
                  Hub address
                </label>
                <input id="hub-url" name="url" className="input mono" placeholder="https://..." defaultValue={s?.url ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="hub-key" className="label">
                  Join key
                </label>
                <input id="hub-key" name="joinKey" className="input mono" autoComplete="off" />
              </div>
            </div>
          </details>
          <Submit>Join</Submit>
        </ActionForm>
      ) : (
        <p className="muted text-sm">
          Not connected to a community hub. The shop owner or an admin can join one here (when several companies share this StitchBench, its
          administrator does).
        </p>
      )}
    </Section>
  );
}

export default async function SettingsPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [shop, services, users] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId } }),
    db.serviceItem.findMany({ where: { shopId: user.shopId }, orderBy: { sortOrder: "asc" } }),
    db.user.findMany({ where: { shopId: user.shopId }, orderBy: { createdAt: "asc" } }),
  ]);
  const checklist = shop.checklistItems?.length ? shop.checklistItems : DEFAULT_CHECKLIST;
  const categories = [...new Set(services.map((s) => s.category).filter(Boolean))] as string[];

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Settings" />

      <div id="hub">
        <CommunityHub admin={await isInstallAdmin(user)} />
      </div>

      {admin && (
        <div id="company">
          <Section title="What this company does">
            <ActionForm action={saveCompanyMode} success="Saved" className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="doesRepair" defaultChecked={shop.doesRepair} className="check" /> Repairs machines (the StitchBench bench:
                tickets, specs, manuals)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="sellsRetail" defaultChecked={shop.sellsRetail} className="check" /> Sells over the counter (the StitchShop
                register: notions, fabric by the yard, accessories, repair pickups)
              </label>
              <div className="field">
                <label htmlFor="receiptNote" className="label">
                  Bottom of register receipts (returns policy, hours)
                </label>
                <textarea id="receiptNote" name="receiptNote" rows={2} defaultValue={shop.receiptNote ?? ""} className="textarea" />
              </div>
              <Submit>Save</Submit>
            </ActionForm>
          </Section>
        </div>
      )}

      {admin && (
        <Section title="Your data">
          <p className="muted mb-2 text-sm">This company&apos;s own records as spreadsheets (CSV), to keep or to take to another system.</p>
          <div className="flex flex-wrap gap-2">
            <a href="/api/export/customers" className="btn btn-sm">
              Customers
            </a>
            <a href="/api/export/inventory" className="btn btn-sm">
              Inventory
            </a>
            <a href="/api/export/register-sales" className="btn btn-sm">
              Register sales
            </a>
            <a href="/api/export/repairs" className="btn btn-sm">
              Repairs sent out / from partners
            </a>
            <a href="/api/sales" className="btn btn-sm">
              Repair payments (sales log)
            </a>
          </div>
        </Section>
      )}

      {admin && (
        <Section title="Shop">
          <ActionForm action={saveShop} success="Saved" className="grid-form">
            {/* The ticket counter as this page showed it: saving other settings leaves the counter alone. */}
            <input type="hidden" name="was:nextTicketNumber" value={String(shop.nextTicketNumber)} />
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
                ["libraryRoot", "Manual library folder (same on every PC)", shop.libraryRoot],
                ["timeZone", "Time zone (days and months start here), e.g. America/Chicago", shop.timeZone],
                ["payInstructions", "Marketplace: how other shops pay you (PayPal, Zelle, check to...)", shop.payInstructions ?? ""],
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

      {admin && shop.doesRepair && (
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

      {admin && shop.doesRepair && (
        <Section
          title="Service menu and price list"
          actions={
            <Link href="/price-list" className="btn btn-sm">
              View price list
            </Link>
          }
        >
          <p className="muted mb-3 text-sm">
            The menu is what tickets bill from. The category groups items on the printed price list, and the description prints under the name.
          </p>
          <datalist id="svc-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <ul className="space-y-3">
            {services.map((s) => (
              <li key={s.id} className="border-b border-line pb-3 last:border-0">
                <ActionForm action={saveServiceItem.bind(null, s.id)} success="Saved" className="grid gap-2 sm:grid-cols-[1fr_7rem_12rem_auto_auto]">
                  <label className="sr-only" htmlFor={`sn-${s.id}`}>
                    Service name
                  </label>
                  <input id={`sn-${s.id}`} name="name" defaultValue={s.name} className="input" />
                  <label className="sr-only" htmlFor={`sp-${s.id}`}>
                    Price
                  </label>
                  <input id={`sp-${s.id}`} name="price" defaultValue={d(s.priceCents)} className="input num" />
                  <label className="sr-only" htmlFor={`sc-${s.id}`}>
                    Category
                  </label>
                  <input id={`sc-${s.id}`} name="category" defaultValue={s.category ?? ""} list="svc-categories" className="input" placeholder="Category" />
                  <label className="flex items-center gap-1 text-sm">
                    <input type="checkbox" name="active" defaultChecked={s.active} className="check" /> Active
                  </label>
                  <Submit className="btn btn-sm">Save</Submit>
                  <label className="sr-only" htmlFor={`sd-${s.id}`}>
                    Description
                  </label>
                  <input
                    id={`sd-${s.id}`}
                    name="description"
                    defaultValue={s.description ?? ""}
                    className="input text-sm sm:col-span-5"
                    placeholder="Description on the price list (optional)"
                  />
                </ActionForm>
              </li>
            ))}
          </ul>
          <ActionForm action={saveServiceItem.bind(null, null)} reset success="Service added" className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-[1fr_7rem_12rem_auto]">
            <label className="sr-only" htmlFor="new-sn">
              New service
            </label>
            <input id="new-sn" name="name" className="input" placeholder="New service" required />
            <label className="sr-only" htmlFor="new-sp">
              Price
            </label>
            <input id="new-sp" name="price" className="input num" placeholder="$" required />
            <label className="sr-only" htmlFor="new-sc">
              Category
            </label>
            <input id="new-sc" name="category" list="svc-categories" className="input" placeholder="Category" />
            <Submit className="btn">Add service</Submit>
            <label className="sr-only" htmlFor="new-sd">
              Description
            </label>
            <input id="new-sd" name="description" className="input text-sm sm:col-span-4" placeholder="Description on the price list (optional)" />
          </ActionForm>
          <p className="muted mt-2 text-xs">Prices on existing tickets don&apos;t change when you edit the menu.</p>

          <ActionForm action={savePriceListNote} success="Saved" className="mt-6 space-y-2 border-t border-line pt-4">
            <label htmlFor="priceListNote" className="label">
              Fine print at the bottom of the price list
            </label>
            <textarea
              id="priceListNote"
              name="priceListNote"
              rows={3}
              defaultValue={shop.priceListNote ?? ""}
              className="textarea"
              placeholder="e.g. Parts are extra. Prices are for machines in working order; we call before doing more."
            />
            <Submit className="btn btn-sm">Save fine print</Submit>
          </ActionForm>
        </Section>
      )}

      {admin && (
        <Section title="People">
          <p className="muted mb-3 text-sm">Everyone signs in with their own email and password. Techs can run tickets; admins can also change prices and people.</p>
          <ul className="mb-4 divide-y divide-line text-sm">
            {users.map((u) => (
              <li key={u.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong>{u.name}</strong> <span className="muted">{u.email}</span> <span className="pill tone-neutral">{u.role.toLowerCase()}</span>
                    {!u.active && <span className="pill tone-bad ml-1">off</span>}
                  </span>
                  {u.role !== "OWNER" && (
                    <ActionButton action={setUserActive.bind(null, u.id, !u.active)} className="btn btn-sm" success={u.active ? "Access removed" : "Access restored"}>
                      {u.active ? "Remove access" : "Restore access"}
                    </ActionButton>
                  )}
                </div>
                {(u.role !== "OWNER" || u.id === user.id) && (
                  <details className="mt-1">
                    <summary className="link cursor-pointer text-xs">Reset password</summary>
                    <ActionForm action={resetUserPassword.bind(null, u.id)} reset success="Password reset. Give them the new one." className="mt-2 flex flex-wrap gap-2">
                      <label className="sr-only" htmlFor={`rp-${u.id}`}>
                        New password for {u.name}
                      </label>
                      <input id={`rp-${u.id}`} name="password" required minLength={8} className="input w-64" placeholder="New password (8+ characters)" autoComplete="new-password" />
                      <Submit className="btn btn-sm">Set password</Submit>
                    </ActionForm>
                  </details>
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
