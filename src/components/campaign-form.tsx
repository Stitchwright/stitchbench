"use client";
// The campaign draft form (scheduling-messaging-design.md 11.3): name, channel, the audience picker, subject and body
// with the merge fields, and the live text counter. Posts saveCampaign; a new draft is taken to its page.
import { useState } from "react";
import type { ActionResult } from "@/lib/action";
import type { Audience } from "@/lib/messaging/audiences";
import { FIELDS } from "@/lib/messaging/templates";
import { ActionForm, Submit } from "@/components/action-form";
import { SmsCounter } from "@/components/sms-counter";

export type ClassOption = { id: string; title: string };

export type CampaignDraft = { name: string; channel: "email" | "sms"; subject: string | null; body: string; audience: Audience };

const MERGE_FIELDS = FIELDS.campaign;

/** The audience kinds as the picker names them (the server module that resolves them is server-only). */
const AUDIENCE_KINDS: { kind: Audience["kind"]; label: string; needs: "retail" | "repair" | null }[] = [
  { kind: "all", label: "Everyone", needs: null },
  { kind: "bought", label: "Bought something in the last N days", needs: "retail" },
  { kind: "repairs", label: "Had a repair finished in the last N days", needs: "repair" },
  { kind: "service_due", label: "Machine last serviced more than N months ago", needs: "repair" },
  { kind: "class", label: "Signed up for a class", needs: "retail" },
  { kind: "classes", label: "Came to a class in the last N days", needs: "retail" },
];

export function CampaignForm({
  action,
  draft,
  classes,
  shop,
  partMills,
  canBeChanged = true,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  draft: CampaignDraft | null;
  classes: ClassOption[];
  shop: { name: string; sellsRetail: boolean; doesRepair: boolean };
  partMills: number | null;
  /** false: an existing draft's channel is fixed */
  canBeChanged?: boolean;
}) {
  const [channel, setChannel] = useState<"email" | "sms">(draft?.channel ?? "email");
  const [kind, setKind] = useState<Audience["kind"]>(draft?.audience.kind ?? "all");
  const a = draft?.audience;
  const days = a && "days" in a ? a.days : 90;
  const months = a && "months" in a ? a.months : 12;
  const classId = a && a.kind === "class" ? a.classId : "";
  const kinds = AUDIENCE_KINDS.filter((k) => !k.needs || (k.needs === "retail" ? shop.sellsRetail : shop.doesRepair));
  const vars = { first_name: "Mary", name: "Mary Smith", shop_name: shop.name, shop_phone: "(555) 123-4567", machine: "Janome MC6700P", upcoming_classes: "" };

  return (
    <ActionForm action={action} success="Saved" className="space-y-4">
      <div className="field">
        <label htmlFor="cp-name" className="label">
          Name (for your own list)
        </label>
        <input id="cp-name" name="name" className="input" maxLength={120} required defaultValue={draft?.name ?? ""} />
      </div>

      <fieldset className="flex flex-wrap gap-x-5 gap-y-1">
        <legend className="label">Send it by</legend>
        {(["email", "sms"] as const).map((ch) => (
          <label key={ch} className="flex items-center gap-2">
            <input type="radio" name="channel" value={ch} className="check" checked={channel === ch} disabled={!canBeChanged} onChange={() => setChannel(ch)} />
            {ch === "email" ? "Email" : "Text"}
          </label>
        ))}
        {!canBeChanged && <input type="hidden" name="channel" value={channel} />}
        {!canBeChanged && <span className="muted text-xs">Fixed once saved: copy the campaign to send it the other way.</span>}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="label">Who gets it</legend>
        <div className="flex flex-wrap items-center gap-2">
          <select name="audience" className="select" value={kind} onChange={(e) => setKind(e.target.value as Audience["kind"])} aria-label="Who gets it">
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          {(kind === "bought" || kind === "repairs" || kind === "classes") && (
            <label className="flex items-center gap-2">
              <span>Days</span>
              <input name="days" className="input num w-24" inputMode="numeric" defaultValue={String(days)} aria-label="Days" />
            </label>
          )}
          {kind === "service_due" && (
            <label className="flex items-center gap-2">
              <span>Months</span>
              <input name="months" className="input num w-24" inputMode="numeric" defaultValue={String(months)} aria-label="Months" />
            </label>
          )}
          {kind === "class" && (
            <select name="classId" className="select" defaultValue={classId} aria-label="Class">
              <option value="">Pick a class</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="muted text-xs">Retail customers only; trade accounts and anyone who unsubscribed are left out.</p>
      </fieldset>

      {channel === "email" && (
        <div className="field">
          <label htmlFor="cp-subject" className="label">
            Subject
          </label>
          <input id="cp-subject" name="subject" className="input" maxLength={150} defaultValue={draft?.subject ?? ""} />
        </div>
      )}

      <div className="field">
        <label htmlFor="cp-body" className="label">
          {channel === "email" ? "What the email says" : "What the text says"}
        </label>
        <textarea id="cp-body" name="body" rows={channel === "email" ? 10 : 4} maxLength={channel === "email" ? 5000 : 480} className="input" defaultValue={draft?.body ?? ""} />
        <div className="muted mt-1 text-xs">
          You can use {MERGE_FIELDS.map((f) => `{${f}}`).join(", ")}.{" "}
          <InsertField />
        </div>
        {channel === "sms" && (
          <div className="mt-1">
            <SmsCounter name="body" prefix={`${shop.name}: `} suffix=" Reply STOP to opt out." partMills={partMills} vars={vars} />
            <div className="muted text-xs">Every text also gets &quot;{shop.name}: &quot; in front and &quot; Reply STOP to opt out.&quot; at the end.</div>
          </div>
        )}
      </div>

      <Submit>{draft ? "Save" : "Save draft"}</Submit>
    </ActionForm>
  );
}

/** A select that drops a merge field into the body at the cursor. */
function InsertField() {
  return (
    <select
      className="select inline-block w-auto py-0 text-xs"
      aria-label="Insert a field"
      defaultValue=""
      onChange={(e) => {
        const f = e.target.value;
        e.target.value = "";
        if (!f) return;
        const box = e.target.closest("form")?.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
        if (!box) return;
        const start = box.selectionStart ?? box.value.length;
        const end = box.selectionEnd ?? start;
        box.setRangeText(`{${f}}`, start, end, "end");
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.focus();
      }}
    >
      <option value="">Insert a field...</option>
      {MERGE_FIELDS.map((f) => (
        <option key={f} value={f}>
          {`{${f}}`}
        </option>
      ))}
    </select>
  );
}
