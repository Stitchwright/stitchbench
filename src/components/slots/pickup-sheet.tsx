// The ticket page's pickup sheet (shop-features-round-2-design.md 5.5): shown once the machine is ready (or the sheet
// has words), with the shop's care tips for the machine's kind and, with the Assistant, "Draft the pickup sheet".
import { db } from "@/lib/db";
import { careTipsFor } from "@/lib/care-tips";
import { entryFor } from "@/lib/assistant/ui";
import type { CurrentUser } from "@/lib/session";
import { Section } from "@/components/ui";
import { PickupSheetForm } from "@/components/pickup-sheet";

const READY = ["READY_IN_TRUCK", "READY_FOR_PICKUP", "COLLECTED"];

export async function PickupSheetSlot({ ticketId, user, canWork, noun }: { ticketId: string; user: CurrentUser; canWork: boolean; noun: string }) {
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId: user.shopId }, select: { status: true, pickupWhat: true, pickupTips: true, machine: { select: { kind: true } } } });
  if (!t || (!READY.includes(t.status) && !t.pickupWhat && !t.pickupTips.length)) return null;
  const [tips, entry] = await Promise.all([careTipsFor(user.shopId, t.machine.kind), canWork ? entryFor(user.shopId, "draft") : Promise.resolve({ show: false as const })]);
  return (
    <Section title="Pickup sheet">
      <PickupSheetForm
        ticketId={ticketId}
        what={t.pickupWhat ?? ""}
        tips={tips.map((x) => ({ id: x.id, text: x.text }))}
        chosen={t.pickupTips}
        canEdit={canWork}
        admin={user.role !== "TECH"}
        noun={noun}
        draft={entry.show ? { unavailable: entry.unavailable } : null}
      />
    </Section>
  );
}
