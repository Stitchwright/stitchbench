// Messages about a ticket and the uncollected-machine schedule (scheduling-messaging-design.md sections 7.3 and 9.5).
// Server component. The same block serves a partner job (job-notices.tsx). The dates always show, Marketing or not;
// everything that sends needs Marketing, and the by-hand record never does. Message bodies are plain text.
import Link from "next/link";
import type { OutMessage } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { ABANDON_STAGE_LABEL, CHANNEL_LABEL, MESSAGE_KIND_LABEL, MESSAGE_STATUS_LABEL, MESSAGE_STATUS_TONE, SKIP_REASON_LABEL } from "@/lib/constants";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { messagingView } from "@/lib/messaging/settings";
import { renderKind } from "@/lib/messaging/templates";
import { shopTimeZone } from "@/lib/shop-zone";
import { abandonDate, abandonStages, currentStage } from "@/lib/notices/abandon";
import { fmtDay, fmtTime, ymdOf } from "@/lib/zoned";
import { abandonTarget, abandonVars, notDelivered, scheduleFor, stageRows, type StageView } from "@/lib/notices/vars";
import { READY_JOB_STATUSES } from "@/lib/notices/hooks";
import { cancelMessage } from "@/actions/messaging";
import { markBackAtCounter, recordManualNotice, sendNoticeNow, tellThenSendReady } from "@/actions/notices";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { PrintButton } from "@/components/print-button";
import { PageHeader, Section } from "@/components/ui";

type Ref = { ticketId: string; jobId?: undefined } | { jobId: string; ticketId?: undefined };

const stamp = (d: Date, tz: string) => `${fmtDateTime(d, tz, { month: "short", day: "numeric" })}, ${fmtTime(d, tz)}`;
const HOW_WORDS: Record<string, string> = { email: "email", sms: "text", letter: "letter", certified_mail: "certified mail", phone: "phone call" };

function reasonOf(m: OutMessage): string | null {
  if (m.status === "SKIPPED") return SKIP_REASON_LABEL[m.error as keyof typeof SKIP_REASON_LABEL] ?? m.error;
  return m.error;
}

/** "Sent by text Oct 3, 10:02 am" / "Given by certified mail Oct 3 (tracking 7021 ...)". */
function sentLine(m: OutMessage, tz: string, names: Map<string, string>): string {
  const how = HOW_WORDS[m.channel] ?? m.channel;
  if (!m.byUserId) return `Sent by ${how} ${m.sentAt ? stamp(m.sentAt, tz) : ""}`.trim();
  // Email and texts a person asked for still went out from here; "given" is for what was mailed, handed over or said.
  if (m.channel === "email" || m.channel === "sms") return `Sent by ${how} ${m.sentAt ? stamp(m.sentAt, tz) : ""}, asked for by ${names.get(m.byUserId) ?? "staff"}`.replace(" ,", ",");
  const given = m.sentAt ? fmtDateTime(m.sentAt, tz, { month: "short", day: "numeric" }) : "";
  const recorded = fmtDateTime(m.createdAt, tz, { month: "short", day: "numeric" });
  const by = names.get(m.byUserId) ?? "staff";
  return `Given by ${how} ${given}${m.providerId && m.channel === "certified_mail" ? ` (tracking ${m.providerId})` : ""}${given !== recorded ? ` · recorded ${stamp(m.createdAt, tz)} by ${by}` : ` · recorded by ${by}`}`;
}

function Words({ m }: { m: OutMessage }) {
  return (
    <details className="mt-1 text-xs">
      <summary className="muted cursor-pointer">What was sent</summary>
      {m.subject && <p className="mt-1 font-semibold">{m.subject}</p>}
      <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
    </details>
  );
}

export async function TicketNoticesSlot({ ticketId, user }: { ticketId: string; user: CurrentUser }) {
  return <NoticesBlock user={user} ref_={{ ticketId }} />;
}

/** Messages and the schedule for a ticket or a retail partner job. */
export async function NoticesBlock({ user, ref_ }: { user: CurrentUser; ref_: Ref }) {
  const shopId = user.shopId;
  const isJob = ref_.jobId !== undefined;
  const id = isJob ? ref_.jobId : ref_.ticketId;
  // Ownership: the row must be this shop's (messages and the target are looked up by shop below).
  const [ticket, job] = await Promise.all([
    isJob ? null : db.ticket.findFirst({ where: { id, shopId }, select: { id: true, number: true, status: true, customerId: true } }),
    isJob ? db.repairJob.findUnique({ where: { shopId_id: { shopId, id } }, select: { id: true, side: true, status: true, backAt: true, pickedUpAt: true, customerId: true, tag: true } }) : null,
  ]);
  if (isJob ? !job || job.side !== "retail" : !ticket) return null;

  const [tz, ms, gate, target, messages] = await Promise.all([
    shopTimeZone(shopId),
    messagingView(shopId),
    gateFor(shopId, "marketing"),
    abandonTarget(db, shopId, isJob ? { jobId: id } : { ticketId: id }),
    db.outMessage.findMany({ where: { shopId, ...(isJob ? { repairJobId: id } : { ticketId: id }) }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const on = gate === "on";
  const admin = user.role !== "TECH";
  const awaitingBack = isJob && !!job && !job.backAt && !job.pickedUpAt && READY_JOB_STATUSES.includes(job.status);
  if (!target && !messages.length && !awaitingBack) return null;

  const byIds = [...new Set(messages.map((m) => m.byUserId).filter((x): x is string => !!x))];
  const people = byIds.length ? await db.user.findMany({ where: { shopId, id: { in: byIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(people.map((p) => [p.id, p.name]));

  const now = new Date();
  const sched = target ? scheduleFor(target.start, target.abandonedAfterDays, tz, ms, now, await stageRows(db, shopId, isJob ? { jobId: id } : { ticketId: id })) : null;
  const letterBase = isJob ? `/repairs/${id}/notice-letter` : `/tickets/${id}/notice-letter`;
  const targetArg = isJob ? { jobId: id } : { ticketId: id };
  const customerId = (isJob ? job?.customerId : ticket?.customerId) ?? null;
  const newestReady = messages.find((m) => m.kind === "ready");
  // Skipped at queue time the row holds the reason's key; skipped by the worker at send time, its label.
  const why = newestReady?.status === "SKIPPED" ? newestReady.error : null;
  const notReachable = why === "not_asked" || why === "no_address" || why === SKIP_REASON_LABEL.not_asked || why === SKIP_REASON_LABEL.no_address;
  const needsAnswer = !!target && !!customerId && on && notReachable;

  return (
    <Section title="Messages">
      <div className="space-y-4 text-sm">
        {awaitingBack && (
          <div className="flex flex-wrap items-center gap-3">
            <ActionButton action={markBackAtCounter.bind(null, id)} className="btn btn-primary btn-sm" success="Recorded">
              {on ? "It's back at the counter: tell the customer" : "It's back at the counter"}
            </ActionButton>
            <span className="muted">The repair shop marked it ready. Press this when it is here.</span>
          </div>
        )}

        {messages.length === 0 ? (
          <p className="muted">No messages about this yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {messages.map((m) => {
              const when = m.status === "SENT" ? m.sentAt : m.status === "QUEUED" ? m.sendAfter : m.createdAt;
              const reason = m.status === "SENT" ? null : reasonOf(m);
              return (
                <li key={m.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold">{MESSAGE_KIND_LABEL[m.kind] ?? m.kind}</span>
                    <span className="muted">{CHANNEL_LABEL[m.channel] ?? m.channel}</span>
                    {when && <span className="num muted">{stamp(when, tz)}</span>}
                    <span className={`pill tone-${MESSAGE_STATUS_TONE[m.status] ?? "neutral"}`}>{MESSAGE_STATUS_LABEL[m.status] ?? m.status}</span>
                    {m.status === "QUEUED" && (m.kind === "ready" || (m.kind === "abandon" && admin)) && (
                      <ActionButton action={cancelMessage.bind(null, m.id)} className="btn btn-sm" success="Stopped">
                        Don&apos;t send
                      </ActionButton>
                    )}
                  </div>
                  {reason && <p className="muted text-xs">{reason}</p>}
                  {m.status === "SENT" && m.byUserId && <p className="muted text-xs">{sentLine(m, tz, names)}</p>}
                  {notDelivered(m) && <p className="text-xs" style={{ color: "var(--bad)" }}>Not delivered: {m.deliveryError ?? m.deliveryStatus}</p>}
                  <Words m={m} />
                </li>
              );
            })}
          </ul>
        )}

        {needsAnswer && (
          <div className="flex flex-wrap items-center gap-2">
            <span>They said:</span>
            {(
              [
                ["sms", "Text"],
                ["email", "Email"],
                ["both", "Both"],
              ] as const
            ).map(([v, label]) => (
              <ActionForm key={v} action={tellThenSendReady.bind(null, targetArg, customerId ?? "")} success="Saved: the notice is queued">
                <input type="hidden" name="notifyBy" value={v} />
                <input type="hidden" name="source" value="ticket" />
                <Submit className="btn btn-sm">{label}</Submit>
              </ActionForm>
            ))}
          </div>
        )}

        {target && sched && (
          <div className="space-y-3 border-t border-line pt-3">
            <h3 className="font-semibold">If it isn&apos;t picked up</h3>
            <ul className="space-y-2">
              {sched.stages.map((v) => (
                <li key={v.key} className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="font-medium">{ABANDON_STAGE_LABEL[v.stage.key]}</span> <span className="muted">{fmtDay(v.stage.due, tz)}</span>
                    <div className="text-xs">
                      <StageText v={v} tz={tz} names={names} marketing={on} auto={ms.abandonNotices} />
                    </div>
                    {v.rows
                      .filter((r) => r.status === "SENT")
                      .map((r) => (
                        <Words key={r.id} m={r} />
                      ))}
                  </div>
                  <Link href={`${letterBase}?stage=${v.stage.key}`} className="link no-print text-xs">
                    Print as a letter
                  </Link>
                </li>
              ))}
            </ul>
            <p className="text-xs">
              Abandoned after {fmtDay(sched.abandonAt, tz)}; storage fee {money(target.storageFeeCents)}.
            </p>
            <p className="muted text-xs">Some states require a letter (often certified mail) before you can dispose of a machine. Check yours.</p>

            <details className="rounded border border-line">
              <summary className="cursor-pointer px-3 py-2 font-semibold">Record a notice given by hand</summary>
              <ActionForm action={recordManualNotice.bind(null, targetArg)} success="Recorded" reset className="grid-form border-t border-line px-3 py-3">
                <div className="field">
                  <label htmlFor="rn-stage" className="label">
                    Which notice
                  </label>
                  <select id="rn-stage" name="stage" className="input" defaultValue={sched.stages.find((s) => s.state === "due")?.stage.key ?? sched.stages[0]?.stage.key}>
                    {sched.stages.map((s) => (
                      <option key={s.key} value={s.stage.key}>
                        {ABANDON_STAGE_LABEL[s.stage.key]} ({fmtDay(s.stage.due, tz)})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="rn-how" className="label">
                    How
                  </label>
                  <select id="rn-how" name="how" className="input" defaultValue="letter">
                    <option value="letter">Letter</option>
                    <option value="certified_mail">Certified mail</option>
                    <option value="phone">Phone call</option>
                    <option value="email">Email</option>
                    <option value="sms">Text</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="rn-tracking" className="label">
                    Tracking number (certified mail)
                  </label>
                  <input id="rn-tracking" name="tracking" className="input mono" maxLength={200} />
                </div>
                <div className="field">
                  <label htmlFor="rn-date" className="label">
                    Date given
                  </label>
                  <input id="rn-date" name="date" type="date" className="input" defaultValue={ymdOf(now, tz)} max={ymdOf(now, tz)} />
                </div>
                <div className="field sm:col-span-2">
                  <label htmlFor="rn-text" className="label">
                    What was said or sent
                  </label>
                  <textarea id="rn-text" name="text" required maxLength={5000} rows={3} className="input" />
                </div>
                <div className="flex items-end">
                  <Submit className="btn btn-sm btn-primary">Record it</Submit>
                </div>
              </ActionForm>
            </details>

            {on && (
              <div className="flex flex-wrap gap-2">
                {admin && (
                  <ActionButton action={sendNoticeNow.bind(null, targetArg, "abandon")} className="btn btn-sm" confirm="Tap again: send it now" success="Queued: it goes out in a minute">
                    Send the current notice now
                  </ActionButton>
                )}
                <ActionButton action={sendNoticeNow.bind(null, targetArg, "ready")} className="btn btn-sm" success="Queued: it goes out in a minute">
                  Send the ready notice again
                </ActionButton>
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

/**
 * The uncollected-machine notice as a letter to print (invoice layout): shop header, date, the customer's postal address,
 * "Re: your ...", the stage's email wording, and a form (not printed) that records it as mailed.
 */
export async function NoticeLetter({ user, ref_, stage }: { user: CurrentUser; ref_: Ref; stage: string | null }) {
  const shopId = user.shopId;
  const isJob = ref_.jobId !== undefined;
  const id = isJob ? ref_.jobId : ref_.ticketId;
  const target = await abandonTarget(db, shopId, isJob ? { jobId: id } : { ticketId: id });
  const back = isJob ? `/repairs/${id}` : `/tickets/${id}`;
  if (!target) {
    return (
      <div>
        <PageHeader back={{ href: back, label: "Back" }} title="Notice letter" />
        <p className="muted text-sm">{isJob ? "This job isn't back at the counter, or was picked up." : "This ticket isn't waiting for pickup."} There is nothing to print.</p>
      </div>
    );
  }
  const [shop, ms, customer] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, address: true, phone: true, email: true } }),
    messagingView(shopId),
    db.customer.findFirst({ where: { id: target.customerId, shopId }, select: { name: true, address: true } }),
  ]);
  const now = new Date();
  const stages = abandonStages(target.start, ms.abandonDays, target.abandonedAfterDays, ms.finalNoticeDays, ms.reminderHour, target.tz);
  const s = stages.find((x) => x.key === stage) ?? currentStage(stages, now);
  if (!s) {
    return (
      <div>
        <PageHeader back={{ href: back, label: "Back" }} title="Notice letter" />
        <p className="muted text-sm">There is no notice stage to print: check the days under Settings, Messages.</p>
      </div>
    );
  }
  const vars = abandonVars(target);
  const words = renderKind(ms, s.final ? "abandon_final" : "abandon", "email", vars);
  const tz = target.tz;
  const targetArg = isJob ? { jobId: id } : { ticketId: id };
  return (
    <div>
      <div className="no-print">
        <PageHeader back={{ href: back, label: "Back" }} title="Notice letter" actions={<PrintButton />} />
      </div>
      <article className="card mx-auto max-w-3xl bg-white p-8 text-black print:border-0 print:p-0">
        <header className="border-b border-line pb-4">
          <div className="text-xl font-bold">{shop.name}</div>
          {shop.address && <div className="text-sm whitespace-pre-line">{shop.address}</div>}
          <div className="text-sm">{[shop.phone, shop.email].filter(Boolean).join(" · ")}</div>
        </header>
        <section className="space-y-4 py-6 text-sm">
          <div>{fmtDate(now, tz)}</div>
          <div>
            <div className="font-semibold">{customer?.name ?? ""}</div>
            <div className="whitespace-pre-line">{customer?.address || "(no postal address on file)"}</div>
          </div>
          <p className="font-semibold">
            Re: your {vars.machine} ({vars.ref})
          </p>
          <p className="whitespace-pre-wrap">{words.body}</p>
          <dl className="grid max-w-sm grid-cols-2 gap-y-1">
            <dt>Ready since</dt>
            <dd>{fmtDate(target.start, tz)}</dd>
            <dt>Abandoned after</dt>
            <dd>{fmtDate(abandonDate(target.start, target.abandonedAfterDays, tz), tz)}</dd>
            <dt>Storage fee</dt>
            <dd>{money(target.storageFeeCents)}</dd>
          </dl>
        </section>
      </article>
      <div className="no-print mx-auto mt-4 max-w-3xl">
        <ActionForm action={recordManualNotice.bind(null, targetArg)} success="Recorded" className="card card-pad flex flex-wrap items-end gap-3">
          <input type="hidden" name="stage" value={s.key} />
          <input type="hidden" name="text" value={words.body} />
          <div className="field">
            <label htmlFor="nl-tracking" className="label">
              Tracking number (certified mail)
            </label>
            <input id="nl-tracking" name="tracking" className="input mono" maxLength={200} />
          </div>
          <button type="submit" name="how" value="letter" className="btn btn-sm">
            Mailed today
          </button>
          <button type="submit" name="how" value="certified_mail" className="btn btn-sm btn-primary">
            Sent by certified mail
          </button>
        </ActionForm>
      </div>
    </div>
  );
}

function StageText({ v, tz, names, marketing, auto }: { v: StageView; tz: string; names: Map<string, string>; marketing: boolean; auto: boolean }) {
  const date = fmtDay(v.stage.due, tz);
  const sent = v.rows.filter((r) => r.status === "SENT");
  switch (v.state) {
    case "sent":
      return <span>{sent.map((r) => sentLine(r, tz, names)).join(" · ")}</span>;
    case "undelivered": {
      const bad = sent.find((r) => notDelivered(r));
      return (
        <span style={{ color: "var(--bad)" }}>
          Sent but not delivered: {bad?.deliveryError ?? bad?.deliveryStatus ?? "no reason given"}: send it another way
        </span>
      );
    }
    case "waiting":
      return <span>Waiting to go out</span>;
    case "not_sent": {
      const r = v.rows.at(-1);
      return <span>Not sent{r ? `: ${reasonOf(r) ?? MESSAGE_STATUS_LABEL[r.status]?.toLowerCase() ?? r.status}` : ""}</span>;
    }
    case "past":
      return <span>Past the notice window: decide by hand</span>;
    case "replaced":
      return <span>Not sent (a later notice was due)</span>;
    case "coming":
      // Not due yet: the date, and a word on who sends it when the day comes.
      if (!marketing) return <span>Due {date} (by hand: Messages is off)</span>;
      if (!auto) return <span>Due {date} (by hand: automatic notices are off)</span>;
      return <span>Due {date}</span>;
    default:
      if (!marketing) return <span>Due {date}: send it by hand (Messages is off)</span>;
      if (!auto) return <span>Due {date}: send it by hand (automatic notices are off)</span>;
      return <span>Due {date}</span>;
  }
}
