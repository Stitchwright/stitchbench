// The outbox: every email and text, waiting, sent or not sent and why (scheduling-messaging-design.md 8.3).
import Link from "next/link";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { firstValues } from "@/lib/search-params";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtPhone } from "@/lib/phone";
import { addDays, dayStart, parseYmd } from "@/lib/zoned";
import { gateFor } from "@/lib/module-gate";
import { messagingView } from "@/lib/messaging/settings";
import { MESSAGE_KINDS } from "@/lib/messaging/types";
import { CHANNEL_LABEL, MESSAGE_KIND_LABEL, MESSAGE_STATUS_LABEL, MESSAGE_STATUS_TONE, SKIP_REASON_LABEL } from "@/lib/constants";
import { cancelHeld, cancelMessage, releaseHeld, releaseMarketingHold, releaseTextHold, retryMessage, runMessagesNow } from "@/actions/messaging";
import { ModuleOff } from "@/components/module-off";
import { MessagesTabs } from "@/components/messages-tabs";
import { PageHeader, Empty, KV } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";

type SP = { status?: string; kind?: string; channel?: string; q?: string; date?: string; customer?: string };

const STALE_MS = 48 * 3_600_000;
const STATUSES = Object.keys(MESSAGE_STATUS_LABEL);

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="card card-pad text-sm" role="status">
      {children}
    </div>
  );
}

/** The address as people read it; "by hand" rows (letters, calls) say so. */
const toText = (channel: string, address: string) => (channel === "sms" ? fmtPhone(address) : address);

export default async function MessagesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "marketing");
  const admin = user.role !== "TECH";
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="marketing" admin={admin} />;
  const on = gate === "on";
  const sp = firstValues(await searchParams);
  const [tz, ms] = await Promise.all([shopTimeZone(shopId), messagingView(shopId)]);

  // Filters (GET): each narrows the latest-200 list.
  const status = sp.status && STATUSES.includes(sp.status) ? sp.status : "";
  const kind = sp.kind && (MESSAGE_KINDS as string[]).includes(sp.kind) ? sp.kind : "";
  const channel = sp.channel === "email" || sp.channel === "sms" ? sp.channel : "";
  const q = sp.q?.trim() ?? "";
  const date = parseYmd(sp.date) ?? "";
  const customerId = sp.customer?.trim() ?? "";
  const where: Prisma.OutMessageWhereInput = {
    shopId,
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(channel ? { channel } : {}),
    ...(customerId ? { customerId } : {}),
    ...(q ? { OR: [{ address: { contains: q, mode: "insensitive" } }, { customer: { name: { contains: q, mode: "insensitive" } } }] } : {}),
    ...(date ? { createdAt: { gte: dayStart(date, tz), lt: dayStart(addDays(date, 1), tz) } } : {}),
  };

  const now = new Date();
  const [rows, waiting, stale, unhandled, marketingMailRecently, users] = await Promise.all([
    db.outMessage.findMany({ where, include: { customer: { select: { id: true, name: true } }, campaign: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
    on ? Promise.resolve(0) : db.outMessage.count({ where: { shopId, status: "QUEUED" } }),
    db.outMessage.count({ where: { shopId, purpose: "marketing", status: "QUEUED", sendAfter: { lt: new Date(now.getTime() - STALE_MS) } } }),
    db.inboundText.count({ where: { shopId, keyword: null, handledAt: null } }),
    ms.replyTo && !ms.publicUrl ? db.outMessage.count({ where: { shopId, purpose: "marketing", channel: "email", status: "SENT", sentAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } } }) : Promise.resolve(0),
    db.user.findMany({ where: { shopId }, select: { id: true, name: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const customerName = customerId ? rows.find((r) => r.customer?.id === customerId)?.customer?.name : null;

  return (
    <div className="space-y-4">
      <PageHeader title="Messages" sub="Every email and text: waiting, sent, or not sent and why." />
      <MessagesTabs active="outbox" unhandled={unhandled} />
      {!on && <ModuleOff shopId={shopId} module="marketing" admin={admin} what="Your messages and opt-out records" />}

      {!on && waiting > 0 && (
        <Banner>
          Marketing is off: {waiting} message{waiting === 1 ? " is" : "s are"} waiting and won&apos;t go out.
        </Banner>
      )}
      {ms.emailPausedAt && (
        <Banner>
          <strong>Email is paused</strong> since {fmtDateTime(ms.emailPausedAt, tz)}
          {ms.emailError ? `: ${ms.emailError}` : "."} {ms.emailPausedUntil ? `It resumes by itself at ${fmtDateTime(ms.emailPausedUntil, tz)}.` : "Check Settings → Messages."}
        </Banner>
      )}
      {ms.smsPausedAt && (
        <Banner>
          <strong>Texts are paused</strong> since {fmtDateTime(ms.smsPausedAt, tz)}
          {ms.smsError ? `: ${ms.smsError}` : "."} {ms.smsPausedUntil ? `They resume by themselves at ${fmtDateTime(ms.smsPausedUntil, tz)}.` : "Check Settings → Messages."}
        </Banner>
      )}
      {stale > 0 && (
        <Banner>
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {stale} marketing message{stale === 1 ? "" : "s"} waited more than 2 days.
            </span>
            {admin && on && (
              <ActionButton action={releaseHeld} success="They'll go out shortly">
                Send them
              </ActionButton>
            )}
            {admin && (
              <ActionButton action={cancelHeld} confirm="Cancel them?" success="Cancelled" className="btn btn-sm btn-danger">
                Cancel them
              </ActionButton>
            )}
          </div>
        </Banner>
      )}
      {ms.marketingHoldAt && (
        <Banner>
          <p>
            <strong>Marketing messages are on hold</strong> since the restore on {fmtDate(ms.marketingHoldAt, tz)}. Before they go out, check Opt-outs (and your mailbox) for anything
            recorded since the backup was made.
          </p>
          {admin && (
            <ActionForm action={releaseMarketingHold} success="Resumed" className="mt-2 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="checked" className="check" /> I checked the opt-outs recorded since the backup
              </label>
              <Submit className="btn btn-sm btn-primary">Resume</Submit>
            </ActionForm>
          )}
        </Banner>
      )}
      {ms.textHoldAt && (
        <Banner>
          <p>
            <strong>Marketing texts are held</strong> since {fmtDateTime(ms.textHoldAt, tz)}
            {ms.textHoldWhy ? `: ${ms.textHoldWhy}` : "."} Replies (STOP) may not all have been read: look at the latest replies in your Twilio console first.
          </p>
          {admin && (
            <ActionForm action={releaseTextHold} success="Released" className="mt-2 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="checked" className="check" /> I read the latest replies in Twilio
              </label>
              <Submit className="btn btn-sm btn-primary">Release</Submit>
            </ActionForm>
          )}
        </Banner>
      )}
      {marketingMailRecently > 0 && (
        <Banner>
          Check {ms.replyTo} for UNSUBSCRIBE replies every week and record them under{" "}
          <Link href="/messages/opt-outs" className="link">
            Opt-outs
          </Link>
          .
        </Banner>
      )}

      <form className="card card-pad grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {customerId && <input type="hidden" name="customer" value={customerId} />}
        <div className="field">
          <label htmlFor="f-status" className="label">
            Status
          </label>
          <select id="f-status" name="status" defaultValue={status} className="select">
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {MESSAGE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-kind" className="label">
            Kind
          </label>
          <select id="f-kind" name="kind" defaultValue={kind} className="select">
            <option value="">Any</option>
            {MESSAGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {MESSAGE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-channel" className="label">
            Channel
          </label>
          <select id="f-channel" name="channel" defaultValue={channel} className="select">
            <option value="">Any</option>
            <option value="email">Email</option>
            <option value="sms">Text</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-q" className="label">
            Address or name
          </label>
          <input id="f-q" name="q" defaultValue={q} className="input" />
        </div>
        <div className="field">
          <label htmlFor="f-date" className="label">
            Day
          </label>
          <input id="f-date" name="date" type="date" defaultValue={date} className="input" />
        </div>
        <div className="flex items-end gap-2">
          <button className="btn">Filter</button>
          {(status || kind || channel || q || date || customerId) && (
            <Link href="/messages" className="link text-xs">
              clear
            </Link>
          )}
        </div>
        {customerId && (
          <p className="muted sm:col-span-3 lg:col-span-6">
            Showing messages to {customerName ?? "one customer"}.{" "}
            <Link href={`/customers/${customerId}`} className="link">
              Their page
            </Link>
          </p>
        )}
      </form>

      <div className="card">
        {rows.length === 0 ? (
          <div className="card-pad">
            <Empty>No messages{status || kind || channel || q || date || customerId ? " match" : " yet"}.</Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>To</th>
                  <th>Kind</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Why / error</th>
                  <th>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const why = m.status === "SKIPPED" ? (SKIP_REASON_LABEL[m.error as keyof typeof SKIP_REASON_LABEL] ?? m.error) : m.error;
                  const delivery = m.deliveryStatus === "delivered" ? "Delivered" : m.deliveryStatus === "undelivered" || m.deliveryStatus === "failed" ? "Not delivered: phone off or unreachable" : "";
                  const about = m.ticketId
                    ? { href: `/tickets/${m.ticketId}`, label: "Ticket" }
                    : m.repairJobId
                      ? { href: `/repairs/${m.repairJobId}`, label: "Repair" }
                      : m.campaign
                        ? { href: `/campaigns/${m.campaign.id}`, label: `Campaign: ${m.campaign.name}` }
                        : m.refType === "class" && m.refId
                          ? { href: `/classes/${m.refId}`, label: "Class" }
                          : m.refType === "appointment" && m.refId
                            ? { href: `/calendar/appointments/${m.refId}`, label: "Appointment" }
                            : null;
                  return (
                    <tr key={m.id}>
                      <td className="num whitespace-nowrap">{fmtDateTime(m.sentAt ?? m.createdAt, tz)}</td>
                      <td>
                        {m.customer ? (
                          <Link href={`/customers/${m.customer.id}`} className="link">
                            {m.customer.name}
                          </Link>
                        ) : (
                          toText(m.channel, m.address)
                        )}
                        <details className="mt-1 text-xs">
                          <summary className="link cursor-pointer">Details</summary>
                          <div className="mt-2 grid max-w-xl gap-3 sm:grid-cols-2">
                            <KV k="To" v={toText(m.channel, m.address)} />
                            {m.channel === "email" && <KV k="Subject" v={m.subject} />}
                            {m.channel === "email" && <KV k="Headers" v={[m.optOutToken ? "List-Unsubscribe" : null, ms.replyTo ? `Reply-To: ${ms.replyTo}` : null].filter(Boolean).join(" · ")} />}
                            <KV k="Queued" v={fmtDateTime(m.createdAt, tz)} />
                            <KV k="Send after" v={fmtDateTime(m.sendAfter, tz)} />
                            <KV k="Tries" v={String(m.tries)} />
                            <KV k="Next try" v={fmtDateTime(m.nextTryAt, tz)} />
                            <KV k="Sent" v={fmtDateTime(m.sentAt, tz)} />
                            <KV k="Provider id" v={m.providerId ? <span className="mono">{m.providerId}</span> : null} />
                            <KV k="By" v={m.byUserId ? (userName.get(m.byUserId) ?? "Staff") : "Automatic"} />
                            {m.cancelledById && <KV k="Cancelled by" v={userName.get(m.cancelledById) ?? "Staff"} />}
                            <KV
                              k="About"
                              v={
                                about ? (
                                  <Link href={about.href} className="link">
                                    {about.label}
                                  </Link>
                                ) : m.refType ? (
                                  `${m.refType} ${m.refId ?? ""}`
                                ) : null
                              }
                            />
                            {m.deliveryError && <KV k="Delivery error" v={m.deliveryError} />}
                            <div className="sm:col-span-2">
                              <div className="label">Message as stored</div>
                              <pre className="mt-1 whitespace-pre-wrap font-sans text-xs">{m.body}</pre>
                            </div>
                            <div className="flex flex-wrap gap-2 sm:col-span-2">
                              {m.status === "QUEUED" && (
                                <ActionButton action={cancelMessage.bind(null, m.id)} confirm="Stop it?" success="Stopped">
                                  Cancel
                                </ActionButton>
                              )}
                              {admin && on && m.status === "FAILED" && (
                                <ActionForm action={retryMessage.bind(null, m.id)} success="Queued again" className="flex flex-wrap items-center gap-2">
                                  {/may have gone out/i.test(m.error ?? "") && (
                                    <label className="flex items-center gap-1">
                                      <input type="checkbox" name="confirm" className="check" /> Send it again even though it may have gone out
                                    </label>
                                  )}
                                  <Submit className="btn btn-sm">Retry</Submit>
                                </ActionForm>
                              )}
                            </div>
                          </div>
                        </details>
                      </td>
                      <td>{MESSAGE_KIND_LABEL[m.kind] ?? m.kind}</td>
                      <td>{CHANNEL_LABEL[m.channel] ?? m.channel}</td>
                      <td>
                        <span className={`pill tone-${MESSAGE_STATUS_TONE[m.status] ?? "neutral"}`}>{MESSAGE_STATUS_LABEL[m.status] ?? m.status}</span>
                      </td>
                      <td className="max-w-xs text-xs">{why}</td>
                      <td className="text-xs">{delivery}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <details className="card">
        <summary className="cursor-pointer px-4 py-3 font-semibold">Troubleshooting</summary>
        <div className="card-pad space-y-3 border-t border-line text-sm">
          <ul className="space-y-1">
            <li>
              Email: {ms.emailReady ? "ready" : ms.emailOn ? "switched on but not ready" : "off"}
              {ms.emailOkAt ? ` · last worked ${fmtDateTime(ms.emailOkAt, tz)}` : ""}
              {ms.emailError ? ` · last error: ${ms.emailError}` : ""}
            </li>
            <li>
              Texts: {ms.smsReady ? "ready" : ms.smsOn ? "switched on but not ready" : "off"}
              {ms.smsOkAt ? ` · last worked ${fmtDateTime(ms.smsOkAt, tz)}` : ""}
              {ms.smsError ? ` · last error: ${ms.smsError}` : ""}
              {ms.inboundAt ? ` · replies read up to ${fmtDateTime(ms.inboundAt, tz)}` : ""}
            </li>
          </ul>
          <p className="muted">Messages go out by themselves every few minutes. If one seems stuck, send now: waiting messages are sent, replies read and delivery results fetched.</p>
          {admin && on ? (
            <ActionButton action={runMessagesNow} success="Done: messages were sent and replies read" className="btn btn-sm btn-primary">
              Send now
            </ActionButton>
          ) : (
            <p className="muted">{admin ? "Sending needs Marketing to be on." : "An owner or admin can press Send now."}</p>
          )}
          {admin && (
            <p>
              <Link href="/settings/messages" className="link">
                Email and text settings
              </Link>
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
