// "Ask the manuals" on a model page or a ticket (ai-assistant-scope.md 1.4): the index's state and buttons, and the
// question box once something is searchable. Server component; shows nothing unless the Assistant's manuals feature can
// work here (module on, switch on, the manual library on this PC). Asking needs the internet; indexing and the manuals
// themselves don't. Nothing here calls the model: only the Ask button does.
import { libraryDir } from "@/lib/library-dir";
import { entryFor } from "@/lib/assistant/ui";
import { modelIndexState } from "@/lib/assistant/manuals";
import type { CurrentUser } from "@/lib/session";
import { Section } from "@/components/ui";
import { AskManualsCard } from "@/components/assistant/ask-manuals-card";
import { ManualsIndexPanel } from "@/components/assistant/manuals-index-panel";

export async function ManualsAsk({ user, brand, model, ticketId }: { user: CurrentUser; brand: string; model: string; ticketId?: string }) {
  if (!libraryDir()) return null;
  const entry = await entryFor(user.shopId, "manuals");
  if (!entry.show) return null;
  const st = await modelIndexState(user.shopId, brand, model);
  if (!st.docs.length) return null;
  const blocked = st.searchable === 0 ? (st.scanned > 0 ? "These manuals are scanned pictures, which can't be searched yet." : "Index this model's manuals first, then ask.") : undefined;
  return (
    <div className="no-print">
    <Section title="Ask the manuals">
      <div className="space-y-3">
        <AskManualsCard brand={brand} model={model} ticketId={ticketId} unavailable={entry.unavailable} blocked={blocked} />
        <ManualsIndexPanel shopId={user.shopId} scope={{ brand, model }} admin={user.role !== "TECH"} />
      </div>
    </Section>
    </div>
  );
}
