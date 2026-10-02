// One pickup run (scheduling-messaging-design.md 13.6): the plan with each machine's current status, what each side
// recorded, the history, and the buttons this side may press (OK / Change / Cancel / Record). Both sides view it.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { fmtDateTime } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtRange, fmtWhen, hmOf, wall, ymdOf } from "@/lib/zoned";
import { JOB_STATUS_LABEL, RUN_STATUS_LABEL, STATUS_LABEL } from "@/lib/constants";
import { canDo, okWords, receivedList, type Side } from "@/lib/partner-runs";
import { rideJobs, runState } from "@/lib/partner-run-actions";
import { cancelRun, changeRun, okRun, recordRun } from "@/actions/partner-runs";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { RunForm } from "@/components/run-form";
import { KV, PageHeader, Section } from "@/components/ui";

const TONE: Record<string, string> = { SCHEDULED: "wait", DONE: "done", CANCELLED: "neutral" };
type Ev = { at: string; side?: string; what?: string; name?: string; note?: string };

export default async function RunPage({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const user = await requireUser();
  const shopId = user.shopId;
  const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId, id } } });
  if (!link) notFound();
  const run = await db.partnerRun.findUnique({ where: { shopId_id: { shopId, id: runId } } });
  if (!run || run.linkId !== link.id) notFound();
  const side = link.side as Side;
  const weOwn = run.ownerSide === side;
  const [tz, scheduling] = await Promise.all([shopTimeZone(shopId), gateFor(shopId, "scheduling")]);
  const state = runState(run);
  const may = (a: "change" | "ok" | "cancel" | "record") => canDo(state, side, a, link.partnerName) === null;
  const ids = [...new Set([...run.collect, ...run.deliver, ...run.collected, ...run.delivered])];
  const jobs = ids.length ? await db.repairJob.findMany({ where: { shopId, linkId: link.id, side: link.side, id: { in: ids } } }) : [];
  const tickets = side === "repair" ? await db.ticket.findMany({ where: { shopId, id: { in: jobs.map((j) => j.ticketId).filter((x): x is string => !!x) } }, select: { id: true, status: true } }) : [];
  const ticketStatus = new Map(tickets.map((t) => [t.id, t.status as string]));
  const jobOf = new Map(jobs.map((j) => [j.id, j]));
  const words = (jobId: string) => {
    const j = jobOf.get(jobId);
    if (!j) return <span className="muted">not received yet</span>;
    const status = side === "repair" && j.ticketId ? (ticketStatus.get(j.ticketId) ?? j.status) : j.status;
    const label = side === "repair" ? (STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status) : (JOB_STATUS_LABEL[status as keyof typeof JOB_STATUS_LABEL] ?? status);
    return (
      <>
        <Link href={side === "repair" && j.ticketId ? `/tickets/${j.ticketId}` : `/repairs/${j.id}`} className="link">
          Tag {j.tag}
        </Link>{" "}
        · {j.customerName} · {j.brand} {j.model} · <span className="muted">{label}</span>
      </>
    );
  };
  const ride = may("change") ? await rideJobs(shopId, link) : null;
  const w = wall(run.startsAt, tz);
  const we = run.endsAt ? wall(run.endsAt, tz) : null;
  const events = (Array.isArray(run.events) ? (run.events as Ev[]) : []).slice().reverse();
  const myList = receivedList(side);
  const toRecord = side === "repair" ? run.collect : run.deliver;
  const recordTitle = side === "repair" ? "Record what the driver took" : "Record what arrived here";

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Run on ${fmtWhen(run.startsAt, tz)}`}
        back={{ href: `/partners/${link.id}`, label: link.partnerName }}
        sub={
          <>
            <span className={`pill tone-${TONE[run.status] ?? "neutral"}`}>{RUN_STATUS_LABEL[run.status] ?? run.status}</span> · scheduled by {weOwn ? "you" : link.partnerName} · {run.driver === side ? "you drive" : `${link.partnerName} drives`}
            {run.status === "SCHEDULED" ? ` · ${okWords(state, link.partnerName, weOwn)}` : ""}
          </>
        }
      />

      <Section title="The plan">
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <KV k="When" v={run.endsAt ? fmtRange(run.startsAt, run.endsAt, tz) : fmtWhen(run.startsAt, tz)} />
          <KV k="Note" v={run.note} />
          <div>
            <div className="label">{side === "retail" ? "Going to the repair shop" : `Collect from ${link.partnerName}`} ({run.collect.length})</div>
            <ul className="mt-1 space-y-1">
              {run.collect.map((jid) => (
                <li key={jid}>{words(jid)}</li>
              ))}
              {run.collect.length === 0 && <li className="muted">None</li>}
            </ul>
          </div>
          <div>
            <div className="label">{side === "retail" ? "Coming back fixed" : `Deliver to ${link.partnerName}`} ({run.deliver.length})</div>
            <ul className="mt-1 space-y-1">
              {run.deliver.map((jid) => (
                <li key={jid}>{words(jid)}</li>
              ))}
              {run.deliver.length === 0 && <li className="muted">None</li>}
            </ul>
          </div>
          <KV k="The driver took" v={run.collectedAt ? `${run.collected.length} machine${run.collected.length === 1 ? "" : "s"}, recorded ${fmtDateTime(run.collectedAt, tz)}` : "not recorded yet"} />
          <KV k="Arrived at the sewing shop" v={run.deliveredAt ? `${run.delivered.length} machine${run.delivered.length === 1 ? "" : "s"}, recorded ${fmtDateTime(run.deliveredAt, tz)}` : "not recorded yet"} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {may("ok") && (
            <ActionButton action={okRun.bind(null, link.id, run.id)} success="OK'd and sent" className="btn btn-sm btn-primary">
              OK it
            </ActionButton>
          )}
          {may("cancel") && (
            <ActionForm action={cancelRun.bind(null, link.id, run.id)} success="Cancelled and sent" className="inline-flex items-center gap-2">
              <input name="note" className="input" placeholder={weOwn ? "Why (optional)" : `Why, so ${link.partnerName} knows`} maxLength={1000} aria-label="Why" />
              <Submit className="btn btn-sm">Cancel the run</Submit>
            </ActionForm>
          )}
        </div>
      </Section>

      {may("record") && (
        <Section title={recordTitle}>
          <ActionForm action={recordRun.bind(null, link.id, run.id)} success="Recorded and sent" className="space-y-2 text-sm">
            {toRecord.length === 0 && <p className="muted">Nothing was planned in this direction; tick anything that went anyway.</p>}
            {[...new Set([...toRecord, ...jobs.map((j) => j.id)])].map((jid) => (
              <label key={jid} className="flex items-center gap-2">
                <input type="checkbox" name="jobIds" value={jid} className="check" defaultChecked={toRecord.includes(jid)} disabled={!jobOf.has(jid)} />
                <span>{words(jid)}</span>
              </label>
            ))}
            <Submit className="btn btn-sm btn-primary">{recordTitle}</Submit>
            <p className="muted text-xs">{side === "repair" ? "Their tickets go to In truck." : "They're back at the counter; the ready notice goes out when Marketing is on."}</p>
          </ActionForm>
        </Section>
      )}

      {ride && scheduling === "on" && (
        <Section title="Change the plan">
          <RunForm
            action={changeRun.bind(null, link.id, run.id)}
            draft={{ date: ymdOf(run.startsAt, tz), start: hmOf(w.hour * 60 + w.minute), end: we ? hmOf(we.hour * 60 + we.minute) : "", driver: run.driver as Side, collect: run.collect, deliver: run.deliver, note: run.note }}
            ride={ride}
            ourSide={side}
            partnerName={link.partnerName}
            runId={run.id}
            tz={tz}
            submitLabel="Save the change and tell them"
          />
        </Section>
      )}
      {weOwn && may("change") && scheduling !== "on" && <p className="muted text-sm">Changing the plan needs Scheduling. You can still cancel it or record the hand-off.</p>}

      <Section title="History">
        <ul className="space-y-1 text-sm">
          {events.map((e, i) => (
            <li key={i}>
              <span className="num muted">{fmtDateTime(new Date(e.at), tz)}</span> · {e.what === "scheduled" ? "scheduled" : e.what === "changed" ? "plan changed" : e.what === "ok" ? "OK'd" : e.what === "cancelled" ? "cancelled" : e.what === "collected" ? "driver took the machines" : e.what === "delivered" ? "machines arrived at the counter" : (e.what ?? "")}
              {e.name ? ` by ${e.name}` : ""}
              {e.side ? ` (${e.side === side ? "you" : link.partnerName})` : ""}
              {e.note ? `: ${e.note}` : ""}
            </li>
          ))}
          {events.length === 0 && <li className="muted">Nothing yet.</li>}
        </ul>
      </Section>
      <p className="muted text-xs">{myList === "collected" ? "You record what the driver takes; the sewing shop records what arrives." : "The repair shop records what the driver takes; you record what arrives."}</p>
    </div>
  );
}
