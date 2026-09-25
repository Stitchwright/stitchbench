"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { barcodeDetails } from "@/actions/inventory-import";

/** Fills the add-item form's description and brand from the store barcode typed or scanned into the number field. */
export function BarcodeLookupButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm self-end"
      disabled={busy}
      onClick={async () => {
        const num = (document.getElementById("partNumber") as HTMLInputElement | null)?.value.trim() ?? "";
        if (!num) return toast.error("Scan or type the barcode into the number box first.");
        setBusy(true);
        try {
          const r = await barcodeDetails(num);
          if ("error" in r) return toast.error(r.error);
          if (!r.info) return toast.warning("That barcode isn't in the online database. Type the details in.");
          const set = (id: string, v: string | null) => {
            const el = document.getElementById(id) as HTMLInputElement | null;
            if (el && v && !el.value) el.value = v;
          };
          set("description", r.info.title);
          set("brand", r.info.brand);
          toast.success(`Found: ${r.info.title}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Search size={14} aria-hidden /> {busy ? "Looking up..." : "Look up barcode online"}
    </button>
  );
}
