"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { insecureMessage, secureAddressOnPage } from "@/components/secure-page";

/**
 * Copies `text` to the clipboard. On a plain-http LAN address navigator.clipboard is missing: then the text is shown
 * in a read-only box that selects itself, with a hint to copy it by hand, and (when the page isn't secure) why, with the
 * shop's https address when there is one (src/components/secure-page.tsx).
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [fallback, setFallback] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  if (fallback !== null) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <input ref={box} readOnly value={text} className="input mono text-xs" aria-label={label} onFocus={(e) => e.currentTarget.select()} autoFocus />
        <span className="muted text-xs">{fallback}</span>
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
          const byHand = "Select the text and copy it (Ctrl+C, or press and hold).";
          setFallback(window.isSecureContext ? byHand : insecureMessage("One-tap copy", byHand, secureAddressOnPage()));
        }
      }}
    >
      <Copy size={14} aria-hidden /> {label}
    </button>
  );
}
