// Consignment pieces (shop-features-round-2-design.md 9.6): the machine page's Consignment box, and "Pay her" for one
// payout (Paperwork and the customer's page). Server components.
import Link from "next/link";
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { PAYOUT_LABEL, type PayoutRow } from "@/lib/consign-machines";
import { giveBackConsigned, payConsignor, setConsign, undoConsignorPayment } from "@/actions/consign-machines";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { Section } from "@/components/ui";

export async function ConsignSection({ shopId, unit, admin }: { shopId: string; unit: { id: string; status: string; priceCents: number | null; consignorId: string | null; consignPct: number | null; consignUntil: string | null }; admin: boolean }) {
  const [consignor, shop] = await Promise.all([
    unit.consignorId ? db.customer.findFirst({ where: { id: unit.consignorId, shopId }, select: { id: true, name: true, phone: true } }) : null,
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { consignDefaultPct: true } }),
  ]);
  const open = unit.status === "IN_STOCK" || unit.status === "REMOVED";
  if (!unit.consignorId && (!admin || !open)) return null;
  const pct = unit.consignPct ?? shop.consignDefaultPct;
  return (
    <Section title="Consignment">
      {consignor && (
        <p className="mb-3 text-base">
          <Link href={`/customers/${consignor.id}`} className="link">
            {consignor.name}
          </Link>
          &apos;s machine. The shop keeps {pct}%
          {unit.priceCents != null ? `: she gets ${money(Math.round((unit.priceCents * (100 - pct)) / 100))} if it sells at ${money(unit.priceCents)}` : ""}.
          {unit.consignUntil ? ` Give it back or mark it down by ${unit.consignUntil}.` : ""}
        </p>
      )}
      {admin && open && (
        <details open={!consignor}>
          <summary className="link cursor-pointer text-sm">{consignor ? "Change" : "A customer's machine? Sell it for her"}</summary>
          <ActionForm action={setConsign.bind(null, unit.id)} className="mt-2 grid gap-3 sm:grid-cols-2">
            <CustomerPicker initial={consignor ? { id: consignor.id, name: consignor.name, phone: consignor.phone } : null} />
            <div className="field">
              <label className="label" htmlFor={`cs-pct-${unit.id}`}>
                The shop keeps (%)
              </label>
              <input id={`cs-pct-${unit.id}`} name="pct" inputMode="decimal" className="input num w-24" defaultValue={String(pct)} />
            </div>
            <div className="field">
              <label className="label" htmlFor={`cs-until-${unit.id}`}>
                Give it back or mark it down by (optional)
              </label>
              <input id={`cs-until-${unit.id}`} name="until" type="date" className="input" defaultValue={unit.consignUntil ?? ""} />
            </div>
            <div className="sm:col-span-2">
              <Submit className="btn">Save</Submit>
              <p className="muted mt-1 text-sm">The price on the machine is hers. Clear the customer to make it the shop&apos;s own again.</p>
            </div>
          </ActionForm>
        </details>
      )}
      {admin && open && consignor && (
        <p className="mt-3 text-sm">
          <ActionButton action={giveBackConsigned.bind(null, unit.id)} className="link" confirm="Tap again: she takes it home">
            Give it back to her unsold
          </ActionButton>
        </p>
      )}
    </Section>
  );
}

/** One payout: owed with "Pay her", or paid with how (and Undo for check or cash). */
export function PayoutLine({ p, admin, showWho = true }: { p: PayoutRow; admin: boolean; showWho?: boolean }) {
  return (
    <li className="space-y-2 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-base">
        <span>
          {showWho && (
            <>
              <Link href={`/customers/${p.customerId}`} className="link">
                {p.consignor}
              </Link>
              {": "}
            </>
          )}
          {p.machine} <span className="muted text-sm">sold for {money(p.soldCents)}, the shop kept {p.pct}%</span>
        </span>
        <span className="num font-semibold">{money(p.amountCents)}</span>
      </div>
      {p.paidAt ? (
        <p className="muted text-sm">
          Paid by {PAYOUT_LABEL[p.method ?? ""]?.toLowerCase() ?? "?"}
          {p.note ? ` (${p.note})` : ""}
          {admin && p.method !== "CREDIT" && (
            <ActionButton action={undoConsignorPayment.bind(null, p.id)} className="link ml-2 text-sm">
              Undo
            </ActionButton>
          )}
        </p>
      ) : (
        admin && (
          <ActionForm action={payConsignor.bind(null, p.id)} className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label className="label" htmlFor={`po-m-${p.id}`}>
                Pay her by
              </label>
              <select id={`po-m-${p.id}`} name="method" className="select" defaultValue="CHECK">
                <option value="CHECK">Check</option>
                <option value="CASH">Cash</option>
                <option value="CREDIT">Store credit</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor={`po-n-${p.id}`}>
                Check number
              </label>
              <input id={`po-n-${p.id}`} name="note" className="input w-32" maxLength={120} />
            </div>
            <Submit>Pay her {money(p.amountCents)}</Submit>
          </ActionForm>
        )
      )}
    </li>
  );
}
