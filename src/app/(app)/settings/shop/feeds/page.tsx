// Settings → Online shop → Google and Facebook (shop-features-round-2-design.md 4.1, 4.2): show the shop's stock on
// Google ("in stock nearby") and its items on Facebook and Instagram. Guided steps in plain words, the three feed links
// to paste, how many items go in, and what's left out and why ("No barcode"). Owners and admins switch it on.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { feedView } from "@/lib/shop/feeds";
import { GOOGLE_MIN_ITEMS } from "@/lib/shop/feeds-math";
import { newFeedLinks, turnFeedsOff, turnFeedsOn } from "@/actions/feeds";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { Empty, PageHeader, Section } from "@/components/ui";

function FeedLink({ label, url }: { label: string; url: string }) {
  return (
    <div className="space-y-1">
      <p className="text-base font-semibold">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all rounded border border-line px-2 py-1 text-sm">{url}</code>
        <CopyButton text={url} label="Copy" />
      </div>
    </div>
  );
}

export default async function FeedsPage() {
  const user = await requireUser();
  const v = await feedView(user.shopId);
  const admin = user.role !== "TECH";
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Google and Facebook"
        sub="Shoppers searching Google see what you have on the shelf, and your items show on Facebook and Instagram. Both send them to your own online shop."
        back={{ href: "/settings/shop", label: "Online shop" }}
      />
      {v.problem && <p className="card card-pad text-base">{v.problem}</p>}

      {!v.on ? (
        <Section title="Show your stock on Google and Facebook">
          <ol className="list-decimal space-y-2 pl-6 text-base">
            <li>Switch this on below. We make three links that Google and Facebook read every day.</li>
            <li>Items go in when they are listed in your online shop with a price and a barcode (UPC or EAN on the package).</li>
            <li>Then follow the steps shown here for Google and for Facebook. It takes about half an hour, then Google checks your shop for a few days.</li>
          </ol>
          {admin ? (
            <ActionForm action={turnFeedsOn} success="Switched on. Your links are below." className="mt-4 space-y-3">
              <div className="field max-w-sm">
                <label htmlFor="feed-store" className="label">
                  Store code from your Google Business Profile (you can add it later)
                </label>
                <input id="feed-store" name="storeCode" className="input text-base" maxLength={60} placeholder="MAIN" />
              </div>
              <div className="flex justify-end">
                <Submit className="btn btn-primary min-h-11 text-base">Show my stock on Google and Facebook</Submit>
              </div>
            </ActionForm>
          ) : (
            <p className="muted mt-3 text-base">An owner or admin switches this on.</p>
          )}
        </Section>
      ) : (
        <>
          <Section title="What goes in">
            <p className="text-base">
              <span className="num text-xl font-semibold">{v.google}</span> item{v.google === 1 ? "" : "s"} on Google,{" "}
              <span className="num text-xl font-semibold">{v.meta}</span> on Facebook and Instagram.
            </p>
            {v.google < GOOGLE_MIN_ITEMS && (
              <p className="muted mt-2 text-base">
                Google asks for at least {GOOGLE_MIN_ITEMS} items with barcodes before it shows your stock. Scan the barcode on an item&apos;s page (Barcode), and tick &ldquo;Sell
                online&rdquo;.
              </p>
            )}
            {v.notListed > 0 && (
              <p className="muted mt-2 text-base">
                {v.notListed} item{v.notListed === 1 ? " has" : "s have"} a barcode but {v.notListed === 1 ? "isn't" : "aren't"} listed in your online shop yet.{" "}
                <Link href="/parts" className="link">
                  Open Inventory
                </Link>
              </p>
            )}
          </Section>

          {v.links && (
            <Section title="Your feed links">
              <div className="space-y-4">
                <FeedLink label="Google: products" url={v.links.google} />
                <FeedLink label="Google: what's on the shelf (local inventory)" url={v.links.local} />
                <FeedLink label="Facebook and Instagram: catalog" url={v.links.meta} />
              </div>
              <p className="muted mt-3 text-sm">Keep these links to yourself: anyone with them can read your prices and stock counts.</p>
            </Section>
          )}

          <Section title="Steps for Google">
            <ol className="list-decimal space-y-2 pl-6 text-base">
              <li>
                Make sure your shop has a Google Business Profile (the listing that shows on Google Maps). Note its <strong>store code</strong> (in the profile&apos;s Advanced
                settings) and type it below.
              </li>
              <li>Open Google Merchant Center (merchants.google.com) with the same Google account and link your Business Profile when it asks.</li>
              <li>Under Products, choose Add products from a file, then &ldquo;Add a link to your file&rdquo;: paste the Google products link, daily.</li>
              <li>Under Settings, Local inventory (or &ldquo;In-store products&rdquo;), add a second file the same way: paste the &ldquo;what&apos;s on the shelf&rdquo; link, daily.</li>
              <li>Google checks your shop. Items usually show within a few days.</li>
            </ol>
            {admin && (
              <ActionForm action={turnFeedsOn} success="Saved" className="mt-4 flex flex-wrap items-end gap-3">
                <div className="field">
                  <label htmlFor="feed-store2" className="label">
                    Store code
                  </label>
                  <input id="feed-store2" name="storeCode" defaultValue={v.storeCode ?? ""} className="input text-base" maxLength={60} placeholder="MAIN" />
                </div>
                <Submit className="btn min-h-11 text-base">Save the store code</Submit>
              </ActionForm>
            )}
          </Section>

          <Section title="Steps for Facebook and Instagram">
            <ol className="list-decimal space-y-2 pl-6 text-base">
              <li>Open Meta Commerce Manager (business.facebook.com/commerce) with the account that runs your shop&apos;s Facebook page.</li>
              <li>Make a catalog for &ldquo;Ecommerce&rdquo;, then Data sources, Data feed, Use a URL: paste the Facebook and Instagram link and choose daily.</li>
              <li>Shoppers who tap an item go to its page in your own online shop and pay there.</li>
            </ol>
          </Section>

          <Section title="Listed online but not in the feeds">
            {v.left.length === 0 ? (
              <Empty>Everything listed in your online shop is in the feeds.</Empty>
            ) : (
              <ul className="divide-y divide-line text-base">
                {v.left.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                    <Link href={`/parts/${l.id}`} className="link">
                      {l.partNumber} {l.title}
                    </Link>
                    <span className="muted">{l.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {admin && (
            <details>
              <summary className="link cursor-pointer text-base">More choices</summary>
              <div className="mt-3 flex flex-wrap gap-3">
                <ActionButton action={newFeedLinks} className="btn min-h-11 text-base" confirm="Tap again: the old links stop working" success="New links made. Paste them into Google and Facebook again.">
                  Make new links
                </ActionButton>
                <ActionButton action={turnFeedsOff} className="btn min-h-11 text-base" confirm="Tap again to switch the feeds off" success="Switched off. Google and Facebook drop your items in a day or two.">
                  Switch the feeds off
                </ActionButton>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
