"use client";
// One automatic message's wording: the textarea, the fields it may use, a live sample with the sample values, the
// plain-character and parts notes, "Reset to the default" and "Send me a sample" (scheduling-messaging-design.md
// section 5). The saved text arrives as `value`; the page re-renders it after a save or reset.
import { useState } from "react";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { SmsCounter } from "@/components/sms-counter";
import { TestSendForm } from "@/components/messaging-settings-forms";
import { DEFAULT_TEMPLATES, plainText, render, smsParts } from "@/lib/messaging/templates";
import { resetTemplate, saveTemplate } from "@/actions/messaging";

const LIMITS: Record<string, number> = { sms: 480, email: 5000, subject: 150 };

export function TemplateEditor({
  templateKey,
  value,
  fields,
  sample,
  prefix = "",
  suffix = "",
  partMills,
  addresses,
  readOnly = false,
}: {
  templateKey: string;
  value: string;
  fields: readonly string[];
  sample: Record<string, string>;
  /** what finalize() puts in front ("{Shop}: " on texts) and after (the STOP line, the email signature or footer) */
  prefix?: string;
  suffix?: string;
  partMills?: number | null;
  /** the admin's own addresses a sample may go to */
  addresses?: { emails: string[]; phones: string[] };
  readOnly?: boolean;
}) {
  const part = templateKey.split(".")[1] ?? "sms";
  const sms = part === "sms";
  const [text, setText] = useState(value);
  // A save or reset re-renders the page with the new saved text: take it (React's "adjust state while rendering").
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
  }
  const limit = LIMITS[part] ?? 480;
  const rendered = render(plainText(text).text, sample);
  const preview = `${prefix}${rendered}${suffix}`;
  const plain = plainText(text);
  const isDefault = text.trim() === (DEFAULT_TEMPLATES[templateKey] ?? "").trim();
  const unicode = sms && smsParts(preview).unicode;
  const inputId = `tpl-${templateKey.replace(/\W/g, "-")}`;
  const channel: "email" | "sms" = sms ? "sms" : "email";
  const sampleTo = addresses ? (sms ? addresses.phones : addresses.emails) : [];

  if (readOnly) {
    return (
      <div className="space-y-2 text-sm">
        <pre className="whitespace-pre-wrap rounded border border-line p-2 font-sans">{text}</pre>
        <div>
          <div className="label mb-1">Sample</div>
          <pre className="whitespace-pre-wrap font-sans">{preview}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ActionForm action={(fd) => saveTemplate(templateKey, fd)} success="Saved" className="space-y-2">
        <label htmlFor={inputId} className="sr-only">
          Wording
        </label>
        <textarea id={inputId} name="text" rows={part === "email" ? 6 : part === "subject" ? 1 : 3} className="textarea text-sm" value={text} onChange={(e) => setText(e.target.value)} maxLength={limit} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="muted">
            {text.length}/{limit}
          </span>
          {sms && <SmsCounter name="text" prefix={prefix} suffix={suffix} partMills={partMills} vars={sample} />}
        </div>
        <p className="muted text-xs">
          Fields you can use: {fields.map((f) => `{${f}}`).join(", ")}
          {part === "sms" && " (texts start with the shop's name by themselves)"}
        </p>
        {plain.changed && <p className="text-xs">We&apos;ll change curly quotes and dashes to plain ones when you save, so texts stay one part.</p>}
        {unicode && <p className="text-xs">Emoji or special characters make each text part 70 characters instead of 160, so this costs more to send.</p>}
        <div>
          <div className="label mb-1">Sample, as a customer would get it</div>
          <pre className="whitespace-pre-wrap rounded border border-line p-2 font-sans text-sm">{preview}</pre>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Submit className="btn btn-sm btn-primary">Save wording</Submit>
          {!isDefault && (
            <ActionButton action={() => resetTemplate(templateKey)} className="btn btn-sm" confirm="Reset it?" success="Back to the default wording">
              Reset to the default
            </ActionButton>
          )}
        </div>
      </ActionForm>
      {part !== "subject" && addresses && <TestSendForm channel={channel} addresses={sampleTo} sample={templateKey} idPrefix={inputId} label={`Send me a sample ${sms ? "text" : "email"} at`} button="Send me a sample" />}
    </div>
  );
}
