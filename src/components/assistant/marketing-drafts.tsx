"use client";
// Marketing drafts (shop-features-round-2-design.md 5.2): "Draft it" beside the field the words go in, and "Draft a social
// post" with a Copy button. The draft lands in the field for her to change and save; nothing is sent by itself.
import { useState, useTransition } from "react";
import { Copy, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { draftArrivalsEmail, draftClassText, draftItemText, draftPostText } from "@/actions/assistant";
import { runAction } from "@/components/action-form";

/** Puts text in a field the way typing would, so counters and the page's own state follow. */
function fill(id: string, text: string) {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

const valueOf = (form: HTMLFormElement | null, name: string) => {
  const v = form?.elements.namedItem(name);
  return v && "value" in v ? String((v as unknown as HTMLInputElement).value ?? "") : "";
};

type Kind = { kind: "arrivals"; subjectId: string; bodyId: string } | { kind: "class"; classId: string | null; bodyId: string } | { kind: "item"; partId: string; bodyId: string };

/**
 * "Draft it" for a field: a new arrivals email (subject and body of a campaign, from what came in in the last N days), a
 * class's "About the class" (from the class form as typed), or an item's online text. "Try again" takes a few words
 * ("shorter", "mention the sale table").
 */
export function DraftFill({ what, unavailable }: { what: Kind; unavailable?: string }) {
  const [pending, start] = useTransition();
  const [drafted, setDrafted] = useState(false);
  const [days, setDays] = useState("14");
  const [instruction, setInstruction] = useState("");
  if (unavailable) return <p className="muted text-xs">{unavailable}</p>;
  const run = (btn: HTMLButtonElement) =>
    start(async () => {
      const form = btn.closest("form");
      const r =
        what.kind === "arrivals"
          ? await runAction(() => draftArrivalsEmail(Number(days) || 14, instruction))
          : what.kind === "class"
            ? await runAction(() =>
                draftClassText(what.classId, { title: valueOf(form, "title"), teacher: valueOf(form, "teacher"), location: valueOf(form, "location"), supplies: valueOf(form, "supplies"), fee: valueOf(form, "fee") }, instruction),
              )
            : await runAction(() => draftItemText(what.partId, instruction));
      if (r?.error) return void toast.error(r.error);
      if (!r?.shown) return;
      const j = JSON.parse(r.shown) as { text?: string; subject?: string; body?: string; count?: number };
      if (what.kind === "arrivals") {
        fill(what.subjectId, j.subject ?? "");
        fill(what.bodyId, j.body ?? "");
        toast.success(`Drafted from ${j.count} item${j.count === 1 ? "" : "s"}. Change anything, then save.`);
      } else {
        fill(what.bodyId, j.text ?? "");
        toast.success("Drafted. Change anything, then save.");
      }
      setDrafted(true);
    });
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm" data-draft-fill={what.kind}>
      {what.kind === "arrivals" && (
        <div className="field w-36">
          <label htmlFor="arrival-days" className="label">
            Arrived in the last
          </label>
          <div className="flex items-center gap-1">
            <input id="arrival-days" value={days} onChange={(e) => setDays(e.target.value)} className="input num w-16" inputMode="numeric" />
            <span>days</span>
          </div>
        </div>
      )}
      {drafted && (
        <div className="field min-w-48 flex-1">
          <label htmlFor={`draft-again-${what.kind}`} className="label">
            Anything to change? (optional)
          </label>
          <input id={`draft-again-${what.kind}`} value={instruction} onChange={(e) => setInstruction(e.target.value)} className="input" maxLength={160} placeholder="shorter, mention the sale table" />
        </div>
      )}
      <button type="button" className="btn btn-sm" disabled={pending} onClick={(e) => run(e.currentTarget)}>
        <Sparkles size={14} aria-hidden /> {pending ? "Drafting..." : drafted ? "Try again" : what.kind === "arrivals" ? "Draft a new arrivals email" : "Draft it"}
      </button>
    </div>
  );
}

/** "Draft a social post": the words to copy into Facebook or Instagram. Nothing is posted from here. */
export function PostDraft({ about, id, unavailable }: { about: "arrivals" | "class" | "item"; id?: string; unavailable?: string }) {
  const [pending, start] = useTransition();
  const [text, setText] = useState<string | null>(null);
  if (unavailable) return null;
  const run = () =>
    start(async () => {
      const r = await runAction(() => draftPostText(about, id ?? null, 14, ""));
      if (r?.error) toast.error(r.error);
      else if (r?.shown) setText((JSON.parse(r.shown) as { text: string }).text);
    });
  return (
    <div className="space-y-2 text-sm" data-post-draft={about}>
      <button type="button" className="btn btn-sm" disabled={pending} onClick={run}>
        <Sparkles size={14} aria-hidden /> {pending ? "Drafting..." : text ? "Draft another post" : "Draft a social post"}
      </button>
      {text != null && (
        <div className="space-y-2">
          <label htmlFor={`post-${about}`} className="label">
            Your post (change it, then copy it into Facebook or Instagram)
          </label>
          <textarea id={`post-${about}`} value={text} onChange={(e) => setText(e.target.value)} rows={5} className="input" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                toast.success("Copied. Paste it into your post.");
              } catch {
                toast.error("Couldn't copy here: select the text and copy it.");
              }
            }}
          >
            <Copy size={14} aria-hidden /> Copy
          </button>
        </div>
      )}
    </div>
  );
}
