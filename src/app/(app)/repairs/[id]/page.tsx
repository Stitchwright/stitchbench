import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money, ticketNo } from "@/lib/format";
import type { JobEvent, JobLine } from "@/lib/partners";
import { JOB_STATUS_LABEL } from "@/lib/constants";
import type { TicketStatus } from "@/generated/prisma/enums";
import { PageHeader, Section, KV, JobStatusPill } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { PhotoStrip, PHOTO_SELECT } from "@/components/photo-strip";
import { answerEstimate, cancelJob, markPickedUp } from "@/actions/repair-jobs";

export default async function RepairJobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const j = await db.repairJob.findUnique({
    where: { shopId_id: { shopId: user.shopId, id } },
    include: { customer: true, machine: { include: { photos: { select: PHOTO_SELECT, orderBy: { createdAt: "desc" } } } } },
  });
  if (!j || j.side !== "retail") notFound();
  const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId: user.shopId, id: j.linkId } } });
  const lines = (j.lines as JobLine[] | null) ?? [];
  const events = (j.events as JobEvent[]) ?? [];
  const ready = ["READY_FOR_PICKUP", "READY_IN_TRUCK", "RETURNED_UNREPAIRED"].includes(j.status);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/repairs", label: "Repairs" }}
        title={
          <>
            Tag <span className="mono">{j.tag}</span> <JobStatusPill status={j.status} side="retail" />
          </>
        }
        sub={`${j.brand} ${j.model}${j.serial ? ` · SN ${j.serial}` : ""} · to ${link?.partnerName ?? "repair shop"}${j.ticketNumber ? ` (their ticket #${ticketNo(j.ticketNumber)})` : ""}`}
        actions={
          <a href={`/repairs/${j.id}/tag`} className="btn">
            Print claim tag
          </a>
        }
      />

      {j.status === "WAITING_CUSTOMER_OK" && !j.approval && (
        <Section title="The repair shop needs the customer's OK">
          <p className="mb-3 text-sm">
            {j.repairNote ?? "The repair shop sent an estimate."} Estimate so far: <strong>{money(j.totalCents)}</strong>. Call{" "}
            {j.customer ? (
              <>
                {j.customer.name}
                {j.customer.phone && (
                  <>
                    {" "}
                    at{" "}
                    <a href={`tel:${j.customer.phone}`} className="link">
                      {j.customer.phone}
                    </a>
                  </>
                )}
              </>
            ) : (
              "the customer"
            )}
            , then record the answer.
          </p>
          <div className="flex flex-wrap gap-4">
            <ActionForm action={answerEstimate.bind(null, j.id, "APPROVED")} className="flex flex-wrap items-end gap-2" success="Sent to the repair shop">
              <div className="field w-32">
                <label htmlFor="approved" className="label">
                  Approved up to
                </label>
                <input id="approved" name="approved" inputMode="decimal" defaultValue={j.totalCents != null ? (j.totalCents / 100).toFixed(2) : ""} className="input num" />
              </div>
              <input name="note" aria-label="Note with the approval" className="input w-48" placeholder="Note (optional)" />
              <Submit>Customer approved</Submit>
            </ActionForm>
            <ActionForm action={answerEstimate.bind(null, j.id, "DECLINED")} className="flex items-end gap-2" success="Sent to the repair shop">
              <input name="note" aria-label="Note with the decline" className="input w-48" placeholder="Note (optional)" />
              <Submit className="btn btn-danger">Customer declined</Submit>
            </ActionForm>
          </div>
        </Section>
      )}
      {j.approval && (
        <p className={`pill ${j.approval === "APPROVED" ? "tone-done" : "tone-bad"}`}>
          Customer {j.approval === "APPROVED" ? `approved${j.approvedCents != null ? ` up to ${money(j.approvedCents)}` : ""}` : "declined"}
        </p>
      )}

      {ready && !j.pickedUpAt && (
        <Section title="Handing it back">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {!j.paidAt && j.totalCents != null && j.totalCents > 0 ? (
              <>
                <span>
                  The customer owes <strong>{money(j.totalCents)}</strong>. Ring it up on the register (Repair pickup).
                </span>
                <Link href="/register" className="btn btn-primary">
                  Register
                </Link>
              </>
            ) : (
              <span>{j.paidAt ? `Paid ${fmtDate(j.paidAt)}.` : "Nothing to pay."}</span>
            )}
            <ActionButton action={markPickedUp.bind(null, j.id)} confirm="Tap again: the customer has it" success="Marked as picked up">
              Customer took it (no payment here)
            </ActionButton>
          </div>
        </Section>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Customer and machine">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <KV k="Customer" v={j.customer ? <Link href={`/customers/${j.customer.id}`} className="link">{j.customer.name}</Link> : j.customerName} />
            <KV k="Phone" v={j.customer?.phone} />
            <KV k="Machine" v={`${j.brand} ${j.model}`} />
            <KV k="Serial" v={j.serial} />
            <KV k="Problem" v={j.problem} />
            <KV k="Service asked for" v={j.serviceRequested} />
            <KV k="Came with" v={j.accessories.join(", ")} />
            <KV k="OK'd up to" v={money(j.preApprovedCents)} />
          </div>
        </Section>
        <Section title="The repair shop's bill">
          {lines.length === 0 ? (
            <p className="muted text-sm">Nothing on the bill yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {lines.map((l, i) => (
                <li key={i} className="flex justify-between">
                  <span>{l.description}</span>
                  <span className="num">{money(l.amountCents)}</span>
                </li>
              ))}
              <li className="flex justify-between">
                <span>Tax</span>
                <span className="num">{money(j.taxCents ?? 0)}</span>
              </li>
              <li className="flex justify-between border-t border-line pt-1 font-semibold">
                <span>Customer pays</span>
                <span className="num">{money(j.totalCents)}</span>
              </li>
              <li className="muted flex justify-between">
                <span>Your commission ({j.commissionPct}%)</span>
                <span className="num">{money(j.commissionCents ?? 0)}</span>
              </li>
            </ul>
          )}
          {j.repairNote && <p className="mt-3 text-sm">From the repair shop: {j.repairNote}</p>}
        </Section>
      </div>

      {j.machine && (
        <Section title="Photos">
          <PhotoStrip machineId={j.machine.id} photos={j.machine.photos} />
        </Section>
      )}

      <Section title="History">
        <ul className="space-y-1 text-sm">
          {events.map((e, i) => (
            <li key={i}>
              {new Date(e.at).toLocaleString("en-US")} · {e.status ? (JOB_STATUS_LABEL[e.status as TicketStatus] ?? e.status) : ""} {e.note ?? ""}
            </li>
          ))}
        </ul>
      </Section>

      {j.status === "AT_SHOP_AWAITING_PICKUP" && (
        <Section title="Customer changed their mind?">
          <ActionForm action={cancelJob.bind(null, j.id)} className="flex flex-wrap items-end gap-2" success="Cancelled">
            <input name="note" aria-label="Why it's cancelled" className="input w-64" placeholder="Why (optional)" />
            <Submit className="btn btn-danger">Cancel: customer took it back</Submit>
          </ActionForm>
        </Section>
      )}
    </div>
  );
}
