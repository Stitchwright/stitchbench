import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { firstValues } from "@/lib/search-params";
import { ACCESSORIES, MACHINE_TYPES } from "@/lib/constants";
import { money, ticketNo } from "@/lib/format";
import { PageHeader, Section } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { createTicket } from "@/actions/tickets";

export default async function NewTicket({ searchParams }: { searchParams: Promise<{ machineId?: string; customerId?: string }> }) {
  const user = await requireUser();
  const sp = firstValues(await searchParams);
  const [shop, accounts, services, brands, machine] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId } }),
    db.customer.findMany({ where: { shopId: user.shopId, kind: "TRADE" }, orderBy: { name: "asc" } }),
    db.serviceItem.findMany({ where: { shopId: user.shopId, active: true }, orderBy: { sortOrder: "asc" } }),
    db.tensionSpec.findMany({ distinct: ["brand"], select: { brand: true }, orderBy: { brand: "asc" } }),
    sp.machineId ? db.machine.findFirst({ where: { id: sp.machineId, shopId: user.shopId } }) : null,
  ]);
  const presetCustomerId = sp.customerId ?? machine?.customerId ?? "";
  const presetCustomer = presetCustomerId
    ? await db.customer.findFirst({ where: { id: presetCustomerId, shopId: user.shopId, kind: "RETAIL" }, select: { id: true, name: true, phone: true } })
    : null;

  return (
    <div className="max-w-3xl">
      <PageHeader title="Check in a machine" sub={`Next ticket number: ${ticketNo(shop.nextTicketNumber)}`} back={{ href: "/tickets", label: "Tickets" }} />
      <ActionForm action={createTicket} className="space-y-5">
        <Section title="Customer">
          <div className="grid-form">
            <CustomerPicker initial={presetCustomer} />
            <div className="field">
              <label htmlFor="customerName" className="label">
                New customer name
              </label>
              <input id="customerName" name="customerName" className="input" autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="customerPhone" className="label">
                Phone
              </label>
              <input id="customerPhone" name="customerPhone" type="tel" className="input" />
            </div>
            <div className="field">
              <label htmlFor="customerEmail" className="label">
                Email
              </label>
              <input id="customerEmail" name="customerEmail" type="email" className="input" />
            </div>
            <div className="field">
              <label htmlFor="viaAccountId" className="label">
                Came in through (quilt shop / dealer)
              </label>
              <select id="viaAccountId" name="viaAccountId" className="select" defaultValue="">
                <option value="">Direct to us</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code ? `${a.code} - ` : ""}
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Section>

        <Section title="Machine">
          {machine ? (
            <div>
              <input type="hidden" name="machineId" value={machine.id} />
              <p className="font-semibold">
                {machine.brand} {machine.model} {machine.serial && <span className="mono muted">SN {machine.serial}</span>}
              </p>
            </div>
          ) : (
            <div className="grid-form">
              <div className="field">
                <label htmlFor="brand" className="label">
                  Brand
                </label>
                <input id="brand" name="brand" required list="brands" className="input" autoComplete="off" />
                <datalist id="brands">
                  {brands.map((b) => (
                    <option key={b.brand} value={b.brand} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label htmlFor="model" className="label">
                  Model
                </label>
                <input id="model" name="model" required className="input" autoComplete="off" placeholder="e.g. MC6700P" />
              </div>
              <div className="field">
                <label htmlFor="serial" className="label">
                  Serial number
                </label>
                <input id="serial" name="serial" className="input mono" autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="machineType" className="label">
                  Machine type
                </label>
                <select id="machineType" name="machineType" className="select" defaultValue="">
                  <option value="">-</option>
                  {MACHINE_TYPES.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </div>
              <p className="muted text-xs sm:col-span-2">A serial number we&apos;ve seen before links this ticket to that machine&apos;s history.</p>
            </div>
          )}
        </Section>

        <Section title="Work">
          <div className="grid-form">
            <div className="field sm:col-span-2">
              <label htmlFor="serviceItemId" className="label">
                Service
              </label>
              <select id="serviceItemId" name="serviceItemId" className="select" defaultValue="">
                <option value="">Decide after diagnosis</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {money(s.priceCents)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field sm:col-span-2">
              <label htmlFor="problem" className="label">
                Problem reported
              </label>
              <textarea id="problem" name="problem" rows={3} className="textarea" placeholder="In the customer's words" />
            </div>
            <div className="field">
              <label htmlFor="preApproved" className="label">
                Pre-approved over the service ($)
              </label>
              <input id="preApproved" name="preApproved" inputMode="decimal" className="input num" placeholder="75.00" />
            </div>
            <div className="field">
              <label htmlFor="number" className="label">
                Paper ticket number (optional)
              </label>
              <input id="number" name="number" inputMode="numeric" className="input mono" placeholder={ticketNo(shop.nextTicketNumber)} />
            </div>
          </div>
        </Section>

        <Section title="Accessories that came with it">
          <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <legend className="sr-only">Accessories</legend>
            {ACCESSORIES.filter((a) => a !== "Other").map((a) => (
              <label key={a} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="accessories" value={a} className="check" defaultChecked={a === "Power cord" || a === "Foot control"} />
                {a}
              </label>
            ))}
          </fieldset>
          <div className="field mt-3">
            <label htmlFor="accessoriesOther" className="label">
              Other items (comma separated)
            </label>
            <input id="accessoriesOther" name="accessoriesOther" className="input" placeholder="walking foot, 1/4 inch foot" />
          </div>
        </Section>

        <div className="flex justify-end">
          <Submit>Create ticket</Submit>
        </div>
      </ActionForm>
    </div>
  );
}
