"use client";
/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the owning package fills in the bodies */

// The register's "Sell a vacuum" / "Trade-in" / "Return a vacuum" tools (vac-sales-warranty). Foundation stub: renders nothing.
import type { VacCartLine } from "@/lib/vac/types";

export function VacUnitTools(_props: {
  vac: "on" | "readonly";
  returnMode: boolean;
  customerId: string | null;
  inCart: { stockUnitId?: string }[];
  onAdd: (line: VacCartLine) => void;
  onNeedCustomer: () => void;
}) {
  return null;
}
