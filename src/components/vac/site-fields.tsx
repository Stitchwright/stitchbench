// The site fields shared by the New install form and the ticket's "Change" form (central-vac-installs): address,
// the window (date, start, end; blank date = not scheduled yet), the contact and access notes. Names match
// src/lib/vac/installs.ts siteFields / rangeFromForm.
import type { SiteJob } from "@/lib/vac/installs";
import { hmOf, wall, ymdOf } from "@/lib/zoned";

export function SiteFields({ site, tz, idPrefix = "site" }: { site?: SiteJob | null; tz: string; idPrefix?: string }) {
  const p = idPrefix;
  const start = site?.startsAt ? wall(site.startsAt, tz) : null;
  const end = site?.endsAt ? wall(site.endsAt, tz) : null;
  return (
    <>
      <div className="field sm:col-span-2">
        <label htmlFor={`${p}-address`} className="label">
          Where
        </label>
        <input id={`${p}-address`} name="address" className="input" defaultValue={site?.address ?? ""} placeholder="Street address (blank: the customer's address)" />
      </div>
      <div className="field">
        <label htmlFor={`${p}-date`} className="label">
          Date (blank: not scheduled yet)
        </label>
        <input id={`${p}-date`} name="date" type="date" className="input" defaultValue={site?.startsAt ? ymdOf(site.startsAt, tz) : ""} />
      </div>
      <div className="field">
        <label htmlFor={`${p}-start`} className="label">
          From
        </label>
        <input id={`${p}-start`} name="start" type="time" className="input" defaultValue={start ? hmOf(start.hour * 60 + start.minute) : "09:00"} />
      </div>
      <div className="field">
        <label htmlFor={`${p}-end`} className="label">
          To
        </label>
        <input id={`${p}-end`} name="end" type="time" className="input" defaultValue={end ? hmOf(end.hour * 60 + end.minute) : "11:00"} />
      </div>
      <div className="field">
        <label htmlFor={`${p}-contact`} className="label">
          Contact on site
        </label>
        <input id={`${p}-contact`} name="contactName" className="input" defaultValue={site?.contactName ?? ""} />
      </div>
      <div className="field">
        <label htmlFor={`${p}-phone`} className="label">
          Contact phone
        </label>
        <input id={`${p}-phone`} name="contactPhone" className="input" defaultValue={site?.contactPhone ?? ""} />
      </div>
      <div className="field sm:col-span-2">
        <label htmlFor={`${p}-access`} className="label">
          Access notes
        </label>
        <input id={`${p}-access`} name="accessNotes" className="input" defaultValue={site?.accessNotes ?? ""} placeholder="gate code, pets, where to park" />
      </div>
    </>
  );
}
