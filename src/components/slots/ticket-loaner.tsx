// A repair ticket's loaner (shop-features-round-2-design.md 1.7): "Loaner out: Brother CS6000i, due Oct 14" with "Did the
// loaner come back? Yes" (It's back), or "Lend a machine" while the ticket is open and the shop has loaners in.
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { fmtYmdLong } from "@/lib/units/units";
import { loanDefaults, loansFor, loanWords, unitsToLend } from "@/lib/loans";
import { LendForm } from "@/components/lend-form";
import { LoanBackForm } from "@/components/loan-back-form";
import { Section } from "@/components/ui";

const CLOSED = ["COLLECTED", "RETURNED_UNREPAIRED", "ABANDONED"];

export async function TicketLoanerSlot({ ticketId, user }: { ticketId: string; user: CurrentUser }) {
  const t = await db.ticket.findFirst({ where: { id: ticketId, shopId: user.shopId }, select: { id: true, status: true, customer: { select: { id: true, name: true, phone: true } } } });
  if (!t) return null;
  const [loans, loaners] = await Promise.all([loansFor(user.shopId, { ticketId: t.id, out: true }), unitsToLend(user.shopId, "LOANER")]);
  if (!loans.length && (!loaners.length || !t.customer || CLOSED.includes(t.status))) return null;
  const d = loans.length ? null : await loanDefaults(user.shopId);
  return (
    <Section title="Loaner">
      {loans.map((l) => (
        <div key={l.id} className="space-y-2 text-base">
          <p>
            <span className={`pill mr-1 ${l.overdue ? "tone-wait" : "tone-neutral"}`}>{l.overdue ? "Overdue" : "Out"}</span>
            {loanWords(l, fmtYmdLong)}
          </p>
          <details open={CLOSED.includes(t.status) || t.status === "READY_FOR_PICKUP"}>
            <summary className="link cursor-pointer text-base">Did the loaner come back?</summary>
            <div className="mt-2">
              <LoanBackForm loanId={l.id} heldCents={l.heldCents} admin={user.role !== "TECH"} />
            </div>
          </details>
        </div>
      ))}
      {!loans.length && d && t.customer && (
        <details>
          <summary className="link cursor-pointer text-base">Lend a machine</summary>
          <div className="mt-2">
            <LendForm units={loaners} customer={{ id: t.customer.id, name: t.customer.name, phone: t.customer.phone }} ticketId={t.id} dueOn={d.dueOn} depositCents={d.depositCents} />
          </div>
        </details>
      )}
    </Section>
  );
}
