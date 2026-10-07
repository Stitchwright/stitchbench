// A customer's wish list or gift registry (shop-features-round-2-design.md 9.9): what she would like and how many, what
// was bought (staff only: don't tell her), the link to send her family, and adding from stock or in words.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { registryView } from "@/lib/gift-registry";
import { addGiftListItem, removeGiftListItem, shareGiftList } from "@/actions/gift-registry";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { PartPicker } from "@/components/part-picker";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function GiftListPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const r = await registryView(user.shopId, id);
  if (!r) notFound();
  return (
    <div className="space-y-4">
      <PageHeader
        title={r.title}
        back={r.customerId ? { href: `/customers/${r.customerId}`, label: r.name } : undefined}
        sub={`${r.name}${r.eventDate ? ` · for ${r.eventDate}` : ""} · Bought items are ticked off at the register. Don't tell her what was bought.`}
      />
      <div className="card card-pad space-y-2 text-base">
        {r.closedAt ? (
          <>
            <p>Not shared: the link doesn&apos;t work.</p>
            <ActionButton action={shareGiftList.bind(null, r.id, true)} className="btn btn-primary">
              Share it again (a new link)
            </ActionButton>
          </>
        ) : r.link ? (
          <>
            <p>Send her this link to pass on to family. It shows what is still wanted, never who bought what.</p>
            <p className="flex flex-wrap items-center gap-2">
              <span className="mono break-all text-sm">{r.link}</span>
              <CopyButton text={r.link} />
            </p>
            <ActionButton action={shareGiftList.bind(null, r.id, false)} className="link text-sm" confirm="Tap again: the link stops working">
              Stop sharing
            </ActionButton>
          </>
        ) : (
          <p>
            {r.hasSlug ? "This install has no public address, so there is no link: print the list instead." : "To share lists by link, give your shop page an address under Settings, Online shop. Meanwhile print the list."}
          </p>
        )}
      </div>
      <Section title="On the list">
        {r.lines.length ? (
          <ul className="divide-y divide-line">
            {r.lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-base">
                <span>
                  {l.description}
                  {l.note ? <span className="muted text-sm"> · {l.note}</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  {l.priceCents != null && <span className="num">{money(l.priceCents)}</span>}
                  <span className={`pill ${l.left === 0 ? "tone-done" : ""}`}>{l.left === 0 ? "All bought" : `${l.bought} of ${l.qtyWanted} bought`}</span>
                  <ActionButton action={removeGiftListItem.bind(null, r.id, l.id)} className="link text-sm" confirm="Tap again to take it off">
                    Take off
                  </ActionButton>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing on the list yet. Add what she would like below.</Empty>
        )}
      </Section>
      <Section title="Add to the list">
        <ActionForm action={addGiftListItem.bind(null, r.id)} reset className="grid gap-3 sm:grid-cols-2">
          <div className="field">
            <span className="label">An item from stock</span>
            <PartPicker />
          </div>
          <div className="field">
            <label className="label" htmlFor="gl-desc">
              Or say what she would like
            </label>
            <input id="gl-desc" name="description" className="input" maxLength={200} placeholder="A walking foot for her Bernina" />
          </div>
          <div className="field">
            <label className="label" htmlFor="gl-qty">
              How many
            </label>
            <input id="gl-qty" name="qty" inputMode="numeric" className="input num w-24" defaultValue="1" />
          </div>
          <div className="field">
            <label className="label" htmlFor="gl-note">
              Note (optional)
            </label>
            <input id="gl-note" name="note" className="input" maxLength={200} placeholder="Color: navy" />
          </div>
          <div className="sm:col-span-2">
            <Submit>Add to the list</Submit>
          </div>
        </ActionForm>
        <p className="muted mt-2 text-sm">
          A gift bought here: ring it up with <Link href="/register" className="link">Gift lists</Link> on the register so it is ticked off.
        </p>
      </Section>
    </div>
  );
}
