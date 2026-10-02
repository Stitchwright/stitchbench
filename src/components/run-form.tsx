"use client";
// A pickup run's plan (scheduling-messaging-design.md 13.6): date, times, who drives, the machines going and coming
// back, a note. The owner's form, for a new run and for changing one.
import type { ActionResult } from "@/lib/action";
import type { RideJob } from "@/lib/partner-run-actions";
import { ActionForm, Submit } from "@/components/action-form";

export type RunDraft = { date: string; start: string; end: string; driver: "repair" | "retail"; collect: string[]; deliver: string[]; note: string | null };

function List({ name, title, jobs, picked, runId, tz }: { name: "collect" | "deliver"; title: string; jobs: RideJob[]; picked: string[]; runId?: string; tz: string }) {
  return (
    <fieldset className="space-y-1">
      <legend className="label">{title}</legend>
      {jobs.length === 0 ? (
        <p className="muted text-sm">None waiting.</p>
      ) : (
        jobs.map((j) => {
          const elsewhere = j.onRun && j.onRun.id !== runId;
          return (
            <label key={j.id} className={`flex items-center gap-2 text-sm ${elsewhere ? "muted" : ""}`}>
              <input type="checkbox" name={name} value={j.id} className="check" defaultChecked={picked.includes(j.id)} disabled={!!elsewhere} />
              <span>
                Tag <span className="mono">{j.tag}</span> · {j.who} · {j.machine}
                {j.ticketNumber ? ` · ticket #${j.ticketNumber}` : ""}
                {elsewhere && ` · on the run of ${new Date(j.onRun!.startsAt).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })}`}
              </span>
            </label>
          );
        })
      )}
    </fieldset>
  );
}

export function RunForm({
  action,
  draft,
  ride,
  ourSide,
  partnerName,
  runId,
  tz,
  submitLabel,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  draft: RunDraft;
  ride: { collect: RideJob[]; deliver: RideJob[] };
  ourSide: "repair" | "retail";
  partnerName: string;
  runId?: string;
  tz: string;
  submitLabel: string;
}) {
  const us = ourSide === "repair" ? "We drive (the repair shop)" : "We drive (the sewing shop)";
  const them = `${partnerName} drives`;
  return (
    <ActionForm action={action} success={runId ? "Saved and sent" : undefined} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="field">
          <label htmlFor="run-date" className="label">
            Date
          </label>
          <input id="run-date" name="date" type="date" className="input" required defaultValue={draft.date} />
        </div>
        <div className="field">
          <label htmlFor="run-start" className="label">
            From
          </label>
          <input id="run-start" name="start" type="time" className="input" required defaultValue={draft.start} />
        </div>
        <div className="field">
          <label htmlFor="run-end" className="label">
            To (optional)
          </label>
          <input id="run-end" name="end" type="time" className="input" defaultValue={draft.end} />
        </div>
      </div>
      <fieldset className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <legend className="label">Who drives</legend>
        {(["repair", "retail"] as const).map((side) => (
          <label key={side} className="flex items-center gap-2">
            <input type="radio" name="driver" value={side} className="check" defaultChecked={draft.driver === side} /> {side === ourSide ? us : them}
          </label>
        ))}
      </fieldset>
      <List name="collect" title={ourSide === "retail" ? "Going to the repair shop" : `Collect from ${partnerName}`} jobs={ride.collect} picked={draft.collect} runId={runId} tz={tz} />
      <List name="deliver" title={ourSide === "retail" ? "Coming back fixed" : `Deliver to ${partnerName}`} jobs={ride.deliver} picked={draft.deliver} runId={runId} tz={tz} />
      <div className="field">
        <label htmlFor="run-note" className="label">
          Note for {partnerName}
        </label>
        <input id="run-note" name="note" className="input" maxLength={1000} defaultValue={draft.note ?? ""} />
      </div>
      <Submit>{submitLabel}</Submit>
    </ActionForm>
  );
}
