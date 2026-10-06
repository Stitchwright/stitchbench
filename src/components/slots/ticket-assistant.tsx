// The Assistant on a ticket (ai-assistant-scope.md 2.6): "Draft it" for Work done, What we found, a partner repair's note and the
// estimate and ready messages, and "What's likely wrong". Server component over ticketAssistantView (src/lib/assistant/
// ticket-view.ts): it reads this company's log for the ticket and the "What we'll send" previews. While the module is
// off nothing shows; once it has ended, only the log (read-only); the card never prints. Nothing here calls the model:
// only a button a person presses does.
import type { CurrentUser } from "@/lib/session";
import { FEATURES, type FeatureId } from "@/lib/assistant/features";
import { ticketAssistantView } from "@/lib/assistant/ticket-view";
import { CausesCard } from "@/components/assistant/causes-card";
import { DraftBox } from "@/components/assistant/draft-box";

const WORDS: Partial<Record<FeatureId, string>> = {
  draft_work_done: "Work done",
  draft_diagnosis: "What we found",
  draft_partner_note: "the note to the sewing shop",
  draft_estimate: "the estimate message",
  draft_ready: "the ready message",
  likely_causes: "likely causes",
};

export async function TicketAssistantSlot({ ticketId, user, canWork, partnerJob }: { ticketId: string; user: CurrentUser; canWork: boolean; partnerJob: boolean }) {
  const v = await ticketAssistantView({ shopId: user.shopId, ticketId, canWork });
  if (!v) return null;
  if (!v.buttons && !v.history.length) return null;
  const d = v.drafts.show ? v.drafts : null;
  const unavailable = d?.unavailable;

  return (
    <section className="card card-pad no-print space-y-3 text-sm" aria-label="Assistant" data-assistant-slot>
      <h2 className="text-base font-semibold">Assistant</h2>
      {v.gate === "readonly" && <p className="muted text-xs">The Assistant is off for this company. What it said before stays here.</p>}
      {d && (
        <div className="space-y-2">
          <DraftBox ticketId={ticketId} kind="work_done" label="Work done (prints on the invoice)" targetId="workDone" latest={v.latest.draft_work_done} preview={v.previews.draft_work_done} unavailable={unavailable} />
          <DraftBox ticketId={ticketId} kind="diagnosis" label="What we found" targetId="diagnosis" latest={v.latest.draft_diagnosis} preview={v.previews.draft_diagnosis} unavailable={unavailable} />
          {partnerJob && <DraftBox ticketId={ticketId} kind="partner_note" label="Note for the sewing shop" targetId="repairNote" latest={v.latest.draft_partner_note} preview={v.previews.draft_partner_note} unavailable={unavailable} />}
          <DraftBox ticketId={ticketId} kind="estimate" label="Estimate message (copy it into a message)" latest={v.latest.draft_estimate} preview={v.previews.draft_estimate} unavailable={unavailable} />
          <DraftBox ticketId={ticketId} kind="ready" label="Ready-for-pickup message (copy it into a message)" latest={v.latest.draft_ready} preview={v.previews.draft_ready} unavailable={unavailable} />
        </div>
      )}
      {v.causes.show && <CausesCard ticketId={ticketId} latest={v.latestCauses} preview={v.previews.likely_causes} unavailable={v.causes.unavailable} />}
      {v.history.length > 0 && (
        <details className="text-xs">
          <summary className="muted cursor-pointer">What the Assistant did on this ticket</summary>
          <ul className="mt-1 space-y-0.5">
            {v.history.map((c) => (
              <li key={c.id}>
                {c.at}: {c.feature === "likely_causes" ? "asked for" : c.feature in FEATURES ? "drafted" : "ran"} {WORDS[c.feature as FeatureId] ?? c.feature}
                {c.accepted === true ? " (used)" : c.accepted === false ? " (not useful)" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
