// Settings -> Assistant (ai-assistant-scope.md 2.1, 2.3, 2.4): the month's calls, a switch per feature and the first-names
// consent switch (off), the shop's voice sample, what this company sent (each call's request and answer, "What was sent"),
// and the export. Everyone with the module sees the status and log; only admins change settings, and only while the
// module is on. The log stays readable after the module ends. No call is ever made from here.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { getModules } from "@/lib/modules";
import { shopTimeZone } from "@/lib/shop-zone";
import { monthPeriod } from "@/lib/time-zone";
import { assistantAvailable } from "@/lib/assistant/client";
import { assistantSettings } from "@/lib/assistant/context";
import { FEATURES, FREE_PLATE_READS, GROUP_LABEL, type FeatureId } from "@/lib/assistant/features";
import { PageHeader, Section } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { HubLegalLinks } from "@/components/hub-legal-links";
import { ModuleOff } from "@/components/module-off";
import { saveAssistantSettings } from "@/actions/assistant";

type Request = { system?: string; messages?: { role: string; content: string }[]; image?: { bytes: number; sha256: string } };

export default async function AssistantSettingsPage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const admin = user.role !== "TECH";
  const gate = await gateFor(shopId, "assistant");
  if (gate === "hidden") {
    return (
      <div className="max-w-3xl space-y-4">
        <PageHeader title="Assistant" back={{ href: "/settings", label: "Settings" }} />
        <ModuleOff shopId={shopId} module="assistant" what="The Assistant's log" admin={admin} />
      </div>
    );
  }
  const [tz, shop, settings, modules, avail] = await Promise.all([
    shopTimeZone(shopId),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { assistantMonth: true, assistantCalls: true, assistantLimit: true } }),
    assistantSettings(shopId),
    getModules(shopId),
    assistantAvailable(shopId),
  ]);
  const month = monthPeriod(null, tz);
  const calls = await db.assistantCall.findMany({ where: { shopId, createdAt: { gte: month.from } }, orderBy: { createdAt: "desc" }, take: 60 });
  // The hub's count is the authority; this is what it last said, for a month that is still this one.
  const thisMonth = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  const used = shop.assistantMonth === thisMonth ? shop.assistantCalls : calls.filter((c) => !c.error).length;
  const limit = shop.assistantMonth === thisMonth ? shop.assistantLimit : 300;
  const on = gate === "on";
  const canEdit = admin && on;
  const state = modules.states.assistant;
  const cost = calls.reduce((s, c) => s + c.costMillicents, 0);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Assistant" sub="Drafts, likely causes and plate reading, on request. It never changes a record and never runs by itself." back={{ href: "/settings", label: "Settings" }} />

      <Section title="This month">
        <div className="space-y-1 text-sm">
          <p>
            <strong>{used}</strong> of {limit} Assistant calls used{shop.assistantMonth === thisMonth ? "" : " (counted here; the hub's count shows after the next call)"}. The count starts again when the month turns in {tz}. Plate reads without the
            module: {FREE_PLATE_READS} a month.
          </p>
          {!on && <p className="muted">The Assistant is {state.status === "lapsed" ? "ended" : "off"} for this company, so every Ask button is hidden. The log below stays here to read and export.</p>}
          {on && !avail.ok && <p className="muted">{avail.message}</p>}
          <p className="muted">Everything goes through StitchHub to the model (Anthropic). Nothing is sent until a person presses a button, and the exact text of each request is kept below.</p>
          <HubLegalLinks />
        </div>
      </Section>

      <Section title="What it may do">
        {canEdit ? (
          <ActionForm action={saveAssistantSettings} success="Saved" className="space-y-3">
            {(["draft", "causes", "plate", "manuals", "parts", "fabric", "stock"] as const).map((g) => (
              <label key={g} className="flex items-start gap-2 text-sm">
                <input type="checkbox" name={`${g}On`} defaultChecked={settings[`${g}On` as "draftOn"]} className="check mt-1" />
                <span>
                  <strong>{GROUP_LABEL[g].label}.</strong> {GROUP_LABEL[g].blurb}
                </span>
              </label>
            ))}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="offerFirstNames" defaultChecked={settings.offerFirstNames} className="check mt-1" />
              <span>
                <strong>Offer customers&apos; first names to the Assistant for drafts.</strong> Off: drafts carry <code>{"{first_name}"}</code> and this program fills the name in. Nothing else about a customer is ever sent, and
                names, phone numbers and emails in the notes are blanked before anything leaves.
              </span>
            </label>
            <div className="field">
              <label htmlFor="voice" className="label">
                How you write (three sample sentences from your own invoices)
              </label>
              <textarea id="voice" name="voice" rows={4} maxLength={900} defaultValue={settings.voice ?? ""} className="textarea" placeholder="We cleaned and oiled the machine and checked the timing. The bobbin case was cracked, so we replaced it." />
              <p className="muted mt-1 text-xs">Sent with every draft so it reads like your shop.</p>
            </div>
            <Submit>Save</Submit>
          </ActionForm>
        ) : (
          <ul className="space-y-1 text-sm">
            {(["draft", "causes", "plate", "manuals", "parts", "fabric", "stock"] as const).map((g) => (
              <li key={g}>
                {GROUP_LABEL[g].label}: {settings[`${g}On` as "draftOn"] ? "on" : "off"}
              </li>
            ))}
            <li>Customers&apos; first names offered: {settings.offerFirstNames ? "yes" : "no"}</li>
            {settings.voice && <li className="whitespace-pre-wrap">Your voice sample: {settings.voice}</li>}
            {admin ? null : <li className="muted">Only an owner or admin can change these.</li>}
          </ul>
        )}
      </Section>

      <Section title="What was sent this month">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
          <span className="muted">
            {calls.length} call{calls.length === 1 ? "" : "s"}, about ${(cost / 100000).toFixed(2)} to the owner of StitchHub
          </span>
          {admin && (
            // A file download, not a page: a plain link.
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <a href="/api/export/assistant" className="btn btn-sm">
              Export the log (CSV)
            </a>
          )}
        </div>
        {calls.length === 0 ? (
          <p className="muted text-sm">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {calls.map((c) => {
              const req = (c.request ?? {}) as Request;
              return (
                <li key={c.id} className="py-2">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{FEATURES[c.feature as FeatureId]?.label ?? c.feature}</span>
                    <span className="muted text-xs">{fmtDateTime(c.createdAt, tz, { month: "short", day: "numeric" })}</span>
                    {c.ticketId && (
                      <Link href={`/tickets/${c.ticketId}`} className="link text-xs">
                        ticket
                      </Link>
                    )}
                    {c.accepted === true && <span className="pill tone-done">used</span>}
                    {c.accepted === false && <span className="pill">not useful</span>}
                    {c.error && <span className="pill tone-bad">{c.error}</span>}
                  </div>
                  <details className="mt-1 text-xs">
                    <summary className="muted cursor-pointer">What was sent</summary>
                    {req.system && <pre className="mt-1 whitespace-pre-wrap">{req.system}</pre>}
                    {(req.messages ?? []).map((m, i) => (
                      <pre key={i} className="mt-1 whitespace-pre-wrap border-t border-line pt-1">
                        {m.content}
                      </pre>
                    ))}
                    {req.image && <p className="mt-1">A photo of {Math.round(req.image.bytes / 1000)} KB (not kept here).</p>}
                    {c.response && (
                      <>
                        <p className="mt-2 font-semibold">What came back</p>
                        <pre className="whitespace-pre-wrap">{c.response}</pre>
                      </>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
