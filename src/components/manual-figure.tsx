"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ImageIcon, ExternalLink, X } from "lucide-react";
import { findByName, getLocalFile, loadIndex, openLocal, type LibraryIndex } from "@/lib/local-manuals";

// The figure is drawn in this browser from the tech's own copy of the manual, so no
// OEM page image is ever stored on or sent to the server. Drawn only when asked for,
// because a service manual can be tens of megabytes.

type PdfDoc = { getPage(n: number): Promise<PdfPage>; numPages: number };
type PdfPage = {
  getViewport(o: { scale: number; offsetX?: number; offsetY?: number }): { width: number; height: number };
  render(o: { canvas: HTMLCanvasElement; viewport: unknown }): { promise: Promise<void> };
};

const docs = new Map<string, Promise<PdfDoc>>();
let indexPromise: Promise<LibraryIndex | undefined> | null = null;

async function loadDoc(path: string): Promise<PdfDoc> {
  let p = docs.get(path);
  if (!p) {
    p = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const data = new Uint8Array(await (await getLocalFile(path)).arrayBuffer());
      return (await pdfjs.getDocument({ data }).promise) as unknown as PdfDoc;
    })();
    docs.set(path, p);
    p.catch(() => docs.delete(path));
  }
  return p;
}

async function draw(canvas: HTMLCanvasElement, path: string, pageNo: number, box: number[], width: number) {
  const doc = await loadDoc(path);
  const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
  const [x0, y0, x1, y1] = box.length === 4 ? box : [0, 0, 1, 1];
  const base = page.getViewport({ scale: 1 });
  const scale = (width * (window.devicePixelRatio || 1)) / ((x1 - x0) * base.width);
  const full = page.getViewport({ scale });
  const vp = page.getViewport({ scale, offsetX: -x0 * full.width, offsetY: -y0 * full.height });
  canvas.width = Math.round((x1 - x0) * full.width);
  canvas.height = Math.round((y1 - y0) * full.height);
  canvas.style.width = `${width}px`;
  await page.render({ canvas, viewport: vp }).promise;
}

export function ManualFigure({ file, page, box, width = 440 }: { file: string; page: number | null; box: number[]; width?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [path, setPath] = useState<string | null | undefined>(undefined); // undefined = still looking
  const [state, setState] = useState<"closed" | "drawing" | "open" | "error">("closed");
  const [whole, setWhole] = useState(false);

  useEffect(() => {
    indexPromise ??= loadIndex();
    indexPromise.then((i) => setPath(findByName(i, file)?.path ?? null));
  }, [file]);

  if (path === undefined || !page) return null;
  if (path === null)
    return (
      <p className="muted text-xs">
        Figure: {file}, p. {page}. That manual isn&apos;t in your manuals folder.
      </p>
    );

  function show(fullPage: boolean) {
    setWhole(fullPage);
    setState("drawing");
    // wait a frame so the canvas is in the DOM
    requestAnimationFrame(() =>
      draw(canvas.current!, path!, page!, fullPage ? [] : box, fullPage ? Math.max(width, 640) : width)
        .then(() => setState("open"))
        .catch((e) => {
          setState("error");
          toast.error(e instanceof Error ? e.message : "Could not draw that page from your manual.");
        }),
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {state === "closed" || state === "error" ? (
          <button type="button" className="btn btn-sm" onClick={() => show(false)}>
            <ImageIcon size={12} aria-hidden /> Show figure
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-sm" onClick={() => setState("closed")}>
              <X size={12} aria-hidden /> Hide figure
            </button>
            {box.length === 4 && (
              <button type="button" className="btn btn-sm" onClick={() => show(!whole)}>
                {whole ? "Zoom to figure" : "Whole page"}
              </button>
            )}
          </>
        )}
        <button type="button" className="link text-xs" onClick={() => openLocal(path, page).catch((e) => toast.error(String(e?.message ?? e)))}>
          Open p. {page} <ExternalLink size={10} className="inline" aria-hidden />
        </button>
      </div>
      {state === "drawing" && <p className="muted text-xs">Drawing page {page} from your manual...</p>}
      <canvas
        ref={canvas}
        className={`max-w-full rounded border border-line bg-white ${state === "open" || state === "drawing" ? "" : "hidden"}`}
        aria-label={`Figure from ${file}, page ${page}`}
      />
    </div>
  );
}
