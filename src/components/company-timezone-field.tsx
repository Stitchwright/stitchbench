"use client";

import { useEffect, useRef } from "react";

/**
 * Time zone for a new company: starts as the platform admin's own shop zone (so it's never the bare schema default),
 * then, unless the admin has already changed it, swaps to the browser's own zone once JS runs — the same guess
 * hosted sign-up makes (TimeZoneField). Left visible and editable here, since the admin is setting this up for
 * someone else's shop and may know better.
 */
export function CompanyTimeZoneField({ defaultZone }: { defaultZone: string }) {
  const box = useRef<HTMLInputElement>(null);
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    try {
      const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (browser && box.current) box.current.value = browser;
    } catch {
      /* keep the admin's own shop zone */
    }
  }, []);
  return (
    <div className="field">
      <label htmlFor="c-tz" className="label">
        Time zone (days and months start here), e.g. America/Chicago
      </label>
      <input id="c-tz" ref={box} name="timeZone" defaultValue={defaultZone} onChange={() => (touched.current = true)} className="input" autoComplete="off" />
    </div>
  );
}
