// The tax holiday form on Settings → Selling (tax-machine-sales-layaway-design.md section 1): a name, the first and
// last day, what it covers and the price limit per item; a preset (Massachusetts) fills it in for the shop to confirm.
import { HOLIDAY_KINDS, type HolidayPreset } from "@/lib/tax-holiday-math";
import type { HolidayRow } from "@/lib/tax-holidays";
import { saveHoliday } from "@/actions/tax-holidays";
import { ActionForm, Submit } from "@/components/action-form";

export function TaxHolidayForm({ h, preset, year, prefix }: { h?: HolidayRow; preset?: HolidayPreset | null; year: number; prefix: string }) {
  const dates = h ?? preset?.datesFor(year) ?? { firstDay: "", lastDay: "" };
  const kinds = new Set(h?.kinds ?? preset?.kinds ?? HOLIDAY_KINDS.map((k) => k.key).filter((k) => !["CLASS", "APPOINTMENT", "SERVICE_PLAN"].includes(k)));
  const max = h ? h.maxUnitCents : (preset?.maxUnitCents ?? null);
  return (
    <ActionForm action={saveHoliday.bind(null, h?.id ?? null)} success={h ? "Saved" : "Tax holiday added. The register applies it on those days."} reset={!h} className="space-y-3">
      {!h && preset && <input type="hidden" name="preset" value={preset.key} />}
      {h?.preset && <input type="hidden" name="preset" value={h.preset} />}
      {preset && !h && <p className="text-sm">{preset.note} Check this year&apos;s dates before you save.</p>}
      <div className="grid-form">
        <div className="field">
          <label htmlFor={`${prefix}-name`} className="label">
            Name
          </label>
          <input id={`${prefix}-name`} name="name" required className="input" defaultValue={h?.name ?? preset?.name ?? ""} placeholder="Tax-free weekend" />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-first`} className="label">
            First day
          </label>
          <input id={`${prefix}-first`} name="firstDay" type="date" required className="input" defaultValue={dates.firstDay} />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-last`} className="label">
            Last day
          </label>
          <input id={`${prefix}-last`} name="lastDay" type="date" required className="input" defaultValue={dates.lastDay} />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-max`} className="label">
            Price limit per item ($)
          </label>
          <input id={`${prefix}-max`} name="maxUnitCents" className="input num" inputMode="decimal" defaultValue={max != null ? (max / 100).toFixed(2) : ""} aria-describedby={`${prefix}-max-hint`} />
          <p id={`${prefix}-max-hint`} className="muted text-xs">
            An item that costs more is taxed in full. Blank: no limit.
          </p>
        </div>
      </div>
      <fieldset>
        <legend className="label">What it covers</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {HOLIDAY_KINDS.map((k) => (
            <label key={k.key} className="flex items-center gap-2">
              <input type="checkbox" name="kinds" value={k.key} defaultChecked={kinds.has(k.key)} /> {k.label}
            </label>
          ))}
        </div>
      </fieldset>
      {h && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={h.active} /> On (untick to switch it off)
        </label>
      )}
      <Submit className={h ? "btn btn-sm" : undefined}>{h ? "Save" : "Add tax holiday"}</Submit>
    </ActionForm>
  );
}
