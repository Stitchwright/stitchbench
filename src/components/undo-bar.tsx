"use client";
// "Line removed. Undo": a calm bar near the bottom for about 10 seconds after something is removed, instead of an "Are you
// sure?" box. A removal's action returns an `undo` offer (src/lib/action.ts undoable()); ActionButton hands it to
// showUndo(), and the one <UndoBar /> (mounted in AppToaster, so on every page) shows it. The Undo button is 48px tall,
// reachable by Tab (the bar is the last thing on the page) and announced to screen readers (aria-live; no role="status" on the always-there region, so a page's own status card stays the only one).
// The bar waits while the mouse is over it or the keyboard is on it, then closes by itself.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/action";

/** How long the bar stays (ms). */
export const UNDO_MS = 10_000;

type Item = { id: number; text: string; restore: () => Promise<ActionResult> };

let items: Item[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const snapshot = () => items;
const serverSnapshot = (): Item[] => [];

/** Shows the bar for a removal: `restore` runs when she taps Undo. Only the last few stay (an older one just closes). */
export function showUndo(text: string, restore: () => Promise<ActionResult>) {
  items = [...items, { id: nextId++, text, restore }].slice(-3);
  emit();
}

function drop(id: number) {
  items = items.filter((i) => i.id !== id);
  emit();
}

function Row({ item }: { item: Item }) {
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const left = useRef(UNDO_MS);

  // Counts down in small steps, so pausing keeps what is left.
  useEffect(() => {
    if (busy) return;
    const t = setInterval(() => {
      if (pausedRef.current) return;
      left.current -= 250;
      if (left.current <= 0) drop(item.id);
    }, 250);
    return () => clearInterval(t);
  }, [busy, item.id]);

  const pause = (on: boolean) => {
    pausedRef.current = on;
    setPaused(on);
  };

  async function undo() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await item.restore();
      if (r?.error) toast.error(r.error);
      else toast.success("Put back.", { duration: 4000 });
    } catch (e) {
      console.error(e);
      toast.error("Couldn't put it back: check the connection and try again.");
    }
    drop(item.id);
  }

  return (
    <div
      data-testid="undo-bar"
      data-paused={paused ? "1" : undefined}
      className="pointer-events-auto flex w-full max-w-md items-center justify-between gap-4 rounded-lg border border-[var(--field-line)] bg-surface px-4 py-2 text-lg text-ink shadow-lg"
      onMouseEnter={() => pause(true)}
      onMouseLeave={() => pause(false)}
      onFocus={() => pause(true)}
      onBlur={() => pause(false)}
    >
      <span>{item.text}</span>
      <button type="button" className="btn btn-primary min-h-12 px-6 text-lg" disabled={busy} onClick={undo}>
        {busy ? "Putting back..." : "Undo"}
      </button>
    </div>
  );
}

/** The bar itself. One of these on the page (AppToaster mounts it). */
export function UndoBar() {
  const list = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return (
    <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {list.map((i) => (
        <Row key={i.id} item={i} />
      ))}
    </div>
  );
}
