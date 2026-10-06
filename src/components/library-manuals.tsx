"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Copy, ExternalLink, FileText } from "lucide-react";
import { ActionButton } from "@/components/action-form";
import { deleteWithdrawnCopy } from "@/actions/manual-repository";
import { findByPath, findManuals, loadIndex, openLocal, serverLibrary, SERVER_PREFIX, type LibraryIndex } from "@/lib/local-manuals";

type Doc = { path: string; file: string; docType: string | null; pages: number | null; sizeBytes: number | null; withdrawnWhy?: string | null };

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Path copied. Paste it into File Explorer's address bar.");
  } catch {
    toast.error("Couldn't copy. Select the path and copy it by hand.");
  }
}

function size(n: number | null) {
  if (!n) return "";
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Every manual the shop library has for this model: its path on the shop PCs, and Open when this PC has it. */
export function LibraryManuals({ docs, root, brand, model }: { docs: Doc[]; root: string; brand: string; model: string }) {
  const [index, setIndex] = useState<LibraryIndex | undefined>();
  const [ready, setReady] = useState(false);
  const [shop, setShop] = useState(false); // the shop PC serves the library (Windows program)
  useEffect(() => {
    Promise.all([loadIndex(), serverLibrary()]).then(([i, s]) => {
      setIndex(i);
      setShop(s);
      setReady(true);
    });
  }, []);

  const inLibrary = new Set(docs.map((d) => d.file.toLowerCase()));
  const extras = ready ? findManuals(index, brand, model).filter((f) => !inLibrary.has(f.name.toLowerCase())) : [];
  const sep = root.includes("/") ? "/" : "\\";

  return (
    <div className="space-y-3">
      {docs.length === 0 && extras.length === 0 && (
        <p className="muted text-sm">
          No manual for the {model} in the shop library.{" "}
          <Link href={`/scan?brand=${encodeURIComponent(brand)}&model=${encodeURIComponent(model)}`} className="link">
            Scan a paper one
          </Link>
          .
        </p>
      )}
      {docs.length > 0 && (
        <ul className="divide-y divide-line">
          {docs.map((d) => {
            const full = `${root.replace(/[\\/]+$/, "")}${sep}${sep === "/" ? d.path.split("\\").join("/") : d.path}`;
            const local = ready ? (findByPath(index, d.path) ?? (shop ? { path: SERVER_PREFIX + d.path } : undefined)) : undefined;
            return (
              <li key={d.path} className="py-2">
                <div className="flex items-start gap-3">
                  <FileText size={16} className="mt-0.5 shrink-0 text-ink-2" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold break-all">{d.file}</span>
                      {d.docType && <span className="pill tone-neutral">{d.docType.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>}
                    </div>
                    <div className="muted text-xs">{[d.pages ? `${d.pages} pages` : "", size(d.sizeBytes)].filter(Boolean).join(" · ")}</div>
                    {d.withdrawnWhy && (
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <span className="pill tone-bad">{d.withdrawnWhy === "copyright" ? "Removed from the repository after a copyright notice" : "Withdrawn from the repository"}</span>
                        {shop && (
                          <ActionButton action={deleteWithdrawnCopy.bind(null, d.path)} className="btn btn-sm btn-danger" confirm="Delete this copy from the library?" success="Copy deleted">
                            Delete my copy
                          </ActionButton>
                        )}
                      </div>
                    )}
                    <div className="mt-1 flex items-center gap-1">
                      <code className="mono min-w-0 flex-1 truncate rounded bg-surface-2 px-1.5 py-0.5 text-xs" title={full}>
                        {full}
                      </code>
                      <button type="button" className="btn btn-sm" onClick={() => copy(full)} aria-label="Copy path">
                        <Copy size={12} aria-hidden />
                      </button>
                    </div>
                  </div>
                  {local && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => openLocal(local.path).catch((e) => toast.error(String(e?.message ?? e)))}
                    >
                      Open <ExternalLink size={12} aria-hidden />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {extras.length > 0 && (
        <div>
          <div className="label mb-1">Also on this PC</div>
          <ul className="divide-y divide-line">
            {extras.map((f) => (
              <li key={f.path} className="flex items-center gap-3 py-2">
                <FileText size={16} className="shrink-0 text-ink-2" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm" title={f.path}>
                  {f.name}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => openLocal(f.path).catch((e) => toast.error(String(e?.message ?? e)))}>
                  Open <ExternalLink size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ready && !index && !shop && docs.length > 0 && (
        <p className="muted text-xs">
          To open these straight from this PC, <Link href="/manuals" className="link">connect the manuals folder</Link> ({root}).
        </p>
      )}
    </div>
  );
}
