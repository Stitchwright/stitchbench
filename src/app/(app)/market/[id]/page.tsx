import Link from "next/link";
import { notFound } from "next/navigation";
import { Trash2 } from "lucide-react";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { KIND_LABEL } from "@/lib/parts";
import { PageHeader, Section, KV } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CONDITION_LABEL, MarketNav, Stars } from "@/components/market-ui";
import { placeOrder, removeListing, updateListing } from "@/actions/market";

const d2 = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const found = await db.listing.findUnique({ where: { id } });
  if (!found) notFound();
  // "Mine" means this company's: another company on the same install sees it like any other shop's listing.
  const l = { ...found, mine: found.mine && found.shopId === user.shopId };
  const sameInstall = found.mine && !l.mine;
  const [shop, xpart] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { address: true, name: true } }),
    l.xpartId ? db.xPart.findUnique({ where: { id: l.xpartId }, select: { id: true, name: true } }) : null,
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: l.mine ? "/market/mine" : "/market", label: l.mine ? "My listings" : "Marketplace" }}
        title={l.title}
        sub={
          <>
            {l.mine ? (
              "Your listing"
            ) : l.sellerId ? (
              <>
                Sold by{" "}
                <Link href={`/market/shops/${l.sellerId}`} className="link">
                  {l.shopName}
                </Link>{" "}
                <Stars avg={l.sellerAvg} count={l.sellerCount} />
              </>
            ) : (
              `Sold by ${l.shopName}`
            )}
            {l.shipsFrom ? ` · ships from ${l.shipsFrom}` : ""}
          </>
        }
      />
      <MarketNav current={l.mine ? "mine" : "browse"} />
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          {l.photoIds.length > 0 && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {l.photoIds.map((pid) => (
                <li key={pid}>
                  <a href={`/api/listing-photos/${pid}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded border border-line">
                    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated image route */}
                    <img src={`/api/listing-photos/${pid}`} alt={l.title} className="aspect-square w-full bg-white object-contain" loading="lazy" />
                  </a>
                </li>
              ))}
            </ul>
          )}
          <Section title="Details">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <KV k="Price each" v={<span className="num text-lg font-semibold">{money(l.priceCents)}</span>} />
              <KV k="Available" v={String(l.qty)} />
              <KV k="Shipping" v={l.shippingCents != null ? money(l.shippingCents) : "Quoted with the invoice"} />
              <KV k="Condition" v={CONDITION_LABEL[l.condition] ?? l.condition} />
              <KV k="Type" v={KIND_LABEL[l.kind] ?? l.kind} />
              <KV k="Part number" v={l.partNumber ? <span className="mono">{l.partNumber}</span> : "-"} />
              {l.brand && <KV k="Brand" v={l.brand} />}
              {l.fits && <KV k="Fits" v={l.fits} />}
            </div>
            {l.description && <p className="mt-4 text-sm whitespace-pre-wrap">{l.description}</p>}
            {l.shippingNote && <p className="muted mt-2 text-sm">Shipping: {l.shippingNote}</p>}
            {xpart && (
              <p className="mt-3 text-sm">
                Cross-reference:{" "}
                <Link href={`/xref/${xpart.id}`} className="link">
                  {xpart.name}
                </Link>{" "}
                (every number it goes by and what it fits)
              </p>
            )}
          </Section>
        </div>
        <div className="space-y-6 xl:col-span-2">
          {l.mine ? (
            <Section title="Change your listing">
              <ActionForm action={updateListing.bind(null, l.id)} success="Listing updated" className="grid-form">
                <div className="field">
                  <label htmlFor="ul-price" className="label">
                    Price each ($)
                  </label>
                  <input id="ul-price" name="price" defaultValue={d2(l.priceCents)} className="input num" />
                </div>
                <div className="field">
                  <label htmlFor="ul-qty" className="label">
                    Available
                  </label>
                  <input id="ul-qty" name="qty" defaultValue={l.qty} className="input num" />
                </div>
                <div className="field">
                  <label htmlFor="ul-ship" className="label">
                    Shipping ($, blank = quote)
                  </label>
                  <input id="ul-ship" name="shipping" defaultValue={d2(l.shippingCents)} className="input num" />
                </div>
                <div className="field">
                  <label htmlFor="ul-status" className="label">
                    Status
                  </label>
                  <select id="ul-status" name="status" defaultValue={l.status === "PAUSED" ? "PAUSED" : "ACTIVE"} className="select">
                    <option value="ACTIVE">For sale</option>
                    <option value="PAUSED">Paused</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <Submit>Save</Submit>
                </div>
              </ActionForm>
              <div className="mt-4 border-t border-line pt-4">
                <ActionButton action={removeListing.bind(null, l.id)} className="btn btn-sm btn-danger" confirm="Take it off the marketplace?" title="Remove listing">
                  <Trash2 size={12} aria-hidden /> Remove listing
                </ActionButton>
              </div>
            </Section>
          ) : sameInstall ? (
            <p className="muted text-sm">Listed by another company on this same StitchBench, so it can&apos;t be ordered through the hub from here.</p>
          ) : l.status === "ACTIVE" && l.qty > 0 ? (
            <Section title="Order from this shop">
              <ActionForm action={placeOrder.bind(null, l.id)} className="space-y-3">
                <div className="field">
                  <label htmlFor="po-qty" className="label">
                    How many
                  </label>
                  <input id="po-qty" name="qty" defaultValue={1} inputMode="numeric" className="input num w-24" required />
                </div>
                <div className="field">
                  <label htmlFor="po-ship" className="label">
                    Ship to
                  </label>
                  <textarea id="po-ship" name="shipTo" rows={3} defaultValue={shop.address ? `${shop.name}\n${shop.address}` : ""} className="textarea" required />
                </div>
                <div className="field">
                  <label htmlFor="po-note" className="label">
                    Note to the seller (optional)
                  </label>
                  <input id="po-note" name="note" className="input" placeholder="e.g. need it by Friday" />
                </div>
                <p className="muted text-xs">
                  The seller confirms and sends an invoice with how to pay them. Nothing is charged here. Your shop name, email and phone go with the order.
                </p>
                <Submit>Send order</Submit>
              </ActionForm>
            </Section>
          ) : (
            <Section title="Not available">
              <p className="muted text-sm">This listing is {l.status === "SOLD_OUT" || l.qty === 0 ? "sold out" : "paused"}.</p>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
