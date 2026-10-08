// One loan (shop-features-round-2-design.md 1.7): the machine, who has it, when it's due, the deposit, the condition out
// and back; "It's back"; and the short loan slip to sign (printed from here).
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtYmdLong } from "@/lib/units/units";
import { LOAN_KIND_LABEL, loansFor } from "@/lib/loans";
import { LoanBackForm } from "@/components/loan-back-form";
import { PrintButton } from "@/components/print-button";
import { KV, PageHeader, Section } from "@/components/ui";

export default async function LoanPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const row = await db.unitLoan.findFirst({ where: { id, shopId: user.shopId }, select: { unitId: true } });
  if (!row) notFound();
  const l = (await loansFor(user.shopId, { unitId: row.unitId })).find((x) => x.id === id);
  if (!l) notFound();
  const [tz, shop] = await Promise.all([shopTimeZone(user.shopId), db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true } })]);
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title={`${LOAN_KIND_LABEL[l.kind]}: ${l.machine}`} back={{ href: "/units/loans", label: "Loaners and demos" }} actions={<PrintButton />} />
      <Section title={l.backAt ? "Back" : "Out"}>
        <div className="space-y-1 text-base">
          {l.customer && <KV k="With" v={<Link href={`/customers/${l.customer.id}`} className="link">{l.customer.name}</Link>} />}
          {l.ticketId && <KV k="Ticket" v={<Link href={`/tickets/${l.ticketId}`} className="link">Her repair</Link>} />}
          <KV k="Out" v={fmtDate(l.outAt, tz)} />
          {l.dueOn && <KV k="Due back" v={fmtYmdLong(l.dueOn)} />}
          <KV k="Condition going out" v={l.conditionOut ?? ""} />
          {l.backAt && <KV k="Back" v={fmtDate(l.backAt, tz)} />}
          {l.conditionBack && <KV k="Condition coming back" v={l.conditionBack} />}
          {l.depositCents > 0 && <KV k="Deposit" v={money(l.depositCents)} />}
          {l.cardNote && <KV k="Card on file" v={l.cardNote} />}
        </div>
      </Section>
      {!l.backAt && (
        <>
          <div className="card card-pad space-y-3 text-base">
            <p className="font-semibold">{shop.name}: loan slip</p>
            <p>
              I have borrowed the {l.machine} in {l.conditionOut ?? "good"} condition and will bring it back by {l.dueOn ? fmtYmdLong(l.dueOn) : "the day agreed"}.
              {l.depositCents > 0 ? ` My deposit of ${money(l.depositCents)} comes back when it does.` : ""} I&apos;ll take care of it and tell the shop{shop.phone ? ` (${shop.phone})` : ""} about any problem.
            </p>
            <p className="pt-6">Signed ______________________________ Date ____________</p>
          </div>
          <Section title="It's back">
            <LoanBackForm loanId={l.id} heldCents={l.heldCents} admin={user.role !== "TECH"} />
          </Section>
        </>
      )}
    </div>
  );
}
