"use client";

import { Printer } from "lucide-react";

export function PrintButton() {
  return (
    <button type="button" className="btn btn-primary" onClick={() => window.print()}>
      <Printer size={14} aria-hidden /> Print or save PDF
    </button>
  );
}
