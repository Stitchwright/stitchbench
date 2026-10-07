"use client";

import { ActionButton } from "@/components/action-form";
import { markDown, undoMarkdown } from "@/actions/fabric";

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * The markdown buttons of one fabric: the ladder's next step with its price on the button, and "Undo markdown" while
 * the last one is still today's. `highlight` marks the markdown as the better of the two ways out (Slow fabric).
 */
export function FabricMarkdown({
  id,
  source,
  offer,
  undo,
  stopped,
  highlight = false,
}: {
  id: string;
  source: "slow" | "bolt";
  offer: { pct: number; priceCents: number; held: boolean } | null;
  undo: { id: string; backCents: number } | null;
  stopped: "noprice" | "last" | "floor" | null;
  highlight?: boolean;
}) {
  return (
    <>
      {offer ? (
        <ActionButton action={markDown.bind(null, id, source)} className={`btn btn-sm ${highlight ? "btn-primary" : ""}`}>
          Mark down {offer.pct}% to {dollars(offer.priceCents)}
          {offer.held ? " (the floor)" : ""}
        </ActionButton>
      ) : (
        <span className="muted text-xs">
          {stopped === "noprice" ? "Give it a price to mark it down." : stopped === "last" ? "At the last markdown step." : "At the lowest price the ladder allows."}
        </span>
      )}
      {undo && (
        <ActionButton action={undoMarkdown.bind(null, undo.id)} className="btn btn-sm" confirm="Undo markdown?">
          Undo markdown (back to {dollars(undo.backCents)})
        </ActionButton>
      )}
    </>
  );
}
