// One campaign (scheduling-messaging-design.md 11.3): a draft's form, the check and the sample, "Send me a test" and the
// two-tap "Send now"; after that, its progress and recipients. Everyone views; admins act.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { fmtDateTime, money } from "@/lib/format";
import { fmtPhone } from "@/lib/phone";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";
import { CAMPAIGN_STATUS_LABEL, CHANNEL_LABEL, MESSAGE_STATUS_LABEL, MESSAGE_STATUS_TONE, SKIP_REASON_LABEL } from "@/lib/constants";
import { audienceOf, describeAudience, previewCampaign, type CampaignPreview } from "@/lib/messaging/audiences";
import { messagingView } from "@/lib/messaging/settings";
import { cancelCampaign, copyCampaign, deleteCampaign, queueCampaign, saveCampaign, sendCampaignTest } from "@/actions/campaigns";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CampaignForm } from "@/components/campaign-form";
import { MessagesTabs } from "@/components/messages-tabs";
import { ModuleOff } from "@/components/module-off";
import { TwoTapButton } from "@/components/two-tap-button";
import { KV, PageHeader, Section } from "@/components/ui";

const CAMPAIGN_STATUS_TONE: Record<string, string> = { DRAFT: "neutral", QUEUING: "wait", SENDING: "wait", SENT: "ok", CANCELLED: "neutral" };

/** Why people are left out, in a few words for the check line. */
const WHY: Partial<Record<keyof CampaignPreview["skipped"], string>> = {
  unsubscribed: "unsubscribed",
  no_text_consent: "haven't agreed to texts",
  not_asked: "weren't asked about texts",
  no_address: "have no email or mobile number on file",
  opted_out: "opted out",
  prefers_other: "prefer the other way",
  no_messages: "asked for no messages",
  trade: "are trade accounts",
  not_us: "aren't US numbers",
  too_often: "had 4 marketing texts this month",
  unread_reply: "texted you back (read it first)",
  channel_off: "can't be reached this way",
  same_address: "share an address with someone already on the list",
};

function skippedWords(skipped: CampaignPreview["skipped"]): string {
  const parts = Object.entries(skipped)
    .filter(([, n]) => n && n > 0)
    .map(([k, n]) => `${n} ${WHY[k as keyof typeof WHY] ?? (SKIP_REASON_LABEL[k as keyof typeof SKIP_REASON_LABEL] ?? k).toLowerCase()}`);
  return parts.join(", ");
}

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "marketing");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="marketing" admin={user.role !== "TECH"} />;
  const c = await db.campaign.findFirst({ where: { id, shopId } });
  if (!c) notFound();
  const admin = user.role !== "TECH" && gate === "on";
  const now = new Date();
  const [tz, ms, shop, classes] = await Promise.all([
    shopTimeZone(shopId),
    messagingView(shopId),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, sellsRetail: true, doesRepair: true } }),
    db.shopClass.findMany({ where: { shopId, status: { in: ["OPEN", "CLOSED"] } }, select: { id: true, title: true }, orderBy: { firstAt: "desc" }, take: 100 }),
  ]);
  const audience = audienceOf(c.audience);
  const className = audience.kind === "class" ? classes.find((k) => k.id === audience.classId)?.title : undefined;
  const who = describeAudience(audience, { className });
  const channel = c.channel === "sms" ? "sms" : "email";

  const header = (
    <>
      <PageHeader
        title={c.name}
        back={{ href: "/campaigns", label: "Campaigns" }}
        sub={
          <>
            {CHANNEL_LABEL[c.channel] ?? c.channel} · {who} · <span className={`pill tone-${CAMPAIGN_STATUS_TONE[c.status] ?? "neutral"}`}>{CAMPAIGN_STATUS_LABEL[c.status] ?? c.status}</span>
          </>
        }
      />
      <MessagesTabs active="campaigns" />
      {gate === "readonly" && <ModuleOff shopId={shopId} module="marketing" admin={user.role !== "TECH"} />}
    </>
  );

  if (c.status === "DRAFT") {
    const p = await previewCampaign(shopId, c, now);
    const cap = channel === "email" ? ms.emailDailyCap : ms.smsDailyCap;
    const notNow = channel === "sms" && p.startsAt.getTime() > now.getTime() + 60_000;
    const costCents = channel === "sms" && p.parts ? (p.allowed * p.parts * ms.smsPartMills) / 10 : null;
    return (
      <div className="space-y-4">
        {header}
        <p className="muted text-sm">Only send this to people who expect to hear from you. Everyone can unsubscribe; that&apos;s the law.</p>
        {admin && (
          <Section title="The message">
            <CampaignForm action={saveCampaign.bind(null, c.id)} draft={{ name: c.name, channel, subject: c.subject, body: c.body, audience }} classes={classes} shop={shop} partMills={ms.smsPartMills} canBeChanged={false} />
          </Section>
        )}
        <Section title="The check">
          <div className="space-y-3 text-sm">
            <p className="font-semibold">
              {p.allowed} {p.allowed === 1 ? "person" : "people"} will get it.
              {Object.values(p.skipped).some((n) => n) ? ` Not sending to: ${skippedWords(p.skipped)}.` : ""}
            </p>
            {channel === "sms" && p.parts != null && (
              <p>
                {p.allowed} text{p.allowed === 1 ? "" : "s"} x {p.parts} part{p.parts === 1 ? "" : "s"}
                {costCents != null ? ` ≈ ${money(Math.round(costCents))}` : ""}
              </p>
            )}
            {p.days > 1 && (
              <p>
                Goes out over {p.days} days ({cap} a day, your limit).
              </p>
            )}
            {notNow && <p>Texts can&apos;t go out now. They start {fmtWhen(p.startsAt, tz)}.</p>}
            <div>
              <div className="label">The sample, as it will look</div>
              <div className="rounded border border-line p-3">
                {p.sample.subject && <div className="font-semibold">{p.sample.subject}</div>}
                <div className="whitespace-pre-wrap">{p.sample.body}</div>
              </div>
            </div>
            {admin && (
              <div className="flex flex-wrap items-end gap-3">
                <ActionForm action={sendCampaignTest.bind(null, c.id)} className="flex flex-wrap items-end gap-2">
                  <div className="field">
                    <label htmlFor="cp-test-to" className="label">
                      {channel === "email" ? "Send me a test (your own address)" : "Send me a test (a test number)"}
                    </label>
                    <input id="cp-test-to" name="to" className="input" defaultValue={channel === "email" ? user.email : (ms.testPhones[0] ?? "")} />
                  </div>
                  <Submit className="btn">Send me a test</Submit>
                </ActionForm>
                {p.allowed > 0 && (
                  <TwoTapButton
                    action={queueCampaign.bind(null, c.id)}
                    fields={{ confirm: String(p.allowed) }}
                    label="Send now"
                    armedLabel={`Tap again to send to ${p.allowed} ${p.allowed === 1 ? "person" : "people"}`}
                    success="Queued. It goes out in a moment."
                  />
                )}
                <ActionButton action={deleteCampaign.bind(null, c.id)} confirm="Tap again to delete" className="btn btn-sm">
                  Delete draft
                </ActionButton>
              </div>
            )}
          </div>
        </Section>
      </div>
    );
  }

  // Queued, sending, sent or cancelled: progress and the recipients.
  const [byStatus, rows] = await Promise.all([
    db.outMessage.groupBy({ by: ["status"], where: { shopId, campaignId: c.id }, _count: { _all: true } }),
    db.outMessage.findMany({ where: { shopId, campaignId: c.id }, orderBy: { createdAt: "desc" }, take: 500, select: { id: true, customerId: true, address: true, status: true, error: true, sentAt: true, deliveryStatus: true } }),
  ]);
  const count = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  const customerIds = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))];
  const names = new Map((customerIds.length ? await db.customer.findMany({ where: { shopId, id: { in: customerIds } }, select: { id: true, name: true } }) : []).map((k) => [k.id, k.name]));
  const members = Array.isArray(c.members) ? (c.members as unknown[]).length : 0;
  const skipped = c.skipped && typeof c.skipped === "object" ? (c.skipped as Record<string, number>) : {};
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + (b || 0), 0);
  const live = c.status === "QUEUING" || c.status === "SENDING";

  return (
    <div className="space-y-4">
      {header}
      <Section title="Progress">
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <KV k="People in the group" v={members} />
          <KV k="Getting ready" v={c.status === "QUEUING" ? `${c.built} of ${members} looked at` : "done"} />
          <KV k="Messages" v={c.recipients} />
          <KV k="Waiting to go out" v={count("QUEUED") + count("SENDING")} />
          <KV k="Sent" v={count("SENT")} />
          <KV k="Not sent" v={count("FAILED") + count("SKIPPED") + count("CANCELLED") + count("EXPIRED")} />
          <KV k="Skipped before sending" v={skippedTotal ? skippedWords(skipped as CampaignPreview["skipped"]) : "none"} />
          <KV k="Started" v={c.queuedAt ? fmtDateTime(c.queuedAt, tz) : ""} />
          {c.finishedAt && <KV k={c.status === "CANCELLED" ? "Cancelled" : "Finished"} v={fmtDateTime(c.finishedAt, tz)} />}
        </div>
        {admin && (
          <div className="mt-3 flex flex-wrap gap-2">
            {live && (
              <ActionButton action={cancelCampaign.bind(null, c.id)} confirm="Tap again to cancel" success="Cancelled" className="btn btn-sm">
                Cancel what hasn&apos;t gone out
              </ActionButton>
            )}
            <ActionButton action={copyCampaign.bind(null, c.id)} className="btn btn-sm">
              Copy
            </ActionButton>
          </div>
        )}
      </Section>
      <Section title="The message">
        <div className="text-sm">
          {c.subject && <div className="font-semibold">{c.subject}</div>}
          <div className="whitespace-pre-wrap">{c.body}</div>
        </div>
      </Section>
      <Section title={`Recipients${rows.length === 500 ? " (the latest 500)" : ""}`}>
        {rows.length === 0 ? (
          <p className="muted text-sm">Nothing queued yet.</p>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>To</th>
                  <th>Status</th>
                  <th>When</th>
                  <th>Why not</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.customerId ? (
                        <Link href={`/customers/${r.customerId}`} className="link">
                          {names.get(r.customerId) ?? "Customer"}
                        </Link>
                      ) : (
                        ""
                      )}
                    </td>
                    <td className="mono">{c.channel === "sms" ? fmtPhone(r.address) : r.address}</td>
                    <td>
                      <span className={`pill tone-${MESSAGE_STATUS_TONE[r.status] ?? "neutral"}`}>{MESSAGE_STATUS_LABEL[r.status] ?? r.status}</span>
                      {r.deliveryStatus === "undelivered" || r.deliveryStatus === "failed" ? <span className="muted text-xs"> not delivered</span> : null}
                    </td>
                    <td className="num whitespace-nowrap">{r.sentAt ? fmtDateTime(r.sentAt, tz) : ""}</td>
                    <td className="text-xs">{r.status === "SENT" ? "" : (SKIP_REASON_LABEL[r.error as keyof typeof SKIP_REASON_LABEL] ?? r.error ?? "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
