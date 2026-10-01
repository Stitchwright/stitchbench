"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";

/**
 * Copies `text` to the clipboard. On a plain-http LAN address navigator.clipboard is missing: then the text is shown
 * in a read-only box that selects itself, with a hint to press Ctrl+C.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [fallback, setFallback] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  if (fallback) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <input ref={box} readOnly value={text} className="input mono text-xs" aria-label={label} onFocus={(e) => e.currentTarget.select()} autoFocus />
        <span className="muted text-xs">Select it and press Ctrl+C.</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-sm"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          if (!navigator.clipboard) throw new Error("no clipboard");
          await navigator.clipboard.writeText(text);
          toast.success("Copied");
        } catch {
          setFallback(true);
        }
      }}
    >
      <Copy size={14} aria-hidden /> {label}
    </button>
  );
}
