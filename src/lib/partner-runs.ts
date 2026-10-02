// Partner pickup runs: the rules (scheduling-messaging-design.md 13.2). Pure, safe on the client: who may change, OK,
// cancel or record a run, and whether a plan message creates, updates or is ignored.
export type RunStatus = "SCHEDULED" | "CANCELLED" | "DONE";
export type Side = "repair" | "retail";
export type RunState = { status: RunStatus; ownerSide: Side; rev: number; okRev: number | null; collectedAt: string | null; deliveredAt: string | null };
export type RunPlan = { id: string; rev: number; ownerSide: Side; startsAt: string; endsAt: string | null; driver: Side; collect: string[]; deliver: string[]; note: string | null; name: string; at: string };
export type RunAction = "change" | "ok" | "cancel" | "record";

export const sideWords = (side: Side) => (side === "repair" ? "the repair shop" : "the sewing shop");

/** null = allowed; otherwise the words for the UserError. */
export function canDo(run: RunState | null, side: Side, action: RunAction, partnerName = "the partner"): string | null {
  if (!run) return "Run not found.";
  const finished = run.status === "DONE" ? "This run is done." : run.status === "CANCELLED" ? "This run is cancelled." : null;
  switch (action) {
    case "change":
      if (run.ownerSide !== side) return `Only ${partnerName}, who scheduled it, can change this run. Cancel it with a note instead.`;
      return finished;
    case "ok":
      if (finished) return finished;
      if (run.ownerSide === side) return "You scheduled this run: the other side OKs it.";
      if (run.okRev === run.rev) return "You've OK'd it already.";
      return null;
    case "cancel":
      return finished;
    case "record": {
      if (run.status === "CANCELLED") return "This run is cancelled.";
      const mine = side === "repair" ? run.collectedAt : run.deliveredAt;
      return mine ? "You've recorded this run already." : null;
    }
  }
}

/** What a `pickup.plan` from `from` does to the run we hold (if any). */
export function planOutcome(local: RunState | null, p: RunPlan, from: Side): "create" | "update" | "ignore" {
  if (from !== p.ownerSide) return "ignore";
  if (!local) return "create";
  if (local.ownerSide !== p.ownerSide || local.status !== "SCHEDULED" || p.rev <= local.rev) return "ignore";
  return "update";
}

/** Which list a side records: the repair shop what the driver took, the sewing shop what reached its counter. */
export function receivedList(side: Side): "collected" | "delivered" {
  return side === "repair" ? "collected" : "delivered";
}

/** The other side of a partnership. */
export const otherSide = (side: Side): Side => (side === "repair" ? "retail" : "repair");

/** "Changed since {partner} OK'd it" / "OK'd by {partner}" / "Not OK'd yet" */
export function okWords(run: Pick<RunState, "okRev" | "rev" | "status">, partnerName: string, weAreOwner: boolean): string {
  if (run.status !== "SCHEDULED") return "";
  if (run.okRev == null) return weAreOwner ? `Not OK'd by ${partnerName} yet` : "Not OK'd yet";
  if (run.okRev !== run.rev) return `Changed since ${weAreOwner ? partnerName : "you"} OK'd it`;
  return weAreOwner ? `OK'd by ${partnerName}` : "You OK'd it";
}
