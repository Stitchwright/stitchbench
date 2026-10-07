"use client";
// The pickup sheet on a ticket (shop-features-round-2-design.md 5.5): "What we did" in plain words and care tips ticked
// from the shop's own list, printed with the invoice. With the Assistant, "Draft the pickup sheet" fills the words and
// ticks tips from the list; nothing is saved until she saves.
import Link from "next/link";
import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { draftPickupSheet } from "@/actions/assistant";
import { savePickupSheet } from "@/actions/care-tips";
import { ActionForm, runAction, Submit } from "@/components/action-form";
import { withArticle } from "@/lib/equipment/types";

export function PickupSheetForm({
  ticketId,
  what,
  tips,
  chosen,
  canEdit,
  admin,
  noun,
  draft,
}: {
  ticketId: string;
  what: string;
  tips: { id: string; text: string }[];
  /** The tips already on the sheet (by their text, as printed). */
  chosen: string[];
  canEdit: boolean;
  admin: boolean;
  noun: string;
  /** The Assistant's "Draft the pickup sheet": absent when it can't be used here. */
  draft?: { unavailable?: string } | null;
}) {
  const [text, setText] = useState(what);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(tips.filter((t) => chosen.includes(t.text)).map((t) => t.id)));
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      const r = await runAction(() => draftPickupSheet(ticketId));
      if (r?.error) return void toast.error(r.error);
      if (!r?.shown) return;
      const j = JSON.parse(r.shown) as { what: string; tipIds: string[] };
      setText(j.what);
      setTicked(new Set(j.tipIds));
      toast.success("Drafted. Check it, then save.");
    });
  if (!canEdit) {
    return what || chosen.length ? (
      <div className="space-y-2 text-sm">
        {what && <p className="whitespace-pre-wrap">{what}</p>}
        {chosen.length > 0 && (
          <ul className="list-disc pl-5">
            {chosen.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </div>
    ) : (
      <p className="muted text-sm">No pickup sheet yet.</p>
    );
  }
  return (
    <ActionForm action={savePickupSheet.bind(null, ticketId)} success="Saved: it prints with the invoice" className="space-y-3" id="pickup-sheet">
      {draft &&
        (draft.unavailable ? (
          <p className="muted text-xs">{draft.unavailable}</p>
        ) : (
          <button type="button" className="btn btn-sm" disabled={pending} onClick={run}>
            <Sparkles size={14} aria-hidden /> {pending ? "Drafting..." : "Draft the pickup sheet"}
          </button>
        ))}
      <div className="field">
        <label htmlFor="pickup-what" className="label">
          What we did (in plain words, for her to take home)
        </label>
        <textarea id="pickup-what" name="pickupWhat" rows={3} maxLength={2000} className="input" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <fieldset className="space-y-1">
        <legend className="label">Care tips to print</legend>
        {tips.length === 0 ? (
          <p className="muted text-sm">
            No care tips for {withArticle(noun)} yet.{" "}
            {admin ? (
              <Link href="/settings/care-tips" className="link">
                Add your care tips
              </Link>
            ) : (
              "An owner or admin can add them in Settings."
            )}
          </p>
        ) : (
          tips.map((t) => (
            <label key={t.id} className="flex min-h-11 items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="tip"
                value={t.id}
                className="check mt-0.5"
                checked={ticked.has(t.id)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setTicked((s) => {
                    const n = new Set(s);
                    if (on) n.add(t.id);
                    else n.delete(t.id);
                    return n;
                  });
                }}
              />
              {t.text}
            </label>
          ))
        )}
      </fieldset>
      <Submit>Save the pickup sheet</Submit>
    </ActionForm>
  );
}
