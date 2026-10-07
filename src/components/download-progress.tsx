// The manual library's download jobs ("Download everything"): what's waiting, what's being fetched now, what was saved
// and where, what failed and why. The page re-reads itself every few seconds while a job is running.
import { Ban, Check, Download, X } from "lucide-react";
import { fmtDateTime } from "@/lib/format";
import { downloadJobs, downloadsActive, type JobProgress } from "@/lib/manual-downloads";
import { ActionButton } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { cancelManualDownloads, clearManualDownloads } from "@/actions/manual-downloads";

function Job({ j, timeZone }: { j: JobProgress; timeZone: string }) {
  const finished = j.done + j.skipped + j.failed;
  const running = j.queued + j.downloading > 0;
  const pct = j.total ? Math.round((finished / j.total) * 100) : 0;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">
            {running ? <Download size={12} className="inline animate-pulse" aria-hidden /> : <Check size={12} className="inline" aria-hidden />} {j.label}
          </div>
          <div className="muted text-xs">
            {running ? `${finished} of ${j.total} done` : `${j.total} link${j.total === 1 ? "" : "s"}, finished`}
            {j.done > 0 && `, ${j.done} saved`}
            {j.skipped > 0 && `, ${j.skipped} skipped`}
            {j.failed > 0 && `, ${j.failed} failed`}
            {" · started "}
            {fmtDateTime(j.queuedAt, timeZone)}
          </div>
        </div>
        {running ? (
          <ActionButton action={cancelManualDownloads.bind(null, j.jobId)} className="btn btn-sm" confirm="Stop the rest?" success="Stopped; what was saved stays" title="Stop the rest of this job">
            <Ban size={12} aria-hidden /> Stop
          </ActionButton>
        ) : (
          <ActionButton action={clearManualDownloads.bind(null, j.jobId)} className="btn btn-sm" title="Clear from the list">
            <X size={12} aria-label="Clear" />
          </ActionButton>
        )}
      </div>
      {running && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${j.label}: ${pct}% done`}>
          <div className="h-full bg-thread" style={{ width: `${pct}%` }} />
        </div>
      )}
      {j.current && (
        <p className="muted mt-1 text-xs">
          Now: {j.current.brand} {j.current.models}: {j.current.title}
        </p>
      )}
      {j.problems.length > 0 && (
        <details className="mt-1 text-xs">
          <summary className="link cursor-pointer">{j.problems.length} not downloaded (see why)</summary>
          <ul className="mt-1 space-y-0.5">
            {j.problems.map((r) => (
              <li key={r.id}>
                <span className={`pill ${r.status === "SKIPPED" ? "tone-neutral" : r.status === "QUEUED" ? "tone-wait" : "tone-bad"}`}>{r.status === "SKIPPED" ? "Skipped" : r.status === "QUEUED" ? "Waiting" : "Failed"}</span> {r.brand} {r.models}: {r.title}
                {r.error && <span className="muted"> — {r.error}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {j.saved.length > 0 && (
        <details className="mt-1 text-xs">
          <summary className="link cursor-pointer">{j.saved.length} saved (where)</summary>
          <ul className="mt-1 space-y-0.5">
            {j.saved.map((r) => (
              <li key={r.id} className="break-all">
                <code className="mono rounded bg-surface-2 px-1">{r.path}</code>
                {!r.filed && <span className="muted"> (the link didn&apos;t say enough to file it by model)</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/**
 * This company's download jobs, newest first. `labels` narrows the list to the jobs with those labels (the model page:
 * its model's and its brand's); without it every job shows (the Manual links page). Nothing rendered when there are none.
 */
export async function DownloadProgress({ shopId, timeZone, labels }: { shopId: string; timeZone: string; labels?: string[] }) {
  const [jobs, active] = await Promise.all([downloadJobs(shopId), downloadsActive(shopId)]);
  const want = labels?.map((l) => l.toLowerCase());
  const shown = want ? jobs.filter((j) => want.includes(j.label.toLowerCase())) : jobs;
  if (!shown.length) return null;
  return (
    <div className="border-t border-line pt-2">
      {active && <AutoRefresh seconds={5} />}
      <div className="label mb-1">Downloads</div>
      <ul className="divide-y divide-line text-sm">
        {shown.map((j) => (
          <Job key={j.jobId} j={j} timeZone={timeZone} />
        ))}
      </ul>
    </div>
  );
}
