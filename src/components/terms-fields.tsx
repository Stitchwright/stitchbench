import { DEFAULT_TERMS, type PartnerTerms } from "@/lib/partner-terms";

/** The partnership terms as form fields (the invite, and proposing a change). */
export function TermsFields({ terms = DEFAULT_TERMS, idPrefix = "" }: { terms?: PartnerTerms; idPrefix?: string }) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}repairCommissionPct`} className="label">
          Sewing shop&apos;s commission on repairs (%)
        </label>
        <input id={`${idPrefix}repairCommissionPct`} name="repairCommissionPct" type="number" min={0} max={50} step={0.5} defaultValue={terms.repairCommissionPct} className="input num" />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}commissionOn`} className="label">
          Commission is on
        </label>
        <select id={`${idPrefix}commissionOn`} name="commissionOn" defaultValue={terms.commissionOn} className="select">
          <option value="service">Service and labor (not parts)</option>
          <option value="total">The whole bill before tax</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}customersPay`} className="label">
          Customers pay for repairs
        </label>
        <select id={`${idPrefix}customersPay`} name="customersPay" defaultValue={terms.customersPay} className="select">
          <option value="shop">At the sewing shop&apos;s counter</option>
          <option value="repair">To the repair shop</option>
          <option value="either">At either shop</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}pickupDay`} className="label">
          Pickup / drop-off day
        </label>
        <input id={`${idPrefix}pickupDay`} name="pickupDay" defaultValue={terms.pickupDay ?? ""} className="input" placeholder="Tuesdays" />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}turnaroundDays`} className="label">
          Usual turnaround (days)
        </label>
        <input id={`${idPrefix}turnaroundDays`} name="turnaroundDays" type="number" min={1} max={120} defaultValue={terms.turnaroundDays ?? ""} className="input num" />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}consignSharePct`} className="label">
          Sewing shop keeps, of consigned sales (%)
        </label>
        <input id={`${idPrefix}consignSharePct`} name="consignSharePct" type="number" min={0} max={90} step={0.5} defaultValue={terms.consignSharePct} className="input num" />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}payWithinDays`} className="label">
          Statements paid within (days)
        </label>
        <input id={`${idPrefix}payWithinDays`} name="payWithinDays" type="number" min={1} max={90} defaultValue={terms.payWithinDays} className="input num" />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}abandonedAfterDays`} className="label">
          Unclaimed machines: notice after (days)
        </label>
        <input id={`${idPrefix}abandonedAfterDays`} name="abandonedAfterDays" type="number" min={14} max={365} defaultValue={terms.abandonedAfterDays} className="input num" />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}noticeDays`} className="label">
          Either shop can end it with notice of (days)
        </label>
        <input id={`${idPrefix}noticeDays`} name="noticeDays" type="number" min={0} max={180} defaultValue={terms.noticeDays} className="input num" />
      </div>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input type="checkbox" name="softwareByRepairShop" defaultChecked={terms.softwareByRepairShop} className="check" /> Repair shop sets up and
        supports StitchShop for the sewing shop, free while partnered
      </label>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input type="checkbox" name="shopCoversLoss" defaultChecked={terms.shopCoversLoss} className="check" /> Sewing shop answers for consigned stock lost or
        damaged in its care
      </label>
      <div className="field sm:col-span-2">
        <label htmlFor={`${idPrefix}otherTerms`} className="label">
          Anything else agreed (plain words)
        </label>
        <textarea id={`${idPrefix}otherTerms`} name="otherTerms" rows={3} defaultValue={terms.otherTerms ?? ""} className="textarea" />
      </div>
    </>
  );
}
