// The estimate and the customer's OK on a ticket (scheduling-messaging-design.md sections 7.3 and 10.5). The panel is
// shared with the partner-job slot (job-estimate.tsx).
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { isUserError } from "@/lib/action";
import { fmtDateTime } from "@/lib/format";
import { JOB_STATUS_LABEL, SITE_STATUS_LABEL, STATUS_LABEL } from "@/lib/constants";
import { estimateChannels, estimateContent, estimateSubject, repliesSince, type EstimateSubject } from "@/lib/estimate-links";
import { finalize } from "@/lib/messaging/queue";
import { messagingView, publicBaseUrl } from "@/lib/messaging/settings";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import type { Channel } from "@/lib/messaging/types";
import { recordEstimateAnswer, revokeEstimateLink, sendEstimate } from "@/actions/estimate-links";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Section } from "@/components/ui";

const DAY = 86_400_000;

/** "Oct 7, 2:10 pm" in the shop's time zone. */
const stamp = (d: Date, tz: string) => fmtDateTime(d, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/ (AM|PM)$/, (m) => m.toLowerCase());
const dayOf = (d: Date, tz: string) => fmtDateTime(d, tz, { month: "short", day: "numeric" });
const by = (channels: Set<string>) => (channels.has("sms") && channels.has("email") ? "text and email" : channels.has("sms") ? "text" : "email");

function AnswerForm({ target, id, answer, via, children }: { target: "ticket" | "job"; id: string; answer: "APPROVED" | "DECLINED"; via: "text reply" | "phone"; children: React.ReactNode }) {
  return (
    <ActionForm action={recordEstimateAnswer.bind(null, target, id)} success="Recorded" className="inline-flex">
      <input type="hidden" name="answer" value={answer} />
      <input type="hidden" name="via" value={via} />
      <Submit className={answer === "APPROVED" ? "btn btn-sm btn-primary" : "btn btn-sm"}>{children}</Submit>
    </ActionForm>
  );
}

/** The estimate card: the latest link's state, the customer's replies, how to record an answer, and the send form. */
export async function EstimatePanel({ target, id, user }: { target: "ticket" | "job"; id: string; user: CurrentUser }) {
  const shopId = user.shopId;
  const key = target === "ticket" ? { ticketId: id } : { repairJobId: id };
  let waiting: boolean;
  let statusLabel: string;
  let customer: { id: string; name: string; phone: string | null } | null;
  let counterAnswer: { answer: string; at: Date | null } | null = null; // a ticket's answer by phone or text reply
  let answeredAt: Date | null = null;
  if (target === "ticket") {
    const t = await db.ticket.findFirst({
      where: { id, shopId },
      select: { status: true, jobType: true, viaAccountId: true, estimateAnswer: true, estimateAnsweredAt: true, customer: { select: { id: true, name: true, phone: true } } },
    });
    if (!t) return null;
    // A machine from a partner sewing shop, or a dealer's: they tell their own customer (design 10.1, direct tickets only).
    if (t.viaAccountId) return null;
    if (await db.repairJob.findFirst({ where: { shopId, ticketId: id, side: "repair" }, select: { id: true } })) return null;
    waiting = t.status === "WAITING_CUSTOMER_OK" && !t.estimateAnswer;
    statusLabel = (t.jobType === "SITE" ? SITE_STATUS_LABEL : STATUS_LABEL)[t.status];
    customer = t.customer;
    answeredAt = t.estimateAnsweredAt;
    if (t.estimateAnswer) counterAnswer = { answer: t.estimateAnswer, at: t.estimateAnsweredAt };
  } else {
    const j = await db.repairJob.findUnique({ where: { shopId_id: { shopId, id } }, select: { side: true, status: true, approval: true, customer: { select: { id: true, name: true, phone: true } } } });
    if (!j || j.side !== "retail") return null;
    waiting = j.status === "WAITING_CUSTOMER_OK" && !j.approval;
    statusLabel = JOB_STATUS_LABEL[j.status as keyof typeof JOB_STATUS_LABEL] ?? j.status;
    customer = j.customer;
  }
  const [link, sent] = await Promise.all([
    db.estimateLink.findFirst({ where: { shopId, ...key }, orderBy: { createdAt: "desc" } }),
    db.outMessage.findMany({ where: { shopId, kind: "estimate", ...key }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);
  if (!waiting && !link && !sent.length) return null;

  const tz = await shopTimeZone(shopId);
  const now = new Date().getTime();
  const noun = target === "ticket" ? "ticket" : "repair";

  // The latest link, in words.
  let linkLine: React.ReactNode = null;
  const linkOpen = !!link && !link.answer && !link.revokedAt && link.expiresAt.getTime() > now;
  if (link) {
    const channels = new Set(sent.filter((m) => m.refId === link.id && m.status !== "SKIPPED").map((m) => m.channel));
    if (link.answer) {
      linkLine = (
        <>
          <p className="font-semibold">
            {link.answer === "APPROVED" ? "Approved" : "Declined"} by link {link.answeredAt ? stamp(link.answeredAt, tz) : ""}
            {link.answerNote && <span className="font-normal"> (note: {link.answerNote})</span>}
          </p>
          <p className="muted">Status now: {statusLabel}</p>
        </>
      );
    } else if (link.revokedAt) linkLine = <p className="muted">Link stopped {stamp(link.revokedAt, tz)}.</p>;
    else if (link.expiresAt.getTime() <= now) linkLine = <p className="muted">Link expired {dayOf(link.expiresAt, tz)}.</p>;
    else
      linkLine = (
        <p>
          Sent {stamp(link.createdAt, tz)}
          {channels.size ? ` by ${by(channels)}` : ""} · expires {dayOf(link.expiresAt, tz)}
        </p>
      );
  }
  // Sent without a link ("they call or reply"); one send's channels are queued within a minute of each other.
  const lastSent = sent.find((m) => m.status !== "SKIPPED" && m.status !== "CANCELLED");
  const plainSent = !link && lastSent ? sent.filter((m) => m.status !== "SKIPPED" && m.status !== "CANCELLED" && Math.abs(m.createdAt.getTime() - lastSent.createdAt.getTime()) < 60_000) : [];
  const answeredByLink = !!link?.answer;
  if (counterAnswer && !answeredByLink) {
    linkLine = (
      <>
        <p className="font-semibold">
          {counterAnswer.answer === "APPROVED" ? "Approved" : "Declined"} by phone or text {counterAnswer.at ? stamp(counterAnswer.at, tz) : ""}
        </p>
        <p className="muted">Status now: {statusLabel}</p>
      </>
    );
  }

  // Replies since this round of estimates: the oldest send after the last answer, so one between a send and a re-send shows too.
  const round = sent.filter((m) => m.status !== "SKIPPED" && m.status !== "CANCELLED" && (!answeredAt || m.createdAt > answeredAt));
  const since = round.length ? round[round.length - 1].createdAt : (link?.createdAt ?? null);
  const replies = waiting && since && customer ? await repliesSince(shopId, customer.phone, since) : [];

  // The send form.
  const gate = await gateFor(shopId, "marketing");
  let form: React.ReactNode = null;
  if (waiting && gate !== "on") {
    form = (
      <p className="muted">
        Messages are off: call {customer?.name ?? "the customer"}
        {customer?.phone && ` at ${customer.phone}`}.
      </p>
    );
  } else if (waiting && customer) {
    let subject: EstimateSubject | null = null;
    let problem: string | null = null;
    try {
      subject = await estimateSubject(shopId, target, id);
    } catch (e) {
      if (!isUserError(e)) throw e;
      problem = e.message;
    }
    if (!subject) form = <p className="muted">{problem}</p>;
    else {
      const [ms, shop] = await Promise.all([messagingView(shopId), db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true } })]);
      const channels = await estimateChannels(shopId, subject.customerId, ms);
      const base = publicBaseUrl();
      const mask = base ? `${base}/e/•••••••` : null;
      const picks: { ch: Channel; label: string }[] = [
        { ch: "email", label: "Email" },
        { ch: "sms", label: "Text" },
      ];
      const preview = picks
        .filter((p) => channels[p.ch].ok)
        .map((p) => {
          const c = estimateContent(ms, shop, subject, null, mask, p.ch);
          return { ...p, subject: c.subject ?? null, body: finalize(p.ch, "estimate", c.body, { shopName: shop.name, shopPhone: shop.phone, postal: null, unsubscribeUrl: null, replyWord: true }) };
        });
      form = (
        <ActionForm action={sendEstimate.bind(null, target, id)} success="Queued. It goes out in a moment." className="space-y-3">
          <fieldset className="flex flex-wrap gap-x-5 gap-y-1">
            <legend className="label">Send it by</legend>
            {picks.map((p) => {
              const c = channels[p.ch];
              return (
                <label key={p.ch} className={`flex items-center gap-2 ${c.ok ? "" : "muted"}`}>
                  <input type="checkbox" name={p.ch === "sms" ? "sms" : "email"} defaultChecked={c.ok} disabled={!c.ok} />
                  <span>{c.ok ? p.label : `${p.label}: ${c.why}`}</span>
                </label>
              );
            })}
          </fieldset>
          <div className="field">
            <label htmlFor={`est-note-${id}`} className="label">
              Note for the customer (optional)
            </label>
            <input id={`est-note-${id}`} name="note" maxLength={500} className="input" />
          </div>
          {preview.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer">What goes out</summary>
              <div className="mt-2 space-y-2">
                {preview.map((p) => (
                  <div key={p.ch} className="rounded border border-line p-2">
                    <div className="label">{p.label}</div>
                    {p.subject && <div className="font-semibold">{p.subject}</div>}
                    <div className="whitespace-pre-wrap">{p.body}</div>
                  </div>
                ))}
              </div>
            </details>
          )}
          <Submit>{base ? "Send the estimate" : "Send the estimate (they call or reply)"}</Submit>
        </ActionForm>
      );
    }
  }

  const refreshing = waiting && (linkOpen || (!!lastSent && now - lastSent.createdAt.getTime() < 7 * DAY));
  return (
    <Section title="Customer's OK">
      {refreshing && <AutoRefresh seconds={20} />}
      <div className="space-y-3 text-sm">
        {linkLine}
        {linkOpen && link && (
          <ActionButton action={revokeEstimateLink.bind(null, link.id)} confirm="Tap again to stop it" success="Link stopped">
            Stop this link
          </ActionButton>
        )}
        {plainSent.length > 0 && lastSent && !answeredByLink && (
          <p>
            Estimate sent {stamp(lastSent.createdAt, tz)} by {by(new Set(plainSent.map((m) => m.channel)))}. {waiting ? "No answer yet." : ""}
          </p>
        )}
        {waiting && replies.length > 0 && (
          <div className="space-y-2">
            {replies.map((r) => (
              <div key={r.sid} className="rounded border border-line p-2">
                <div className="muted text-xs">They texted {stamp(r.receivedAt, tz)}:</div>
                <div className="whitespace-pre-wrap">{r.body}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <AnswerForm target={target} id={id} answer="APPROVED" via="text reply">
                    They approved
                  </AnswerForm>
                  <AnswerForm target={target} id={id} answer="DECLINED" via="text reply">
                    They declined
                  </AnswerForm>
                </div>
              </div>
            ))}
          </div>
        )}
        {waiting && (
          <div className="flex flex-wrap items-center gap-2">
            <span>They told us by phone:</span>
            <AnswerForm target={target} id={id} answer="APPROVED" via="phone">
              Approved
            </AnswerForm>
            <AnswerForm target={target} id={id} answer="DECLINED" via="phone">
              Declined
            </AnswerForm>
          </div>
        )}
        {!waiting && !link?.answer && !counterAnswer && <p className="muted">This {noun} isn&apos;t waiting for the customer&apos;s OK.</p>}
        {form}
      </div>
    </Section>
  );
}

export async function TicketEstimateSlot({ ticketId, user }: { ticketId: string; user: CurrentUser }) {
  return <EstimatePanel target="ticket" id={ticketId} user={user} />;
}
