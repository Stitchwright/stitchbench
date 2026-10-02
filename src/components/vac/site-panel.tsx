// Where and when a central vac install happens, on its ticket (modules-design.md 10.d): the address with a maps
// link, the window (or "Not scheduled"), the contact and access notes, and (unless read-only) "Change" and "Set the
// power unit".
import { ExternalLink } from "lucide-react";
import type { CurrentUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { VACUUM_BRANDS } from "@/lib/equipment/vacuum";
import { siteOf } from "@/lib/vac/installs";
import { fmtRange } from "@/lib/zoned";
import { saveSite, setPowerUnit } from "@/actions/vac-installs";
import { ActionForm, Submit } from "@/components/action-form";
import { KV, Section } from "@/components/ui";
import { SiteFields } from "@/components/vac/site-fields";

export const mapsHref = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

export async function SitePanel({ ticketId, user, readOnly }: { ticketId: string; user: CurrentUser; readOnly: boolean }) {
  const [site, tz] = await Promise.all([siteOf(user.shopId, ticketId), shopTimeZone(user.shopId)]);
  if (!site) return null;
  return (
    <Section title="The site">
      <div className="grid gap-4 sm:grid-cols-2">
        <KV
          k="Where"
          v={
            <a href={mapsHref(site.address)} target="_blank" rel="noreferrer" className="link">
              {site.address} <ExternalLink size={10} className="inline" aria-hidden />
            </a>
          }
        />
        <KV k="When" v={site.startsAt && site.endsAt ? fmtRange(site.startsAt, site.endsAt, tz) : <span className="pill tone-wait">Not scheduled</span>} />
        <KV k="Contact on site" v={[site.contactName, site.contactPhone].filter(Boolean).join(" · ")} />
        <KV k="Access notes" v={site.accessNotes} />
        <KV k="Power unit" v={site.unit ?? <span className="muted">to be chosen</span>} />
      </div>
      {!readOnly && (
        <div className="mt-4 space-y-3">
          <details>
            <summary className="cursor-pointer text-sm font-semibold">Change</summary>
            <ActionForm action={saveSite.bind(null, ticketId)} success="Saved" className="mt-2 space-y-3">
              <div className="grid-form">
                <SiteFields site={site} tz={tz} />
              </div>
              <Submit className="btn">Save the site</Submit>
            </ActionForm>
          </details>
          <details>
            <summary className="cursor-pointer text-sm font-semibold">Set the power unit</summary>
            <ActionForm action={setPowerUnit.bind(null, ticketId)} success="Power unit set" className="mt-2 space-y-3">
              <div className="grid-form">
                <div className="field">
                  <label htmlFor="pu-brand" className="label">
                    Brand
                  </label>
                  <input id="pu-brand" name="unitBrand" list="pu-brands" required className="input" />
                  <datalist id="pu-brands">
                    {VACUUM_BRANDS.map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </div>
                <div className="field">
                  <label htmlFor="pu-model" className="label">
                    Model
                  </label>
                  <input id="pu-model" name="unitModel" required className="input" />
                </div>
                <div className="field">
                  <label htmlFor="pu-serial" className="label">
                    Serial
                  </label>
                  <input id="pu-serial" name="unitSerial" className="input mono" />
                </div>
              </div>
              <Submit className="btn">Set the power unit</Submit>
            </ActionForm>
          </details>
        </div>
      )}
    </Section>
  );
}
