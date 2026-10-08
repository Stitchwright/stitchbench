// One print or cut job (shop-features-round-2-design.md 6.5): where it stands with the one next step as the main button,
// the price as worked out, the customer's file, the quote by link for approval, collecting it (paid at the register),
// turning it down with a reason, and changing it while it is open.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { jobView, makeSettings, materialsFor } from "@/lib/make-jobs";
import { MAKE_KIND_LABEL, MAKE_MOVES, STATUS_TONE, neverCutHit, statusLabel, type MakeKind } from "@/lib/make-jobs-math";
import { collectMakeJob, sendMakeQuote, setMakeJobStatus, turnDownMakeJob } from "@/actions/make-jobs";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";
import { JobForm } from "@/components/maker/job-form";
import { MakerFrame, makerPageState } from "@/components/maker/maker-page";
import { ymdOf } from "@/lib/zoned";

const NEXT: Record<string, string> = { QUOTED: "APPROVED", APPROVED: "WORKING", WORKING: "READY" };

export default async function MakeJobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const shopId = user.shopId;
  const [s, j, tz, marketing] = await Promise.all([makerPageState(user, true), jobView(shopId, id), shopTimeZone(shopId), gateFor(shopId, "marketing")]);
  if (!j) notFound();
  const write = s.gate === "write";
  const kind = j.kind as MakeKind;
  const moves = MAKE_MOVES[j.status] ?? [];
  const next = NEXT[j.status];
  const editable = write && ["QUOTED", "APPROVED", "WORKING"].includes(j.status);
  const [settings, materials] = editable ? await Promise.all([makeSettings(shopId), materialsFor(shopId)]) : [null, []];
  const machineCents = j.quoteCents - j.materialCents - j.setupCents;
  const nextWord = (to: string) => (to === "APPROVED" ? "The customer approved it" : to === "WORKING" ? (kind === "PRINT" || kind === "RESIN" ? "Start printing" : "Start cutting") : to === "READY" ? "It's ready" : statusLabel(to, kind));
  return (
    <MakerFrame
      title={`Job #${j.number}: ${j.title}`}
      tab="jobs"
      what="This job"
      sub={
        <>
          <span className={`pill ${STATUS_TONE[j.status] ?? ""}`}>{statusLabel(j.status, kind)}</span> {MAKE_KIND_LABEL[kind] ?? j.kind} for{" "}
          {j.customerId ? (
            <Link href={`/customers/${j.customerId}`} className="link">
              {j.name}
            </Link>
          ) : (
            j.name
          )}
          {j.dueAt ? ` · wanted by ${fmtDate(j.dueAt, tz)}` : ""}
        </>
      }
      actions={
        <Link href={`/maker/jobs/${j.id}/print`} className="btn" target="_blank">
          Print the job slip
        </Link>
      }
      {...s}
    >
      {write && (next || moves.length > 0) && (
        <div className="card card-pad flex flex-wrap items-center gap-2">
          {next && (
            <ActionButton action={setMakeJobStatus.bind(null, j.id, next)} className="btn btn-primary">
              {nextWord(next)}
            </ActionButton>
          )}
          {moves
            .filter((to) => to !== next)
            .map((to) => (
              <ActionButton key={to} action={setMakeJobStatus.bind(null, j.id, to)} className="btn" confirm={to === "CANCELLED" ? "Tap again to cancel this job" : undefined}>
                {to === "CANCELLED" ? "Cancel the job" : `Back to ${statusLabel(to, kind).toLowerCase()}`}
              </ActionButton>
            ))}
        </div>
      )}
      {j.status === "READY" && write && (
        <div className="card card-pad space-y-2">
          <h2 className="text-base font-semibold">Picked up: take the payment</h2>
          <ActionForm action={collectMakeJob.bind(null, j.id)} className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="mj-method">
              Paid by
            </label>
            <select id="mj-method" name="method" defaultValue="CASH" className="select w-32">
              <option value="CASH">Cash</option>
              <option value="CARD">Card</option>
              <option value="CHECK">Check</option>
              <option value="GIFT">Gift card</option>
              <option value="OTHER">Other</option>
            </select>
            <Submit className="btn btn-primary">Collected: take {money(j.quoteCents)} plus tax</Submit>
          </ActionForm>
        </div>
      )}
      {j.status === "TURNED_DOWN" && <p className="card card-pad text-base">Turned down: {j.turnedDownWhy}</p>}
      {j.sale && (
        <p className="text-base">
          Paid on{" "}
          <Link href={`/register/sales/${j.sale.id}`} className="link">
            sale #{j.sale.number}
          </Link>
          {j.collectedAt ? `, ${fmtDateTime(j.collectedAt, tz)}` : ""}.
        </p>
      )}
      <Section title="The price">
        <ul className="space-y-1 text-base">
          <li>
            Machine time: {Math.floor(j.machineMinutes / 60)} h {j.machineMinutes % 60} min at {money(j.rateCents)} an hour = {money(machineCents)}
          </li>
          {(j.materialName || j.materialCents > 0) && (
            <li>
              Material: {j.materialQty > 0 ? `${j.materialQty} ${j.materialUnit === "sheet" ? (j.materialQty === 1 ? "sheet" : "sheets") : (j.materialUnit ?? "")} ` : ""}
              {j.materialName ?? ""} = {money(j.materialCents)}
            </li>
          )}
          <li>Set-up: {money(j.setupCents)}</li>
          <li className="text-xl font-semibold">Total {money(j.quoteCents)} before tax</li>
        </ul>
        {j.link && (
          <p className="mt-2 text-sm">
            Quote sent by link:{" "}
            {j.link.answer ? `${j.link.answer === "APPROVED" ? "approved" : "declined"} ${j.link.answeredAt ? fmtDateTime(j.link.answeredAt, tz) : ""}${j.link.answerNote ? `: ${j.link.answerNote}` : ""}` : j.link.revokedAt ? "replaced or stopped" : `waiting for an answer (until ${fmtDate(j.link.expiresAt, tz)})`}
          </p>
        )}
        {write && j.status === "QUOTED" && marketing === "on" && j.customerId && (
          <details className="mt-2">
            <summary className="link cursor-pointer text-sm">Send the quote for them to approve</summary>
            <ActionForm action={sendMakeQuote.bind(null, j.id)} className="mt-2 flex flex-wrap items-end gap-3">
              <label className="flex min-h-11 items-center gap-2 text-base">
                <input type="checkbox" name="sms" className="check" defaultChecked /> Text
              </label>
              <label className="flex min-h-11 items-center gap-2 text-base">
                <input type="checkbox" name="email" className="check" defaultChecked /> Email
              </label>
              <div className="field min-w-64 flex-1">
                <label className="label" htmlFor="mj-qnote">
                  Note with it
                </label>
                <input id="mj-qnote" name="note" className="input" maxLength={500} placeholder="We decide what we'll print or cut." />
              </div>
              <Submit className="btn">Send the quote</Submit>
            </ActionForm>
          </details>
        )}
      </Section>
      <Section title="The customer's file">
        {j.hasFile ? (
          <p className="text-base">
            <a href={`/api/maker/jobs/${j.id}/file`} className="link">
              Download {j.fileName}
            </a>
            <span className="muted text-sm"> · {j.fileDeleteAfter ? `deleted after ${fmtDate(j.fileDeleteAfter, tz)}` : "kept until 30 days after pickup"}</span>
          </p>
        ) : (
          <p className="muted text-sm">{j.fileName ? `${j.fileName} was deleted (30 days after the job ended).` : "No file attached."}</p>
        )}
      </Section>
      {j.note && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-base">{j.note}</p>
        </Section>
      )}
      {editable && settings && (
        <Section title="Change the job">
          <JobForm
            id={j.id}
            hasFile={j.hasFile}
            lockPrices={user.role === "TECH"}
            materials={materials.map((m) => ({ id: m.id, label: `${m.description} (${m.qtyOnHand} on hand)`, itemType: m.itemType, unit: m.measure.unit, unitCents: m.measure.unitCents, neverCut: !!neverCutHit(settings.makeNeverCut, m) }))}
            init={{
              title: j.title,
              kind,
              hours: String(Math.floor(j.machineMinutes / 60)),
              minutes: String(j.machineMinutes % 60),
              materialPartId: j.materialPartId ?? "",
              materialName: j.materialPartId ? "" : (j.materialName ?? ""),
              materialQty: j.materialQty ? String(j.materialQty) : "",
              rate: (j.rateCents / 100).toFixed(2),
              setup: (j.setupCents / 100).toFixed(2),
              due: j.dueAt ? ymdOf(j.dueAt, tz) : "",
              note: j.note ?? "",
              taxable: j.taxable,
            }}
          />
        </Section>
      )}
      {write && ["QUOTED", "APPROVED"].includes(j.status) && (
        <details className="card card-pad">
          <summary className="cursor-pointer text-base">Turn it down</summary>
          <ActionForm action={turnDownMakeJob.bind(null, j.id)} className="mt-2 flex flex-wrap items-end gap-2">
            <div className="field min-w-64 flex-1">
              <label className="label" htmlFor="mj-why">
                Why (a copied logo, a weapon, an unsafe material...)
              </label>
              <input id="mj-why" name="why" className="input" maxLength={300} required />
            </div>
            <Submit className="btn">Turn it down</Submit>
          </ActionForm>
        </details>
      )}
    </MakerFrame>
  );
}
