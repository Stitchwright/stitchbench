// New central vac install (modules-design.md 10.d): the customer (picked or new), the site and window, the power unit
// if chosen, "Quote first", the service from the vacuum menu, notes. Lands on the new SITE ticket.
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { servicesFor } from "@/lib/equipment/shop";
import { VACUUM_BRANDS } from "@/lib/equipment/vacuum";
import { shopTimeZone } from "@/lib/shop-zone";
import { createInstall } from "@/actions/vac-installs";
import { ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { Section } from "@/components/ui";
import { SiteFields } from "@/components/vac/site-fields";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

export default async function NewInstall() {
  const user = await requireUser();
  const s = await vacPageState(user);
  if (s.gate !== "write") redirect("/vac/installs");
  const [tz, services] = await Promise.all([shopTimeZone(user.shopId), servicesFor(user.shopId, "vacuum")]);
  return (
    <VacFrame title="New install" tab="installs" {...s}>
      <ActionForm action={createInstall} className="max-w-3xl space-y-4">
        <Section title="Customer">
          <div className="grid-form">
            <CustomerPicker initial={null} newBox />
            <div className="field">
              <label htmlFor="customerName" className="label">
                Or a new customer: name
              </label>
              <input id="customerName" name="customerName" className="input" autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="customerPhone" className="label">
                Phone
              </label>
              <input id="customerPhone" name="customerPhone" className="input" />
            </div>
            <div className="field">
              <label htmlFor="customerEmail" className="label">
                Email
              </label>
              <input id="customerEmail" name="customerEmail" type="email" className="input" />
            </div>
            <div className="field">
              <label htmlFor="customerAddress" className="label">
                Home address
              </label>
              <input id="customerAddress" name="customerAddress" className="input" />
            </div>
          </div>
        </Section>
        <Section title="The site">
          <div className="grid-form">
            <SiteFields tz={tz} idPrefix="new" />
          </div>
        </Section>
        <Section title="The job">
          <div className="grid-form">
            <div className="field">
              <label htmlFor="serviceItemId" className="label">
                Service
              </label>
              <select id="serviceItemId" name="serviceItemId" className="select" defaultValue="">
                <option value="">Central vac install (no price yet)</option>
                {services.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                    {it.priceCents ? ` · ${money(it.priceCents)}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" name="quoteFirst" className="check" />{" "}Quote first (the customer OKs a quote before it&apos;s booked)
            </label>
            <div className="field">
              <label htmlFor="unitBrand" className="label">
                Power unit brand (if chosen)
              </label>
              <input id="unitBrand" name="unitBrand" list="unit-brands" className="input" />
              <datalist id="unit-brands">
                {VACUUM_BRANDS.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label htmlFor="unitModel" className="label">
                Power unit model
              </label>
              <input id="unitModel" name="unitModel" className="input" />
            </div>
            <div className="field">
              <label htmlFor="unitSerial" className="label">
                Serial
              </label>
              <input id="unitSerial" name="unitSerial" className="input mono" />
            </div>
            <div className="field sm:col-span-2">
              <label htmlFor="notes" className="label">
                Notes (inlets wanted, pipe run, what was quoted)
              </label>
              <textarea id="notes" name="notes" rows={3} className="textarea" />
            </div>
          </div>
        </Section>
        <Submit>Create the install</Submit>
      </ActionForm>
    </VacFrame>
  );
}
