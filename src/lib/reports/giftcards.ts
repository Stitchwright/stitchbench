import "server-only";
// The gift card liability tab (later-round-1-design.md 3.1 and section 2): what the shop owes on cards and store credit at
// the start and end of a range and how it moved, from the ledger.
import { db } from "@/lib/db";

export const ENTRY_LABEL: Record<string, string> = {
  SOLD: "Cards sold",
  LOADED: "Cards loaded",
  OPENING: "Existing cards added",
  REDEEMED: "Spent",
  REFUNDED_TO: "Refunded onto cards and credit",
  CASHED_OUT: "Paid out in cash",
  ADJUSTED: "Adjusted by the owner",
  VOID: "Put back by a void",
  MOVED: "Moved to a new number",
};

export type LiabilityReport = {
  /** Per kind ("gift", "credit"): the balance on active cards when the range began, the movement by reason, and the balance when it ended. */
  kinds: { kind: "gift" | "credit"; label: string; opening: number; movement: { reason: string; label: string; cents: number }[]; closing: number; cardsWithBalance: number }[];
  /** The liability today (every active card's balance). */
  today: number;
};

export async function liabilityReport(shopId: string, start: Date, end: Date): Promise<LiabilityReport> {
  const cards = await db.giftCard.findMany({ where: { shopId, status: "active" }, select: { id: true, kind: true, balanceCents: true } });
  const kindOf = new Map(cards.map((c) => [c.id, c.kind]));
  // Entries since the start: today's balance less these is the balance back then.
  const entries = await db.giftCardEntry.findMany({ where: { shopId, at: { gte: start }, cardId: { in: [...kindOf.keys()] } }, select: { cardId: true, at: true, amountCents: true, reason: true } });
  const out: LiabilityReport["kinds"] = [];
  for (const kind of ["gift", "credit"] as const) {
    const mine = cards.filter((c) => c.kind === kind);
    const now = mine.reduce((a, c) => a + c.balanceCents, 0);
    const since = entries.filter((e) => kindOf.get(e.cardId) === kind);
    const after = since.filter((e) => e.at >= end).reduce((a, e) => a + e.amountCents, 0);
    const during = since.filter((e) => e.at < end);
    const all = since.reduce((a, e) => a + e.amountCents, 0);
    const byReason = new Map<string, number>();
    for (const e of during) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + e.amountCents);
    out.push({
      kind,
      label: kind === "gift" ? "Gift cards" : "Store credit",
      opening: now - all,
      movement: [...byReason].filter(([, c]) => c !== 0).map(([reason, cents]) => ({ reason, label: ENTRY_LABEL[reason] ?? reason, cents })),
      closing: now - after,
      cardsWithBalance: mine.filter((c) => c.balanceCents > 0).length,
    });
  }
  return { kinds: out, today: cards.reduce((a, c) => a + c.balanceCents, 0) };
}
