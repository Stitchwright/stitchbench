import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { firstValues } from "@/lib/search-params";
import { money, ticketNo } from "@/lib/format";
import { getModules } from "@/lib/modules";
import { gateFor } from "@/lib/module-gate";
import { entryFor } from "@/lib/assistant/ui";
import { PlateButton } from "@/components/assistant/plate-button";
import { needNotifyBy } from "@/lib/customer-input";
import { canWorkOn } from "@/lib/equipment/gate";
import { kindByKey, kindOf, servicesFor, shopKinds } from "@/lib/equipment/shop";
import { SEWING_KIND } from "@/lib/equipment/sewing";
import { withArticle } from "@/lib/equipment/types";
import { PageHeader, Section } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { NotifyByField } from "@/components/notify-by-field";
import { ModuleNotice } from "@/components/module-notice";
import { KindChips } from "@/components/equipment/kind-chips";
import { IntakeFields } from "@/components/equipment/intake-fields";
import { createTicket } from "@/actions/tickets";

export default async function NewTicket({ searchParams }: { searchParams: Promise<{ machineId?: string; customerId?: string; kind?: string }> }) {
  const user = await requireUser();
  const sp = firstValues(await searchParams);
  const [shop, kinds, machine] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId } }),
    shopKinds(user.shopId),
    sp.machineId ? db.machine.findFirst({ where: { id: sp.machineId, shopId: user.shopId } }) : null,
  ]);
  // What is being checked in: a preselected machine's own kind; else the kind asked for; else the shop's usual one
  // while it may take new work; else a sewing machine.
  const kind = machine
    ? await kindOf(user.shopId, machine)
    : sp.kind
      ? await kindByKey(user.shopId, sp.kind)
      : (kinds.usable.find((k) => k.key === shop.checkInKind) ?? SEWING_KIND);
  const usable = machine ? await canWorkOn(user.shopId, machine.equipment) : kinds.usable.some((k) => k.key === kind.key);
  const sewing = kind.key === "sewing";
  // "How should we tell them": asked (required) while Marketing is on and email or texts are ready; offered as an
  // optional choice while Marketing isn't hidden; not shown otherwise.
  const [accounts, services, specBrands, presetCustomer, blocked, needNotify, marketingGate, plate] = await Promise.all([
    db.customer.findMany({ where: { shopId: user.shopId, kind: "TRADE" }, orderBy: { name: "asc" } }),
    servicesFor(user.shopId, kind.key),
    sewing ? db.tensionSpec.findMany({ distinct: ["brand"], select: { brand: true }, orderBy: { brand: "asc" } }) : [],
    (async () => {
      const id = sp.customerId ?? machine?.customerId ?? "";
      return id ? db.customer.findFirst({ where: { id, shopId: user.shopId, kind: "RETAIL" }, select: { id: true, name: true, phone: true } }) : null;
    })(),
    !usable && kind.module ? getModules(user.shopId).then((m) => m.states[kind.module!]) : null,
    needNotifyBy(user.shopId),
    gateFor(user.shopId, "marketing"),
    // "Read the plate" beside Brand / Model / Serial: free reads need no module; hidden for a machine already chosen.
    machine ? Promise.resolve({ show: false } as const) : entryFor(user.shopId, "plate", { module: false }),
  ]);
  const brands = sewing ? specBrands.map((b) => b.brand) : kind.brands;
  const chipHref = (key: string) => `/tickets/new?kind=${encodeURIComponent(key)}${sp.customerId ? `&customerId=${encodeURIComponent(sp.customerId)}` : ""}`;
  const noun = kind.noun;

  return (
    <div className="max-w-3xl">
      <PageHeader title={`Check in ${withArticle(noun)}`} sub={`Next ticket number: ${ticketNo(shop.nextTicketNumber)}`} back={{ href: "/tickets", label: "Tickets" }} />
      {!machine && (
        <div className="mb-5">
          <KindChips kinds={kinds.usable} active={kind.key} hrefFor={chipHref} label="What you're checking in" />
        </div>
      )}

      {!usable ? (
        // The kind's module is off or has ended (or the kind was taken off "What you repair"): no new work in it.
        <div className="space-y-3">
          {blocked ? (
            <ModuleNotice state={blocked} what={`Every ${noun} already here`} admin={user.role !== "TECH"} shop={shop} />
          ) : (
            <div className="card card-pad text-sm" role="status">
              <strong>{kind.plural} aren&apos;t checked in here any more.</strong> What&apos;s already here stays to look at and finish.
            </div>
          )}
          <p className="text-sm">
            <Link href={chipHref("sewing")} className="link">
              Check in a sewing machine instead
            </Link>
          </p>
        </div>
      ) : (
        <ActionForm action={createTicket} className="space-y-5">
          <input type="hidden" name="kind" value={kind.key} />
          <Section title="Customer">
            <div className="grid-form">
              <CustomerPicker initial={presetCustomer} notifyRequired={needNotify} newBox />
              <div className="field">
                <label htmlFor="customerName" className="label">
                  Or a new customer&apos;s name
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
                  Email address
                </label>
                <input id="customerEmail" name="customerEmail" type="email" className="input" />
              </div>
              {marketingGate !== "hidden" && <NotifyByField required={needNotify} name="notifyBy" />}
              <div className="field">
                <label htmlFor="viaAccountId" className="label">
                  {sewing ? "Came in through (quilt shop / dealer)" : "Came in through (dealer / partner shop)"}
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

          <Section title={sewing ? "Machine" : kind.label}>
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
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </div>
                <div className="field">
                  <label htmlFor="model" className="label">
                    Model
                  </label>
                  <input id="model" name="model" required className="input" autoComplete="off" placeholder={kind.modelHint} />
                </div>
                <div className="field">
                  <label htmlFor="serial" className="label">
                    Serial number
                  </label>
                  <input id="serial" name="serial" className="input mono" autoComplete="off" />
                </div>
                {kind.types.length > 0 && (
                  <div className="field">
                    <label htmlFor="machineType" className="label">
                      {sewing ? "Machine type" : "Type"}
                    </label>
                    <select id="machineType" name="machineType" className="select" defaultValue="">
                      <option value="">-</option>
                      {kind.types.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                )}
                <IntakeFields defs={kind.intakeFields} on="machine" />
                {plate.show && <PlateButton unavailable={plate.unavailable} />}
                <p className="muted text-xs sm:col-span-2">A serial number we&apos;ve seen before links this ticket to that {noun}&apos;s history.</p>
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
              <IntakeFields defs={kind.intakeFields} on="ticket" />
              <div className="field">
                <label htmlFor="preApproved" className="label">
                  OK to spend up to ($) without calling
                </label>
                <input id="preApproved" name="preApproved" inputMode="decimal" className="input num" placeholder="for example 75" />
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
            {kind.accessories.length > 0 && (
              <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <legend className="sr-only">Accessories</legend>
                {kind.accessories.map((a) => (
                  <label key={a} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="accessories" value={a} className="check" defaultChecked={kind.defaultChecked.includes(a)} />
                    {a}
                  </label>
                ))}
              </fieldset>
            )}
            <div className={`field ${kind.accessories.length > 0 ? "mt-3" : ""}`}>
              <label htmlFor="accessoriesOther" className="label">
                Other items (comma separated)
              </label>
              <input id="accessoriesOther" name="accessoriesOther" className="input" placeholder={sewing ? "walking foot, 1/4 inch foot" : "anything else that came with it"} />
            </div>
          </Section>

          <div className="flex justify-end">
            <Submit>Create ticket</Submit>
          </div>
        </ActionForm>
      )}
    </div>
  );
}
