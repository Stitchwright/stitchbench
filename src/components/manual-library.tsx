"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FolderOpen, RefreshCw, FileText, ExternalLink } from "lucide-react";
import {
  connectFolder,
  disconnect,
  folderAccessSupported,
  indexPickedFiles,
  loadIndex,
  openLocal,
  rescan,
  type LibraryIndex,
} from "@/lib/local-manuals";

export function ManualLibrary() {
  const [index, setIndex] = useState<LibraryIndex | undefined>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Rendering waits for `ready`, so server and client never disagree about this.
  const [supported] = useState(() => typeof window === "undefined" || folderAccessSupported());

  useEffect(() => {
    loadIndex().then((i) => {
      setIndex(i);
      setReady(true);
    });
  }, []);

  async function run(label: string, fn: () => Promise<LibraryIndex>) {
    setBusy(label);
    try {
      const i = await fn();
      setIndex(i);
      toast.success(`${i.files.length} PDFs indexed`);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      toast.error(e instanceof Error ? e.message : "Could not read that folder.");
    } finally {
      setBusy(null);
    }
  }

  const hits = useMemo(() => {
    if (!index || q.trim().length < 2) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return index.files.filter((f) => words.every((w) => f.path.toLowerCase().includes(w))).slice(0, 200);
  }, [index, q]);

  if (!ready) return <p className="muted">Loading...</p>;

  return (
    <div className="space-y-6">
      <section className="card card-pad space-y-3">
        {index ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-semibold">
                  <FolderOpen size={16} className="mr-1 inline" aria-hidden />
                  {index.folderName || "Manuals folder"}
                </div>
                <div className="muted text-sm">
                  {index.files.length.toLocaleString()} PDFs · indexed {new Date(index.scannedAt).toLocaleString()}
                  {index.mode === "session" && " · picked for this visit only"}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {index.mode === "folder" && (
                  <button type="button" className="btn" disabled={!!busy} onClick={() => run("rescan", () => rescan())}>
                    <RefreshCw size={14} aria-hidden /> {busy === "rescan" ? "Indexing..." : "Re-index"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={async () => {
                    await disconnect();
                    setIndex(undefined);
                  }}
                >
                  Forget folder
                </button>
              </div>
            </div>
          </>
        ) : (
          <p>
            Pick the folder where you keep your service manuals (sub-folders are included). Name files like{" "}
            <span className="mono">Brand_Model_ServiceManual_Year.pdf</span> and they&apos;ll match machines by model.
          </p>
        )}
        {(!index || index.mode === "session") && (
          <div className="flex flex-wrap items-center gap-3">
            {supported ? (
              <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => run("connect", () => connectFolder())}>
                <FolderOpen size={14} aria-hidden /> {busy === "connect" ? "Indexing..." : "Connect manuals folder"}
              </button>
            ) : (
              <>
                <input
                  id="pick-folder"
                  type="file"
                  className="sr-only"
                  multiple
                  // @ts-expect-error: webkitdirectory is not in React's input types
                  webkitdirectory=""
                  onChange={(e) => e.target.files && run("pick", () => indexPickedFiles(e.target.files!))}
                />
                <label htmlFor="pick-folder" className="btn btn-primary cursor-pointer">
                  <FolderOpen size={14} aria-hidden /> Pick manuals folder
                </label>
                <span className="muted text-sm">This browser can&apos;t remember folders. Chrome or Edge on a PC keeps the connection between visits.</span>
              </>
            )}
          </div>
        )}
      </section>

      {index && (
        <section className="space-y-3">
          <label htmlFor="mq" className="label">
            Find a manual
          </label>
          <input id="mq" value={q} onChange={(e) => setQ(e.target.value)} className="input" placeholder="e.g. janome 6700 service" />
          {q.trim().length >= 2 && (
            <p className="muted text-sm">
              {hits.length === 200 ? "First 200 matches" : `${hits.length} match${hits.length === 1 ? "" : "es"}`}
            </p>
          )}
          <ul className="card divide-y divide-line">
            {hits.map((f) => (
              <li key={f.path} className="flex items-center gap-3 px-4 py-2">
                <FileText size={16} className="shrink-0 text-ink-2" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{f.name}</div>
                  <div className="muted truncate text-xs">{f.path}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => openLocal(f.path).catch((e) => toast.error(e instanceof Error ? e.message : "Could not open it."))}
                >
                  Open <ExternalLink size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
