// Settings → Shipping labels (shop-features-round-2-design.md 9.5): labels through Shippo on the shop's own account. The
// key (kept locked), the switch, where parcels ship from (filled from the shop's address), and the usual box. Owners
// and admins. Without it, Online orders still export for Pirate Ship.
import { requireAdmin } from "@/lib/session";
import { shippoSettings } from "@/lib/shippo";
import { saveShippoSettings } from "@/actions/shippo";
import { ActionForm, Submit } from "@/components/action-form";
import { PageHeader, Section } from "@/components/ui";

export default async function ShippingSettings() {
  const user = await requireAdmin();
  const s = await shippoSettings(user.shopId);
  const f = (name: string, label: string, value: string, o: { cls?: string; placeholder?: string; inputMode?: "decimal" | "numeric" } = {}) => (
    <div className="field">
      <label className="label" htmlFor={`sh-${name}`}>
        {label}
      </label>
      <input id={`sh-${name}`} name={name} className={`input ${o.cls ?? ""}`} defaultValue={value} placeholder={o.placeholder} inputMode={o.inputMode} />
    </div>
  );
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Shipping labels" back={{ href: "/settings", label: "Settings" }} sub="Buy postage and print labels for online orders right from Online orders, through your own Shippo account (Shippo charges it). Off, you can still export the orders for Pirate Ship." />
      <ActionForm action={saveShippoSettings} className="space-y-6">
        <Section title="Your Shippo account">
          <div className="space-y-3">
            <div className="field">
              <label className="label" htmlFor="sh-key">
                Shippo API key {s.hasKey ? "(saved; paste a new one to change it)" : ""}
              </label>
              <input id="sh-key" name="shippoKey" type="password" autoComplete="off" className="input mono" placeholder={s.hasKey ? "••••••••" : "shippo_live_... or shippo_test_..."} />
              <p className="muted text-sm">From Shippo: Settings, API. Kept locked; never shown again. A test key makes sample labels and charges nothing.</p>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-base">
              <input type="checkbox" name="on" className="check" defaultChecked={s.on} /> Buy labels from Online orders
            </label>
            {s.hasKey && <p className="text-sm">{s.testMode ? "Test mode: sample labels, no charge." : "Live: labels are charged to your Shippo account."}</p>}
          </div>
        </Section>
        <Section title="Parcels ship from">
          <div className="grid gap-3 sm:grid-cols-2">
            {f("fromName", "Name on the label", s.from.name)}
            {f("fromPhone", "Phone", s.from.phone)}
            {f("fromStreet", "Street", s.from.street1)}
            {f("fromCity", "City", s.from.city)}
            {f("fromState", "State (two letters)", s.from.state, { cls: "w-20", placeholder: "IL" })}
            {f("fromZip", "ZIP", s.from.zip, { cls: "w-32", inputMode: "numeric" })}
          </div>
        </Section>
        <Section title="Your usual box">
          <div className="flex flex-wrap gap-3">
            {f("lengthIn", "Length (in)", String(s.parcel.lengthIn), { cls: "num w-24", inputMode: "decimal" })}
            {f("widthIn", "Width (in)", String(s.parcel.widthIn), { cls: "num w-24", inputMode: "decimal" })}
            {f("heightIn", "Height (in)", String(s.parcel.heightIn), { cls: "num w-24", inputMode: "decimal" })}
            {f("weightOz", "Weight packed (oz)", String(s.parcel.weightOz), { cls: "num w-24", inputMode: "decimal" })}
          </div>
          <p className="muted mt-2 text-sm">Each order&apos;s weight can be changed before asking for rates.</p>
        </Section>
        <Submit>Save</Submit>
      </ActionForm>
    </div>
  );
}
