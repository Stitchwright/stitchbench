"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { FileText, ExternalLink } from "lucide-react";
import { findManuals, firstPage, loadIndex, manualPath, openLocal, type LibraryIndex } from "@/lib/local-manuals";

function useIndex() {
  const [index, setIndex] = useState<LibraryIndex | undefined>();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    loadIndex().then((i) => {
      setIndex(i);
      setReady(true);
    });
  }, []);
  return { index, ready };
}

async function open(path: string, page?: number | null) {
  try {
    await openLocal(path, page);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Could not open that manual.");
  }
}

function kb(n: number) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Manuals on this PC that match the machine's brand and model. */
export function LocalManuals({ brand, model }: { brand: string; model: string }) {
  const { index, ready } = useIndex();
  if (!ready) return <p className="muted text-sm">Looking in your manuals folder...</p>;
  if (!index)
    return (
      <p className="muted text-sm">
        Manuals open from your own PC.{" "}
        <Link href="/manuals" className="link">
          Connect your manuals folder
        </Link>{" "}
        to see them here.
      </p>
    );
  const hits = findManuals(index, brand, model);
  if (!hits.length)
    return (
      <p className="muted text-sm">
        No file in <span className="mono">{index.folderName}</span> has &ldquo;{model}&rdquo; in its name.{" "}
        <Link href="/scan" className="link">
          Scan a paper manual
        </Link>{" "}
        or name files like <span className="mono">Brand_Model_ServiceManual.pdf</span>.
      </p>
    );
  return (
    <ul className="divide-y divide-line">
      {hits.map((f) => (
        <li key={f.path} className="flex items-center gap-3 py-2">
          <FileText size={16} className="shrink-0 text-ink-2" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold" title={f.path}>
              {f.name}
            </div>
            <div className="muted truncate text-xs">
              {f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : index.folderName} · {kb(f.size)}
            </div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => open(f.path)}>
            Open <ExternalLink size={12} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "Open p.51" for a tension spec, if this PC has that manual: in the connected folder, or in the shop PC's library. */
export function OpenSpecSource({ file, sourcePath, pages }: { file: string; sourcePath?: string | null; pages: string | null }) {
  const { index, ready } = useIndex();
  const [path, setPath] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    manualPath(index, sourcePath ?? file).then((p) => live && setPath(p));
    return () => {
      live = false;
    };
  }, [index, ready, sourcePath, file]);
  if (!ready || path === undefined) return null;
  const page = firstPage(pages);
  if (!path)
    return (
      <span className="muted text-xs" title={file}>
        {pages ? `p. ${pages}` : ""}
      </span>
    );
  return (
    <button type="button" className="link text-xs font-semibold" onClick={() => open(path, page)} title={`Open ${file}`}>
      Open{page ? ` p. ${page}` : ""}
    </button>
  );
}
