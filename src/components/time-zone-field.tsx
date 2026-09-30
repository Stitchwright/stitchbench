"use client";

import { useEffect, useRef } from "react";

/** The browser's own time zone (America/Chicago) sent with a form, for a new company on a server that runs on UTC. */
export function TimeZoneField() {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try {
      if (box.current) box.current.value = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      /* no zone to send: the company keeps the default until Settings says */
    }
  }, []);
  return <input ref={box} type="hidden" name="tz" />;
}
