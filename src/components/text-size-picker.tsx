"use client";
// Settings → Text size: three big choices, each showing "Aa" at its own size; the change applies at once (no Save).
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setTextSize } from "@/actions/ease";
import { TEXT_SIZES, TEXT_SIZE_LABEL, TEXT_SIZE_PCT, type TextSize } from "@/lib/text-size";

export function TextSizePicker({ current }: { current: TextSize }) {
  const [chosen, setChosen] = useState<TextSize>(current);
  const [pending, start] = useTransition();
  function pick(s: TextSize) {
    if (s === chosen) return;
    const before = chosen;
    setChosen(s);
    start(async () => {
      const r = await setTextSize(s);
      if (r?.error) {
        setChosen(before);
        toast.error(r.error);
      }
    });
  }
  return (
    <div role="radiogroup" aria-label="Text size" className="flex flex-wrap gap-3" aria-busy={pending}>
      {TEXT_SIZES.map((s) => {
        const on = s === chosen;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={on}
            data-testid={`text-size-${s}`}
            onClick={() => pick(s)}
            className={`flex min-h-24 min-w-32 flex-1 flex-col items-center justify-center gap-1 rounded-lg border-2 px-4 py-3 ${on ? "border-navy bg-surface-2" : "border-[var(--field-line)] bg-surface"}`}
          >
            {/* Fixed pixel sizes: the sample shows what that choice will look like, whatever the page is at now. */}
            <span className="font-bold leading-none" style={{ fontSize: `${Math.round(24 * TEXT_SIZE_PCT[s]) / 100}px` }} aria-hidden>
              Aa
            </span>
            <span className="text-sm font-semibold">{TEXT_SIZE_LABEL[s]}</span>
            <span className="text-xs">{on ? "In use" : " "}</span>
          </button>
        );
      })}
    </div>
  );
}
