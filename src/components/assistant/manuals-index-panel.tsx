// The search index's state and buttons (ai-assistant-scope.md 1.4): nothing is indexed until a person presses the button;
// while it runs the page re-reads itself and shows how far it has got; Stop keeps what was read and Continue carries on.
// A server component: it reads this company's progress (src/lib/assistant/manuals-index.ts).
import { Ban, Play, ScanSearch, Trash2 } from "lucide-react";
import { indexProgress, type IndexScope } from "@/lib/assistant/manuals-index";
import { ActionButton } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { clearManualIndex, indexManuals, stopManualIndexing } from "@/actions/assistant";

export async function ManualsIndexPanel({ shopId, scope, admin }: { shopId: string; scope: IndexScope; admin: boolean }) {
  const p = await indexProgress(shopId, scope);
  const model = "brand" in scope ? scope : null;
  const pct = p.pages ? Math.min(100, Math.round((p.pagesDone / p.pages) * 100)) : 0;
  const start = indexManuals.bind(null, model?.brand ?? null, model?.model ?? null);
  const canStart = !!model || admin;
  const todo = p.files - p.done;
  const unfinished = p.waiting + p.paused + p.failed;
  return (
    <div className="space-y-2 text-sm" data-manuals-index>
      {p.active && <AutoRefresh seconds={2} />}
      {p.files === 0 ? (
        <p className="muted">No manuals for this in your library yet.</p>
      ) : p.active ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <ScanSearch size={14} className="inline animate-pulse" aria-hidden /> Reading the manuals: {p.done} of {p.files} files done
              {p.pages > 0 && `, ${p.pagesDone} of ${p.pages} pages so far`}.
            </span>
            <ActionButton action={stopManualIndexing} className="btn btn-sm" success="Stopped; what was read stays">
              <Ban size={12} aria-hidden /> Stop
            </ActionButton>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Indexing progress">
            <div className="h-full bg-thread" style={{ width: `${pct}%` }} />
          </div>
          <p className="muted text-xs">This runs in the background. You can keep working or leave this page.</p>
        </>
      ) : (
        <>
          <p>
            {p.done === p.files ? (
              <>
                {p.files === 1 ? "The manual is" : `All ${p.files} manuals are`} searchable: {p.searchable} page{p.searchable === 1 ? "" : "s"}.
              </>
            ) : p.done > 0 ? (
              <>
                {p.done} of {p.files} manuals are searchable ({p.searchable} pages).
              </>
            ) : (
              <>{p.files === 1 ? "1 manual" : `${p.files} manuals`} can be made searchable. This reads the text on this PC and keeps it in your own database; nothing is sent anywhere.</>
            )}
          </p>
          {p.waiting > 0 && <p className="muted text-xs">Indexing was interrupted ({p.waiting} file{p.waiting === 1 ? "" : "s"} left). Continue picks up where it stopped.</p>}
          {p.paused > 0 && <p className="muted text-xs">Stopped with {p.paused} file{p.paused === 1 ? "" : "s"} left. Continue picks up where it stopped.</p>}
          {p.failed > 0 && (
            <p className="text-xs">
              {p.failed} file{p.failed === 1 ? "" : "s"} couldn&apos;t be read{p.error ? `: ${p.error}` : ""}.
            </p>
          )}
          {p.blankPages > 0 && (
            <p className="muted text-xs">
              {p.blankPages} page{p.blankPages === 1 ? " is a scan" : "s are scans"} and can&apos;t be searched yet.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {canStart && todo > 0 && (
              <ActionButton action={start} className="btn btn-sm" confirm={model ? undefined : "Index the whole library? A big library can take hours (it runs in the background)."} success="Started">
                <Play size={12} aria-hidden /> {unfinished > 0 ? "Continue indexing" : model ? "Index these manuals" : "Index my whole library"}
              </ActionButton>
            )}
            {admin && !model && p.pagesDone > 0 && (
              <ActionButton action={clearManualIndex} className="btn btn-sm" confirm="Delete the search index? The manuals stay; you can index again." success="Search index deleted">
                <Trash2 size={12} aria-hidden /> Delete the search index
              </ActionButton>
            )}
          </div>
        </>
      )}
    </div>
  );
}
