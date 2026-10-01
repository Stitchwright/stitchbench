// Opt-outs and the consent record (scheduling-messaging-design.md 8.3). Recording an opt-out is always allowed, for
// any user: it's the law's record, not the module's. Removing one is an admin's, with a reason.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtPhone } from "@/lib/phone";
import { gateFor } from "@/lib/module-gate";
import { CHANNEL_LABEL, CONSENT_EVENT_LABEL, CONSENT_SOURCE_LABEL } from "@/lib/constants";
import { recordOptOut, removeOptOut } from "@/actions/consent";
import { ModuleOff } from "@/components/module-off";
import { MessagesTabs } from "@/components/messages-tabs";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";

const SCOPE_LABEL: Record<string, string> = { marketing: "Marketing only", all: "Everything" };
const EVENT_TONE: Record<string, string> = { marketing_yes: "ready", optin: "ready", marketing_no: "bad", optout: "bad", help: "wait", notify_pref: "neutral" };

const addressText = (channel: string, address: string | null) => (address ? (channel === "sms" ? fmtPhone(address) : address) : "");

export default async function OptOutsPage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "marketing");
  const admin = user.role !== "TECH";
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="marketing" admin={admin} />;
  const tz = await shopTimeZone(shopId);
  const [sups, events, users, unhandled] = await Promise.all([
    db.suppression.findMany({ where: { shopId }, orderBy: { at: "desc" } }),
    db.consentEvent.findMany({ where: { shopId }, include: { customer: { select: { id: true, name: true } } }, orderBy: { at: "desc" }, take: 300 }),
    db.user.findMany({ where: { shopId }, select: { id: true, name: true } }),
    db.inboundText.count({ where: { shopId, keyword: null, handledAt: null } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Opt-outs"
        sub="Who asked for no messages, and every consent record."
        actions={
          admin ? (
            // A file download, not a page: a plain link.
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <a href="/api/export/consent" className="btn btn-sm">
              Download CSV
            </a>
          ) : undefined
        }
      />
      <MessagesTabs active="optouts" unhandled={unhandled} />
      {gate !== "on" && <ModuleOff shopId={shopId} module="marketing" admin={admin} what="Your opt-out and consent records" />}

      <Section title="Record an opt-out">
        <p className="muted mb-3 text-sm">
          They told you by phone, letter, an email reply or in person that they don&apos;t want messages. A text opt-out stops every text; an email one can stop marketing only.
          Paste an &quot;unsubscribe ...&quot; subject or link to pick the exact address an email went to.
        </p>
        <ActionForm action={recordOptOut} success="Opt-out recorded" reset className="grid-form">
          <input type="hidden" name="source" value="staff" />
          <div className="field">
            <label htmlFor="oo-channel" className="label">
              Channel
            </label>
            <select id="oo-channel" name="channel" className="select" defaultValue="email">
              <option value="email">Email</option>
              <option value="sms">Text</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="oo-address" className="label">
              Email address or mobile number
            </label>
            <input id="oo-address" name="address" className="input" />
          </div>
          <div className="field">
            <label htmlFor="oo-scope" className="label">
              What to stop (email)
            </label>
            <select id="oo-scope" name="scope" className="select" defaultValue="marketing">
              <option value="marketing">Marketing email only</option>
              <option value="all">Every email, notices too</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="oo-code" className="label">
              Unsubscribe subject, link or code (optional)
            </label>
            <input id="oo-code" name="code" className="input mono" placeholder="unsubscribe aBcD..." />
          </div>
          <div className="field sm:col-span-2">
            <label htmlFor="oo-detail" className="label">
              How they told you (for the record)
            </label>
            <input id="oo-detail" name="detail" className="input" placeholder="Called on Oct 3 and asked for no more emails" />
          </div>
          <div className="sm:col-span-2">
            <Submit>Record the opt-out</Submit>
          </div>
        </ActionForm>
      </Section>

      <Section title="Opted out">
        {sups.length === 0 ? (
          <Empty>Nobody has opted out.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Channel</th>
                  <th>Stops</th>
                  <th>How</th>
                  <th>When</th>
                  {admin && gate === "on" && <th></th>}
                </tr>
              </thead>
              <tbody>
                {sups.map((s) => (
                  <tr key={`${s.channel}:${s.address}`}>
                    <td className="mono">{addressText(s.channel, s.address)}</td>
                    <td>{CHANNEL_LABEL[s.channel] ?? s.channel}</td>
                    <td>{SCOPE_LABEL[s.scope] ?? s.scope}</td>
                    <td>{CONSENT_SOURCE_LABEL[s.source] ?? s.source}</td>
                    <td className="num whitespace-nowrap">{fmtDateTime(s.at, tz)}</td>
                    {admin && gate === "on" && (
                      <td>
                        <details className="text-xs">
                          <summary className="link cursor-pointer">Remove</summary>
                          <ActionForm action={removeOptOut} success="Removed" className="mt-2 flex flex-wrap items-end gap-2">
                            <input type="hidden" name="channel" value={s.channel} />
                            <input type="hidden" name="address" value={s.address} />
                            <div className="field">
                              <label htmlFor={`rm-${s.channel}-${s.address}`} className="label">
                                How they asked to get messages again
                              </label>
                              <input id={`rm-${s.channel}-${s.address}`} name="detail" required className="input" placeholder={s.channel === "sms" ? "Texted START / signed the form again" : "Called and asked"} />
                            </div>
                            <Submit className="btn btn-sm">Remove</Submit>
                          </ActionForm>
                        </details>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Consent record"
        actions={
          admin ? (
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <a href="/api/export/consent" className="link text-sm">
              Download CSV
            </a>
          ) : undefined
        }
      >
        {events.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Customer</th>
                  <th>What</th>
                  <th>Address</th>
                  <th>How</th>
                  <th>Detail</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="num whitespace-nowrap">{fmtDateTime(e.at, tz)}</td>
                    <td>
                      {e.customer ? (
                        <Link href={`/customers/${e.customer.id}`} className="link">
                          {e.customer.name}
                        </Link>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td>
                      <span className={`pill tone-${EVENT_TONE[e.event] ?? "neutral"}`}>{CONSENT_EVENT_LABEL[e.event] ?? e.event}</span>
                    </td>
                    <td className="mono">{addressText(e.channel, e.address)}</td>
                    <td>{CONSENT_SOURCE_LABEL[e.source] ?? e.source}</td>
                    <td className="max-w-md text-xs whitespace-pre-wrap">{e.detail}</td>
                    <td className="text-xs">{e.byUserId ? (userName.get(e.byUserId) ?? "Staff") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted mt-3 text-xs">The latest 300. The CSV has them all.</p>
      </Section>
    </div>
  );
}
