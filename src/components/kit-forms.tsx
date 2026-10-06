"use client";

import { useEffect, useRef, useState } from "react";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { findStockedParts } from "@/actions/tickets";
import { addMember, createSeries, deleteKit, deleteSeries, linkKit, makeKits, removeMember, saveKit, setHandout, unmakeKit } from "@/actions/kits";
import { CustomerPicker } from "@/components/customer-picker";

export type BuilderLine = { item: string; qty: string; unit: string | null };
export type BuilderInit = { name: string; note: string; pattern: string; patternNote: string; patternCost: string; price: string; lines: BuilderLine[] };

/**
 * The kit builder: name, note, a pattern (an item of kind pattern, or a note of where it comes from and what it costs),
 * the lines (item number from the shop's own stock, amount per kit) and the price (blank: the suggestion).
 */
export function KitBuilder({ kitId, init, suggestion }: { kitId: string | null; init: BuilderInit; suggestion: string | null }) {
  const [lines, setLines] = useState<BuilderLine[]>(init.lines.length ? init.lines : [{ item: "", qty: "", unit: null }]);
  const [options, setOptions] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const asked = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  function typed(value: string) {
    clearTimeout(timer.current);
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
        // No suggestions this time; a number typed in full still works.
      }
    }, 250);
  }
  const set = (i: number, patch: Partial<BuilderLine>) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  return (
    <ActionForm action={saveKit.bind(null, kitId)} success="Saved" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="field">
          <label className="label" htmlFor="kit-name">
            Kit name
          </label>
          <input id="kit-name" name="name" defaultValue={init.name} className="input" maxLength={80} required />
        </div>
        <div className="field">
          <label className="label" htmlFor="kit-note">
            Note (shown to you only)
          </label>
          <input id="kit-note" name="note" defaultValue={init.note} className="input" maxLength={500} />
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">What goes in one kit</legend>
        <datalist id="kit-items">
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <div className="field min-w-[12rem] flex-1">
              <label className="label" htmlFor={`kit-item-${i}`}>
                Fabric or notion (item number)
              </label>
              <input
                id={`kit-item-${i}`}
                name={`item.${i}`}
                list="kit-items"
                value={l.item}
                onChange={(e) => {
                  set(i, { item: e.currentTarget.value });
                  typed(e.currentTarget.value);
                }}
                className="input mono"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor={`kit-qty-${i}`}>
                Amount (yards or units)
              </label>
              <input id={`kit-qty-${i}`} name={`qty.${i}`} value={l.qty} onChange={(e) => set(i, { qty: e.currentTarget.value })} inputMode="decimal" className="input num w-28" />
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, n) => n !== i) : [{ item: "", qty: "", unit: null }]))}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => [...ls, { item: "", qty: "", unit: null }])}>
          Add a line
        </button>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="text-sm font-semibold">Pattern</legend>
        <div className="field">
          <label className="label" htmlFor="kit-pattern">
            Pattern item (a pattern in your stock; one goes in each kit)
          </label>
          <input id="kit-pattern" name="pattern" list="kit-items" defaultValue={init.pattern} onChange={(e) => typed(e.currentTarget.value)} className="input mono" autoComplete="off" />
        </div>
        <div className="field">
          <label className="label" htmlFor="kit-pattern-note">
            ...or where it comes from
          </label>
          <input id="kit-pattern-note" name="patternNote" defaultValue={init.patternNote} className="input" maxLength={200} placeholder="Publisher and permission" />
        </div>
        <div className="field">
          <label className="label" htmlFor="kit-pattern-cost">
            Pattern cost for a note ($)
          </label>
          <input id="kit-pattern-cost" name="patternCost" defaultValue={init.patternCost} inputMode="decimal" className="input num" />
        </div>
      </fieldset>
      <div className="field max-w-xs">
        <label className="label" htmlFor="kit-price">
          Kit price ($){suggestion ? `, blank: the suggestion ${suggestion}` : ", blank: the suggestion"}
        </label>
        <input id="kit-price" name="price" defaultValue={init.price} inputMode="decimal" className="input num" />
      </div>
      <Submit>{kitId ? "Save kit" : "Make the kit recipe"}</Submit>
    </ActionForm>
  );
}

export function MakeKitsForm({ kitId, makeable, stock }: { kitId: string; makeable: number | null; stock: number }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <ActionForm action={makeKits.bind(null, kitId)} className="flex flex-wrap items-end gap-2">
        <div className="field">
          <label className="label" htmlFor="make-count">
            Make this many kits
          </label>
          <input id="make-count" name="count" defaultValue="1" inputMode="numeric" className="input num w-24" />
        </div>
        <Submit>Make kits</Submit>
      </ActionForm>
      <ActionButton action={unmakeKit.bind(null, kitId)} className="btn" confirm="Tap again to unmake one">
        Unmake 1
      </ActionButton>
      <span className="muted text-sm">
        {stock} in stock{makeable != null ? `; the shelf covers ${makeable} more` : ""}.
      </span>
    </div>
  );
}

export function DeleteKitButton({ kitId }: { kitId: string }) {
  return (
    <ActionButton action={deleteKit.bind(null, kitId)} className="btn" confirm="Tap again to delete the kit">
      Delete kit
    </ActionButton>
  );
}

export function NewSeriesForm() {
  return (
    <ActionForm action={createSeries} className="flex flex-wrap items-end gap-2">
      <div className="field">
        <label className="label" htmlFor="series-name">
          New Block of the Month
        </label>
        <input id="series-name" name="name" className="input" maxLength={80} required placeholder="Block of the Month 2027" />
      </div>
      <div className="field">
        <label className="label" htmlFor="series-months">
          Months
        </label>
        <input id="series-months" name="months" defaultValue="12" inputMode="numeric" className="input num w-20" />
      </div>
      <Submit className="btn btn-sm">Start series</Submit>
    </ActionForm>
  );
}

export function MonthSlotForm({ seriesId, month, current, options }: { seriesId: string; month: number; current: string; options: { id: string; name: string; series: string | null }[] }) {
  return (
    <ActionForm action={linkKit.bind(null, seriesId, month)} success="Saved" className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`slot-${month}`}>
        Kit for month {month}
      </label>
      <select id={`slot-${month}`} name={`kit.${month}`} defaultValue={current} className="input">
        <option value="">(empty)</option>
        {options.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
            {k.series ? ` (now in ${k.series})` : ""}
          </option>
        ))}
      </select>
      <Submit className="btn btn-sm">Set</Submit>
    </ActionForm>
  );
}

export function HandoutButton({ seriesId, kitId, done }: { seriesId: string; kitId: string; done: boolean }) {
  return (
    <ActionButton action={setHandout.bind(null, seriesId, kitId, !done)} className="btn btn-sm">
      {done ? "Handout done: undo" : "Mark handout done"}
    </ActionButton>
  );
}

export function RosterAdd({ seriesId }: { seriesId: string }) {
  return (
    <ActionForm action={addMember.bind(null, seriesId)} reset className="grid gap-2 sm:grid-cols-2">
      <CustomerPicker initial={null} />
      <div className="field sm:col-span-2">
        <label className="label" htmlFor="member-note">
          Note (paid in full, pick up in store...)
        </label>
        <input id="member-note" name="note" className="input" maxLength={200} />
      </div>
      <div className="sm:col-span-2">
        <Submit>Add to the roster</Submit>
      </div>
    </ActionForm>
  );
}

export function RemoveMemberButton({ seriesId, memberId }: { seriesId: string; memberId: string }) {
  return (
    <ActionButton action={removeMember.bind(null, seriesId, memberId)} className="btn btn-sm" confirm="Tap again to remove">
      Remove
    </ActionButton>
  );
}

export function DeleteSeriesButton({ seriesId }: { seriesId: string }) {
  return (
    <ActionButton action={deleteSeries.bind(null, seriesId)} className="btn" confirm="Tap again to delete the series and its roster">
      Delete series
    </ActionButton>
  );
}
