"use client";
// A form whose button needs two taps (scheduling-messaging-design.md 11.3 "Send now"): the first tap arms it and shows
// what the second will do ("Tap again to send to 412 people"); it disarms by itself after a few seconds. The second tap
// posts the hidden fields (the count the page showed, so the server can refuse when the list changed meanwhile).
import { useEffect, useState } from "react";
import type { ActionResult } from "@/lib/action";
import { ActionForm, Submit } from "@/components/action-form";

export function TwoTapButton({
  action,
  fields,
  label,
  armedLabel,
  success,
  className = "btn btn-primary",
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  fields: Record<string, string>;
  label: string;
  armedLabel: string;
  success?: string;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <ActionForm action={action} success={success} className="inline-flex">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {armed ? (
        <Submit className={className}>{armedLabel}</Submit>
      ) : (
        <button type="button" className={className} onClick={() => setArmed(true)}>
          {label}
        </button>
      )}
    </ActionForm>
  );
}
