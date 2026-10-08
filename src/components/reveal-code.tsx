"use client";

// An activation code masked ("…7F3K"), shown in full with one tap and hidden again with another (2.5).
import { useState } from "react";

export function RevealCode({ code }: { code: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="mono">{shown ? code : `…${code.slice(-4)}`}</span>
      <button type="button" className="btn btn-sm" onClick={() => setShown((s) => !s)} aria-pressed={shown}>
        {shown ? "Hide the code" : "Show the code"}
      </button>
    </span>
  );
}
