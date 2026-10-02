// The install address and dates on an invoice (modules-design.md 10.d). Scoped by { ticketId, shopId }.
import { shopTimeZone } from "@/lib/shop-zone";
import { siteOf } from "@/lib/vac/installs";
import { fmtRange } from "@/lib/zoned";

export async function SiteInvoiceBlock({ ticketId, shopId }: { ticketId: string; shopId: string }) {
  const [site, tz] = await Promise.all([siteOf(shopId, ticketId), shopTimeZone(shopId)]);
  if (!site) return null;
  return (
    <section className="border-b border-line py-4 text-sm">
      <div className="label">Work done at</div>
      <div className="font-semibold">{site.address}</div>
      {site.startsAt && site.endsAt && <div>{fmtRange(site.startsAt, site.endsAt, tz)}</div>}
      {site.contactName && <div className="muted">Contact: {[site.contactName, site.contactPhone].filter(Boolean).join(" · ")}</div>}
    </section>
  );
}
