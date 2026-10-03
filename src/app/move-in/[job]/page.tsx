import { importJob } from "@/lib/move/import-jobs";
import { AutoRefresh } from "@/components/auto-refresh";
import { MoveImportProgress, MoveImportSummary } from "@/components/move-import-summary";

// The Windows program's import, as it runs (company-move-design.md section 8): desktop/main.mjs opens this page in its
// window once the server has the file. The address is the job's long random id, which only the program's window has;
// it shows the progress, then what came in and what to enter again, or why nothing was imported. Hosted imports are
// shown on the Companies page instead. Links to /move-in?choose=1 and ?home=1 are the program's own (main.mjs).
export default async function MoveInJob({ params }: { params: Promise<{ job: string }> }) {
  const { job: id } = await params;
  const job = importJob(id);
  const pc = job?.door === "pc" ? job : null;
  const running = pc && (pc.status === "checking" || pc.status === "importing");
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="card card-pad w-full max-w-2xl space-y-4">
        <h1 className="text-xl font-bold">Restore a company from a move file</h1>
        {!pc && (
          <p className="text-sm">
            This import isn&apos;t running any more (the program may have restarted). Nothing is lost: an import goes in whole or not at all.{" "}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full navigation: the program's window (desktop/main.mjs) sees it and opens its file dialog */}
            <a href="/move-in?choose=1" className="link">
              Choose the file again
            </a>
            .
          </p>
        )}
        {running && (
          <>
            <MoveImportProgress p={pc} />
            <AutoRefresh seconds={1} />
          </>
        )}
        {pc?.status === "failed" && (
          <div className="space-y-3">
            <p className="card card-pad tone-bad text-sm" role="alert">
              Nothing was imported. {pc.error}
            </p>
            <div className="flex flex-wrap gap-2">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full navigation: the program's window (desktop/main.mjs) sees it and opens its file dialog */}
              <a href="/move-in?choose=1" className="btn btn-primary">
                Choose another file
              </a>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full navigation: the program's window (desktop/main.mjs) sees it and goes back to its first page */}
              <a href="/move-in?home=1" className="btn">
                Back
              </a>
            </div>
          </div>
        )}
        {pc?.status === "done" && pc.summary && (
          <div className="space-y-4">
            <MoveImportSummary summary={pc.summary} />
            <a href="/login" className="btn btn-primary">
              Sign in
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
