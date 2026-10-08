// Settings -> Online shop (online-and-parts-design.md section 3): the page's address (shared with online booking),
// on / off, pickup and shipping, who takes the money (the shop's own Stripe account, its keys sealed; or the hosted
// service's), the welcome and pickup instructions, whether order mail counts toward the daily cap, the link and the
// embed snippet. Owners and admins edit; it needs a counter and a public address (a hosted feature).
import Link from "next/link";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { publicBaseUrl } from "@/lib/messaging/settings";
import { isDesktop } from "@/lib/modules";
import { requireUser } from "@/lib/session";
import { platformStripeOn, shopSettings, shopUrl, webhookUrl } from "@/lib/shop/online-shop";
import { saveShopSettings } from "@/actions/online-shop";
import { ActionForm, Submit } from "@/components/action-form";
import { PageHeader, Section } from "@/components/ui";

export default async function ShopSettingsPage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const [s, shop] = await Promise.all([shopSettings(shopId), db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true } })]);
  const admin = user.role !== "TECH";
  const base = publicBaseUrl();
  const url = shopUrl(s.slug);
  const hook = webhookUrl(shopId);
  const platform = platformStripeOn();
  if (!s.sellsRetail) {
    return (
      <div className="max-w-3xl space-y-6">
        <PageHeader title="Online shop" back={{ href: "/settings", label: "Settings" }} />
        <p className="card card-pad text-sm">
          The online shop sells what the counter stocks. Turn on &ldquo;Sells over the counter&rdquo; under{" "}
          <Link href="/settings" className="link">
            Settings
          </Link>{" "}
          first.
        </p>
      </div>
    );
  }
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Online shop"
        sub="Customers buy listed items from your inventory on your website, pay by card through Stripe, and pick up or have them shipped. Each order lands in the register's books."
        back={{ href: "/settings", label: "Settings" }}
      />
      {!base && (
        <p className="card card-pad text-sm">
          {isDesktop()
            ? "The online shop is a hosted feature: it needs a public address that Stripe can reach. This program has none; the hosted version has one built in."
            : "This install has no PUBLIC_URL set, so the shop page has no address customers can open. Ask the operator to set it."}
        </p>
      )}
      {url && s.on && (
        <Section title="Your shop page">
          <p className="text-sm">
            <a href={url} className="link" target="_blank" rel="noreferrer">
              {url}
            </a>
          </p>
          <p className="muted mt-2 text-xs">
            {s.listed} item{s.listed === 1 ? "" : "s"} listed: tick &ldquo;Sell online&rdquo; on an item&apos;s page under{" "}
            <Link href="/parts" className="link">
              Parts
            </Link>
            . Put the link on your website, or embed the page:
          </p>
          <pre className="mt-1 overflow-x-auto rounded border border-line p-2 text-xs">{`<iframe src="${url}" title="Shop ${shop.name}" style="width:100%;height:1000px;border:0"></iframe>`}</pre>
        </Section>
      )}
      {s.on && (
        <Section title="Google and Facebook">
          <p className="text-base">Show what you have on the shelf on Google, and your items on Facebook and Instagram.</p>
          <Link href="/settings/shop/feeds" className="btn mt-3 min-h-11 text-base">
            Show your stock on Google and Facebook
          </Link>
        </Section>
      )}
      <ActionForm action={saveShopSettings} success="Saved" className="space-y-6">
        <fieldset disabled={!admin} className="space-y-6">
          <Section title="The page">
            <div className="grid-form">
              <div className="field">
                <label htmlFor="sh-slug" className="label">
                  Address (after /shop/; the same as your booking page)
                </label>
                <input id="sh-slug" name="slug" defaultValue={s.slug ?? ""} className="input" maxLength={40} placeholder="your-shop-name" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="hidden" name="on" value="off" />
                <input type="checkbox" name="on" value="on" defaultChecked={s.on} className="check" /> The online shop is on
              </label>
              <div className="field">
                <label htmlFor="sh-welcome" className="label">
                  Welcome (shown at the top)
                </label>
                <textarea id="sh-welcome" name="welcome" defaultValue={s.welcome ?? ""} rows={2} maxLength={500} className="input" />
              </div>
            </div>
          </Section>
          <Section title="Pickup and shipping">
            <div className="grid-form">
              <label className="flex items-center gap-2 text-sm">
                <input type="hidden" name="pickup" value="off" />
                <input type="checkbox" name="pickup" value="on" defaultChecked={s.pickup} className="check" /> Pickup at the shop
              </label>
              <div className="field">
                <label htmlFor="sh-pickup-note" className="label">
                  Pickup instructions (in the &ldquo;ready&rdquo; message)
                </label>
                <input id="sh-pickup-note" name="pickupNote" defaultValue={s.pickupNote ?? ""} className="input" maxLength={300} placeholder="Come to the counter with your order number." />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="hidden" name="shipping" value="off" />
                <input type="checkbox" name="shipping" value="on" defaultChecked={s.shipping} className="check" /> Shipping
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="field">
                  <label htmlFor="sh-ship" className="label">
                    Flat shipping rate
                  </label>
                  <input id="sh-ship" name="shipRate" defaultValue={(s.shipCents / 100).toFixed(2)} inputMode="decimal" className="input num" />
                </div>
                <div className="field">
                  <label htmlFor="sh-free" className="label">
                    Free shipping on orders over (blank: never)
                  </label>
                  <input id="sh-free" name="freeOver" defaultValue={s.freeOverCents != null ? (s.freeOverCents / 100).toFixed(2) : ""} inputMode="decimal" className="input num" />
                </div>
              </div>
            </div>
          </Section>
          <Section title="Sales tax on online orders">
            <div className="space-y-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="radio" name="taxVia" value="rate" defaultChecked={s.taxVia === "rate"} className="check mt-1" />
                <span>
                  <span className="font-semibold">My rate</span> ({s.taxRatePct}%, from Settings), as at the counter: items taxed, shipping not, pickup and shipped orders alike.
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="taxVia" value="stripe" defaultChecked={s.taxVia === "stripe"} className="check mt-1" />
                <span>
                  <span className="font-semibold">Stripe Tax.</span>{" "}Shipped orders are taxed by the delivery address at checkout, shipping included where that state taxes it; pickup orders stay at my
                  rate. Needs Stripe Tax switched on in your Stripe dashboard, and your own Stripe account (not StitchShop&apos;s). The sale in the books records the tax Stripe charged.
                </span>
              </label>
            </div>
          </Section>
          <Section title="Payments">
            <div className="grid-form">
              <div className="space-y-2 text-sm">
                <label className="flex items-start gap-2">
                  <input type="radio" name="payVia" value="own" defaultChecked={s.payVia === "own"} className="check mt-1" />
                  <span>
                    <span className="font-semibold">Your own Stripe account.</span>{" "}Customers pay you directly; Stripe pays out to your bank. Paste the account&apos;s secret key and, after adding the
                    webhook below in Stripe, its signing secret.
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" name="payVia" value="platform" defaultChecked={s.payVia === "platform"} disabled={!platform} className="check mt-1" />
                  <span>
                    <span className="font-semibold">Through StitchShop&apos;s account.</span>{" "}
                    {platform ? "Customers pay the hosted service, which pays you out. Nothing to set up here." : "Not offered on this server."}
                  </span>
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="field">
                  <label htmlFor="sh-key" className="label">
                    Stripe secret key {s.hasStripeKey ? "(saved; blank keeps it)" : ""}
                  </label>
                  <input id="sh-key" name="stripeKey" type="password" autoComplete="off" className="input mono" placeholder="sk_live_…" />
                </div>
                <div className="field">
                  <label htmlFor="sh-wh" className="label">
                    Webhook signing secret {s.hasWebhookSecret ? "(saved; blank keeps it)" : ""}
                  </label>
                  <input id="sh-wh" name="stripeWebhook" type="password" autoComplete="off" className="input mono" placeholder="whsec_…" />
                </div>
              </div>
              {hook && (
                <p className="muted text-xs">
                  In Stripe, Developers &rarr; Webhooks &rarr; Add endpoint: <span className="mono">{hook}</span>, events <span className="mono">checkout.session.completed</span>,{" "}
                  <span className="mono">checkout.session.async_payment_succeeded</span>, <span className="mono">checkout.session.async_payment_failed</span> and{" "}
                  <span className="mono">checkout.session.expired</span>. Payments are also confirmed when the customer comes back from Stripe&apos;s page, so a slow webhook only delays the books,
                  never the sale. For fabric clubs (the Clubs tab on the Fabric page) add the events <span className="mono">invoice.paid</span>,{" "}
                  <span className="mono">invoice.payment_failed</span>, <span className="mono">customer.subscription.updated</span>, <span className="mono">customer.subscription.deleted</span> and{" "}
                  <span className="mono">charge.refunded</span> (a club payment refunded in Stripe is taken back here) to the same endpoint.
                </p>
              )}
              {(s.hasStripeKey || s.hasWebhookSecret) && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="hidden" name="clearKeys" value="off" />
                  <input type="checkbox" name="clearKeys" value="on" className="check" /> Forget the saved Stripe keys
                </label>
              )}
            </div>
          </Section>
          <Section title="Order messages">
            <p className="muted text-sm">
              With Marketing on, customers get a message when the order is paid, ready to pick up, shipped or cancelled, the way they asked to be told. The wording is under Messages &rarr; Wording.
            </p>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="hidden" name="ordersInCap" value="off" />
              <input type="checkbox" name="ordersInCap" value="on" defaultChecked={s.ordersInCap} className="check" /> Count order messages toward the daily sending cap (off: they go like notices,
              uncapped)
            </label>
          </Section>
          {admin && <Submit>Save</Submit>}
        </fieldset>
      </ActionForm>
      {s.shipping && s.shipCents === 0 && s.on && <p className="muted text-xs">Shipping is on at {money(0)}: customers ship free.</p>}
    </div>
  );
}
