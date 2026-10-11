// Settings -> Stores (shop-features-round-2-design.md 7.1 and 7.5): a company with one store sees one plain choice, "Add
// a second store"; with more, each store's details, who works where, which store the online shop sells from, the
// refund and discount limits, the owner's daily summary and her approval code. Owners add and close stores (the program
// charges nothing for them; on the owner's hosting each store is hosted like the first, free-software-design.md
// section 7, decision 9); owners and admins change the details.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { storesOf } from "@/lib/stores";
import { STORE_ZONES } from "@/lib/stores-admin";
import { addStore, joinCompany, makeJoinCode, saveApproveCode, saveDailySummary, saveStore, setHomeStore, setOnlineStore, setStoreOpen } from "@/actions/stores";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { PageHeader, Section } from "@/components/ui";
import { sameCustomersFor } from "@/lib/join-companies";
import { JoinCodeButton } from "@/components/join-code";

function ZoneSelect({ id, value }: { id: string; value: string }) {
  const known = STORE_ZONES.some((z) => z.id === value);
  return (
    <select id={id} name="timeZone" className="select" defaultValue={value}>
      {!known && <option value={value}>{value}</option>}
      {STORE_ZONES.map((z) => (
        <option key={z.id} value={z.id}>
          {z.label} time
        </option>
      ))}
    </select>
  );
}

/** A store's address, phone, time zone, tax rate, hours and receipt line. */
function DetailFields({ prefix, s }: { prefix: string; s?: { address: string | null; phone: string | null; timeZone: string; taxRatePct: number; hours: string | null; receiptFooter: string | null } }) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${prefix}-address`} className="label">
          Address
        </label>
        <input id={`${prefix}-address`} name="address" className="input" defaultValue={s?.address ?? ""} placeholder="12 Main St, Naples FL" />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-phone`} className="label">
          Phone
        </label>
        <input id={`${prefix}-phone`} name="phone" className="input" defaultValue={s?.phone ?? ""} inputMode="tel" />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-tz`} className="label">
          Time zone
        </label>
        <ZoneSelect id={`${prefix}-tz`} value={s?.timeZone ?? "America/New_York"} />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-tax`} className="label">
          Sales tax (%)
        </label>
        <input id={`${prefix}-tax`} name="taxRatePct" className="input" defaultValue={s ? String(s.taxRatePct) : ""} inputMode="decimal" placeholder="7" />
      </div>
      <details className="field col-span-full">
        <summary className="link cursor-pointer text-sm">Hours and receipt</summary>
        <div className="mt-2 grid gap-3">
          <div className="field">
            <label htmlFor={`${prefix}-hours`} className="label">
              Opening hours
            </label>
            <input id={`${prefix}-hours`} name="hours" className="input" defaultValue={s?.hours ?? ""} placeholder="Mon-Sat 10-5" />
          </div>
          <div className="field">
            <label htmlFor={`${prefix}-receipt`} className="label">
              Bottom of receipts (returns policy, hours)
            </label>
            <textarea id={`${prefix}-receipt`} name="receiptFooter" rows={2} className="textarea" defaultValue={s?.receiptFooter ?? ""} />
          </div>
        </div>
      </details>
    </>
  );
}

/**
 * "Join another company into this one" (7.6), folded away: the owner proves she owns both by signing in to both. In the
 * company that will become a store she makes a join code; here she types it and the other company's name.
 */
function JoinSection({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Section title="Bring another of your companies in as a store">
      <details>
        <summary className="link cursor-pointer text-sm">You run another company on StitchBench too?</summary>
        <p className="muted mt-2 mb-3 text-sm">
          Joining it brings its items, customers, gift cards, tickets and sales in as a store of this company (its tickets and sales are numbered on from this company&apos;s). It
          can&apos;t be undone.
        </p>
        <p className="text-sm font-semibold">1. In the other company</p>
        <p className="muted mb-3 text-sm">Sign in to it, open Settings, Stores, and tap Make a join code there. Then come back here.</p>
        <p className="text-sm font-semibold">2. Here</p>
        <ActionForm action={joinCompany} className="mt-2 grid-form">
          <div className="field">
            <label htmlFor="join-code" className="label">
              Join code
            </label>
            <input id="join-code" name="code" required className="input" autoComplete="off" placeholder="ABCDE-FGHJK" />
          </div>
          <div className="field">
            <label htmlFor="join-confirm" className="label">
              The other company&apos;s name, to confirm
            </label>
            <input id="join-confirm" name="confirm" required className="input" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="join-store" className="label">
              The store will be called (blank: the company&apos;s name)
            </label>
            <input id="join-store" name="storeName" className="input" />
          </div>
          <div className="col-span-full">
            <Submit className="btn btn-primary">Join it in as a store</Submit>
          </div>
        </ActionForm>
        <p className="mt-4 text-sm font-semibold">Joining this company into another of yours?</p>
        <p className="muted mb-2 text-sm">Make a join code here and type it into the other company.</p>
        <JoinCodeButton action={makeJoinCode} />
      </details>
    </Section>
  );
}

export default async function StoresPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const owner = user.role === "OWNER";
  const [stores, shop, people, me] = await Promise.all([
    storesOf(user.shopId),
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, address: true, phone: true, timeZone: true, taxRatePct: true, onlineLocationId: true, dailySummaryOn: true } }),
    db.user.findMany({ where: { shopId: user.shopId, active: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, role: true, locationId: true } }),
    db.user.findUnique({ where: { id: user.id }, select: { approveCode: true, approveCodeOld: true } }),
  ]);
  const open = stores.filter((s) => s.active);
  const multi = open.length > 1;

  const codes = new Map((await db.location.findMany({ where: { shopId: user.shopId }, select: { id: true, feedStoreCode: true } })).map((l) => [l.id, l.feedStoreCode]));
  const main = stores.find((s) => s.main);

  if (!multi) {
    // One store: one plain choice (nothing else about stores shows anywhere until a second store is added).
    return (
      <div className="max-w-2xl space-y-6">
        <PageHeader title="Stores" back={{ href: "/settings", label: "Settings" }} sub="One store. Opening another one? Add it here: customers, gift cards and store credit work at both, and each store keeps its own stock, register and sales tax." />
        {owner ? (
          <Section title="Add a second store">
            <ActionForm action={addStore} reset className="grid-form">
              <div className="field">
                <label htmlFor="add-main" className="label">
                  This store is called
                </label>
                <input id="add-main" name="mainName" className="input" defaultValue={main?.name ?? "Main store"} />
              </div>
              <div className="field">
                <label htmlFor="add-name" className="label">
                  The new store is called
                </label>
                <input id="add-name" name="name" required className="input" placeholder="Florida" />
              </div>
              <DetailFields prefix="add" s={{ address: null, phone: null, timeZone: shop.timeZone, taxRatePct: shop.taxRatePct, hours: null, receiptFooter: null }} />
              <div className="col-span-full">
                <Submit>Add the store</Submit>
              </div>
            </ActionForm>
          </Section>
        ) : (
          <p className="muted text-sm">The owner adds a store.</p>
        )}
        <JoinSection show={owner} />
        {stores.some((s) => !s.active) && (
          <Section title="Closed stores">
            <ul className="divide-y divide-line text-sm">
              {stores
                .filter((s) => !s.active)
                .map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>{s.name}</span>
                    {owner && (
                      <ActionButton action={setStoreOpen.bind(null, s.id, true)} className="btn btn-sm" success={`${s.name} is open again`}>
                        Open it again
                      </ActionButton>
                    )}
                  </li>
                ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  const online = shop.onlineLocationId ?? main?.id ?? "";
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Stores" back={{ href: "/settings", label: "Settings" }} sub={`${open.length} stores. Customers, gift cards, store credit, layaways and special orders work at every store; stock, registers and sales tax are each store's own.`} actions={<Link href="/today" className="btn btn-sm">Today at every store</Link>} />

      {stores.map((s) => (
        <Section key={s.id} title={`${s.name}${s.main ? " (main store)" : ""}${s.active ? "" : " (closed)"}`}>
          <ActionForm action={saveStore.bind(null, s.id)} success="Saved" className="grid-form">
            <div className="field">
              <label htmlFor={`n-${s.id}`} className="label">
                Name
              </label>
              <input id={`n-${s.id}`} name="name" required className="input" defaultValue={s.name} readOnly={!admin} />
            </div>
            <DetailFields prefix={s.id} s={s} />
            <details className="field col-span-full">
              <summary className="link cursor-pointer text-sm">Limits and closing time</summary>
              <div className="mt-2 grid gap-3 md:grid-cols-3">
                <div className="field">
                  <label htmlFor={`r-${s.id}`} className="label">
                    Refunds over ($) need approval
                  </label>
                  <input id={`r-${s.id}`} name="approveRefund" className="input" inputMode="decimal" defaultValue={s.approveRefundCents != null ? (s.approveRefundCents / 100).toFixed(0) : ""} placeholder="No limit" />
                </div>
                <div className="field">
                  <label htmlFor={`d-${s.id}`} className="label">
                    Discounts over (%) need approval
                  </label>
                  <input id={`d-${s.id}`} name="approveDiscount" className="input" inputMode="numeric" defaultValue={s.approveDiscountPct ?? ""} placeholder="No limit" />
                </div>
                <div className="field">
                  <label htmlFor={`c-${s.id}`} className="label">
                    Closes at (for the daily summary)
                  </label>
                  <input id={`c-${s.id}`} name="dailyAt" type="time" className="input" defaultValue={s.dailyAt ?? "18:00"} />
                </div>
                {!s.main && (
                  <div className="field">
                    <label htmlFor={`g-${s.id}`} className="label">
                      Google store code (local inventory feed)
                    </label>
                    <input id={`g-${s.id}`} name="feedStoreCode" className="input" defaultValue={codes.get(s.id) ?? ""} />
                  </div>
                )}
              </div>
            </details>
            {s.main && <p className="muted col-span-full text-sm">The main store&apos;s address, phone, time zone and tax rate are the company&apos;s own (Settings, Shop details): changing them here changes them there.</p>}
            {admin && (
              <div className="col-span-full flex flex-wrap gap-2">
                <Submit className="btn btn-primary">Save {s.name}</Submit>
                {owner && !s.main && (
                  <ActionButton action={setStoreOpen.bind(null, s.id, !s.active)} className="btn" success={s.active ? `${s.name} closed` : `${s.name} is open again`}>
                    {s.active ? "Close this store" : "Open it again"}
                  </ActionButton>
                )}
              </div>
            )}
          </ActionForm>
        </Section>
      ))}

      {admin && (
        <Section title="Who works where">
          <p className="muted mb-3 text-sm">Each person&apos;s home store. A computer can be set to a store too (top of the menu), and that wins on that computer.</p>
          <ul className="divide-y divide-line text-sm">
            {people.map((p) => (
              <li key={p.id} className="py-2">
                <ActionForm action={setHomeStore.bind(null, p.id)} success={`${p.name}'s home store saved`} className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`home-${p.id}`} className="min-w-40 font-semibold">
                    {p.name}
                  </label>
                  <select id={`home-${p.id}`} name="locationId" className="select w-56" defaultValue={p.locationId ?? main?.id ?? ""}>
                    {open.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <Submit className="btn btn-sm">Save</Submit>
                </ActionForm>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {admin && (
        <Section title="The online shop">
          <ActionForm action={setOnlineStore} success="Saved" className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label htmlFor="online" className="label">
                Online orders and Google&apos;s &quot;in stock&quot; come from
              </label>
              <select id="online" name="locationId" className="select w-64" defaultValue={online}>
                {open.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <Submit className="btn btn-sm">Save</Submit>
          </ActionForm>
        </Section>
      )}

      {owner && (
        <Section title="Your daily summary and approvals">
          <ActionForm action={saveDailySummary} success="Saved" className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="on" defaultChecked={shop.dailySummaryOn} className="check" />{" "}Email me each store&apos;s day at its closing time (takings, repairs waiting, low stock, who worked)
            </label>
            <Submit className="btn btn-sm">Save</Submit>
          </ActionForm>
          <ActionForm action={saveApproveCode} reset success="Saved" className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
            <div className="field">
              <label htmlFor="code" className="label">
                My approval code at the register {me?.approveCode ? "(set)" : ""}
              </label>
              <input id="code" name="code" className="input w-40" inputMode="numeric" autoComplete="off" placeholder="6 to 8 numbers" />
            </div>
            {me?.approveCode && me.approveCodeOld && (
              <p className="w-full text-sm" role="status">
                Codes are 6 numbers now (a short one is easy to guess). Yours still works: type a new one of 6 numbers here when you can.
              </p>
            )}
            {me?.approveCode && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="clear" className="check" /> Remove my code
              </label>
            )}
            <Submit className="btn btn-sm">Save code</Submit>
          </ActionForm>
          <p className="muted mt-2 text-sm">
            A refund or discount over a store&apos;s limit stops at the register: a manager types her code there, or the register asks you and you answer from your phone (no app needed: the email has the link).
          </p>
        </Section>
      )}

      {admin &&
        (await Promise.all(open.filter((s) => !s.main).map(async (s) => ({ s, same: await sameCustomersFor(user, s.id) }))))
          .filter((x) => x.same.length)
          .map(({ s, same }) => (
            <Section key={s.id} title={`Customers who may be the same person (${s.name})`}>
              <p className="muted mb-2 text-sm">The same email, phone or name at {s.name} and another store. Open one to merge them (nothing is merged by itself).</p>
              <ul className="divide-y divide-line text-sm">
                {same.slice(0, 50).map((m) => (
                  <li key={m.fromId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>{m.name}</span>
                    <Link href={`/customers/${m.fromId}?merge=${m.intoId}`} className="btn btn-sm">
                      Compare and merge
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ))}

      <JoinSection show={owner} />

      {owner && (
        <Section title="Add another store">
          <ActionForm action={addStore} reset className="grid-form">
            <div className="field">
              <label htmlFor="add-name" className="label">
                The new store is called
              </label>
              <input id="add-name" name="name" required className="input" />
            </div>
            <DetailFields prefix="add" s={{ address: null, phone: null, timeZone: shop.timeZone, taxRatePct: shop.taxRatePct, hours: null, receiptFooter: null }} />
            <div className="col-span-full">
              <Submit className="btn">Add the store</Submit>
            </div>
          </ActionForm>
        </Section>
      )}
    </div>
  );
}
