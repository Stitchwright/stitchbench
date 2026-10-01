// "How should we tell them?" (Customer.notifyBy), on the customer form and at check-in (design 4.1, 8.3). No hooks:
// usable from server and client components alike.
import { NOTIFY_BY_LABEL } from "@/lib/constants";

const CHOICES: { value: string; label: string }[] = [
  { value: "sms", label: "Text" },
  { value: "email", label: "Email" },
  { value: "both", label: "Both" },
  { value: "none", label: "Call them (no message)" },
];

/**
 * `required`: radio buttons with none pre-selected (the question must be asked). Otherwise an optional select, with
 * "" meaning "not asked yet" (or, on a change form, "keep as it is").
 */
export function NotifyByField({ id = "notifyBy", name = "notifyBy", defaultValue = "", required = false, label = "How should we tell them it's ready / remind them?" }: { id?: string; name?: string; defaultValue?: string; required?: boolean; label?: string }) {
  if (required) {
    return (
      <fieldset className="field sm:col-span-2">
        <legend className="label">{label}</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {CHOICES.map((c) => (
            <label key={c.value} className="flex items-center gap-1">
              <input type="radio" name={name} value={c.value} className="check" required defaultChecked={defaultValue === c.value} /> {c.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select id={id} name={name} className="select" defaultValue={defaultValue}>
        {Object.entries(NOTIFY_BY_LABEL).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

export const NOTIFY_BY_VALUES = ["", "email", "sms", "both", "none"];
export const isNotifyBy = (v: unknown): v is string => typeof v === "string" && NOTIFY_BY_VALUES.includes(v);
