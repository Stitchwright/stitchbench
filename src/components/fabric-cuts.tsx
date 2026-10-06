"use client";

import { ActionButton } from "@/components/action-form";
import { cutBoltEnd } from "@/actions/fabric";
import { cutPlan, CUT_INFO } from "@/lib/fabric-math";

/** The cut buttons of one bolt end: what each makes is on the button, the same words as the server's. */
export function FabricCuts({ id, yards, hasPrice }: { id: string; yards: number; hasPrice: boolean }) {
  const fq = cutPlan("FQ", yards);
  const half = cutPlan("HALF", yards);
  const label = (kind: "FQ" | "HALF", n: number) => `Cut into ${n} ${n === 1 ? CUT_INFO[kind].one : CUT_INFO[kind].many}`;
  return (
    <div className="flex flex-wrap gap-2">
      {fq.count > 0 && (
        <ActionButton action={cutBoltEnd.bind(null, id, "FQ")} className="btn btn-sm btn-primary" title={hasPrice ? undefined : "Give it a price per yard first"}>
          {label("FQ", fq.count)}
        </ActionButton>
      )}
      {half.count > 0 && (
        <ActionButton action={cutBoltEnd.bind(null, id, "HALF")} className="btn btn-sm" title={hasPrice ? undefined : "Give it a price per yard first"}>
          {label("HALF", half.count)}
        </ActionButton>
      )}
      <ActionButton action={cutBoltEnd.bind(null, id, "REMNANT")} className="btn btn-sm" title={hasPrice ? undefined : "Give it a price per yard first"}>
        To the remnant bin
      </ActionButton>
    </div>
  );
}
