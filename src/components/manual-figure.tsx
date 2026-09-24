"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ImageIcon, ExternalLink, X } from "lucide-react";
import { findByPath, getLocalFile, loadIndex, openLocal, type LibraryIndex } from "@/lib/local-manuals";

// Figures show from the server when they've been saved (any device, any browser).
// Otherwise they're drawn here from the tech's own copy of the manual and then saved,
// so the next person, e.g. on a phone on the route, sees them without the manuals folder.

type PdfDoc = { getPage(n: number): Promise<PdfPage>; numPages: number };
type PdfPage = {
  getViewport(o: { scale: number; offsetX?: number; offsetY?: number }): { width: number; height: number };
  render(o: { canvas: HTMLCanvasElement | null; canvasContext?: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
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
      // Plain 2D-canvas rendering (no OffscreenCanvas / ImageDecoder).
      return (await pdfjs.getDocument({ data, isOffscreenCanvasSupported: false, isImageDecoderSupported: false }).promise) as unknown as PdfDoc;
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
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvas: null, canvasContext: ctx, viewport: vp }).promise;
}

/** Keep a copy of a figure drawn from a local manual, so other devices can show it. */
function saveOnline(canvas: HTMLCanvasElement, sourcePath: string, page: number, box: number[]) {
  canvas.toBlob(
    (blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.set("sourcePath", sourcePath);
      fd.set("page", String(page));
      fd.set("box", JSON.stringify(box));
      fd.set("width", String(canvas.width));
      fd.set("height", String(canvas.height));
      fd.set("file", blob, "figure.jpg");
      fetch("/api/figures", { method: "POST", body: fd }).catch(() => {});
    },
    "image/jpeg",
    0.7,
  );
}

export function ManualFigure({
  file,
  sourcePath,
  page,
  box,
  figureId,
  stored,
  width = 440,
}: {
  file: string;
  sourcePath: string | null;
  page: number | null;
  box: number[];
  figureId?: string | null;
  stored?: boolean;
  width?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [path, setPath] = useState<string | null | undefined>(undefined); // local file; undefined = still looking
  const [state, setState] = useState<"closed" | "drawing" | "open" | "error">("closed");
  const [whole, setWhole] = useState(false);
  const [showStored, setShowStored] = useState(false);

  useEffect(() => {
    indexPromise ??= loadIndex();
    indexPromise.then((i) => setPath(findByPath(i, sourcePath ?? file)?.path ?? null));
  }, [file, sourcePath]);

  if (!page) return null;

  function show(fullPage: boolean) {
    if (!path) return;
    setWhole(fullPage);
    setState("drawing");
    requestAnimationFrame(() =>
      draw(canvas.current!, path, page!, fullPage ? [] : box, fullPage ? Math.max(width, 640) : width)
        .then(() => {
          setState("open");
          if (!fullPage && !stored && sourcePath) saveOnline(canvas.current!, sourcePath, page!, box);
        })
        .catch((e) => {
          setState("error");
          toast.error(e instanceof Error ? e.message : "Could not draw that page from your manual.");
        }),
    );
  }

  const openPage = path ? (
    <button type="button" className="link text-xs" onClick={() => openLocal(path, page).catch((e) => toast.error(String(e?.message ?? e)))}>
      Open p. {page} <ExternalLink size={10} className="inline" aria-hidden />
    </button>
  ) : null;

  // Saved online: works on any device.
  if (stored && figureId) {
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-sm" onClick={() => setShowStored((v) => !v)}>
            {showStored ? <X size={12} aria-hidden /> : <ImageIcon size={12} aria-hidden />} {showStored ? "Hide figure" : "Show figure"}
          </button>
          {path && state !== "drawing" && (
            <button type="button" className="btn btn-sm" onClick={() => (state === "open" ? setState("closed") : show(true))}>
              {state === "open" ? "Close page" : "Whole page"}
            </button>
          )}
          {openPage}
        </div>
        {showStored && (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated image route
          <img src={`/api/figures/${figureId}`} alt={`Figure from ${file}, page ${page}`} className="max-w-full rounded border border-line bg-white" style={{ width }} />
        )}
        <canvas ref={canvas} className={`max-w-full rounded border border-line bg-white ${state === "open" || state === "drawing" ? "" : "hidden"}`} aria-label={`Page ${page} of ${file}`} />
      </div>
    );
  }

  if (path === undefined) return null;
  if (path === null)
    return (
      <p className="muted text-xs">
        Figure: {file}, p. {page}. It will show here once someone opens it on a PC that has this manual.
      </p>
    );

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
        {openPage}
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
