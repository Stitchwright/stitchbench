"use client";

import { useEffect, useRef, useState } from "react";
import { findStockedParts } from "@/actions/tickets";

/**
 * The part box of "Add part" on a ticket. Suggestions come from a search of the shop's own stock as you type (25 at
 * most), instead of the whole parts list being sent with every ticket page. A number typed in full works as before.
 */
export function PartPicker() {
  const [options, setOptions] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const asked = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  function typed(value: string) {
    clearTimeout(timer.current);
    // A suggestion just picked ("number | description (n on hand)") needs no new search.
    if (value.includes(" | ")) return;
    if (value.trim().length < 2) {
      setOptions([]);
      return;
    }
    const mine = ++asked.current;
    timer.current = setTimeout(async () => {
      try {
        const found = await findStockedParts(value);
        if (mine === asked.current) setOptions(found);
      } catch {
        // No suggestions this time; the box still takes a part number typed in full.
      }
    }, 250);
  }

  return (
    <>
      <input
        name="partNumber"
        aria-label="Part"
        list="parts-list"
        className="input mono"
        placeholder="Part number"
        autoComplete="off"
        onChange={(e) => typed(e.currentTarget.value)}
      />
      <datalist id="parts-list">
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}
