"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PDFDocument } from "pdf-lib";
import { Camera, ImagePlus, FileUp, RotateCw, ArrowLeft, ArrowRight, Trash2 } from "lucide-react";
import { DOC_TYPES } from "@/lib/constants";
import { saveToLibrary } from "@/lib/local-manuals";

type PageImg = { id: string; file: File; url: string; rotate: number };

const clean = (s: string) => s.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-");

async function renderPage(p: PageImg, enhance: boolean): Promise<Uint8Array> {
  const bmp = await createImageBitmap(p.file);
  const maxSide = 2000;
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const turned = p.rotate % 180 !== 0;
  const canvas = document.createElement("canvas");
  canvas.width = turned ? h : w;
  canvas.height = turned ? w : h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // "Document" look for phone photos: grey, more contrast, a bit brighter.
  if (enhance) ctx.filter = "grayscale(1) contrast(1.35) brightness(1.08)";
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((p.rotate * Math.PI) / 180);
  ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
  bmp.close();
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode a page."))), "image/jpeg", 0.8));
  return new Uint8Array(await blob.arrayBuffer());
}

export function Scanner({ brands, initialBrand, initialModel }: { brands: string[]; initialBrand: string; initialModel: string }) {
  const [pages, setPages] = useState<PageImg[]>([]);
  const [pdf, setPdf] = useState<File | null>(null);
  const [brand, setBrand] = useState(initialBrand);
  const [model, setModel] = useState(initialModel);
  const [docType, setDocType] = useState("ServiceManual");
  const [year, setYear] = useState("");
  const [enhance, setEnhance] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  function addImages(list: FileList | null) {
    if (!list) return;
    const next = Array.from(list)
      .filter((f) => f.type.startsWith("image/"))
      .map((f) => {
        const url = URL.createObjectURL(f);
        urls.current.push(url);
        return { id: crypto.randomUUID(), file: f, url, rotate: 0 };
      });
    setPdf(null);
    setPages((p) => [...p, ...next]);
  }

  function move(i: number, d: number) {
    setPages((p) => {
      const j = i + d;
      if (j < 0 || j >= p.length) return p;
      const c = [...p];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  }

  const filename = `${[clean(brand) || "Brand", clean(model) || "Model", docType, clean(year)].filter(Boolean).join("_")}.pdf`;

  async function save() {
    if (!brand.trim() || !model.trim()) {
      toast.error("Enter the brand and model so the manual matches machines.");
      return;
    }
    setBusy("Building PDF...");
    try {
      let blob: Blob;
      if (pdf) {
        blob = pdf;
      } else {
        const doc = await PDFDocument.create();
        doc.setTitle(`${brand} ${model} ${docType}`);
        doc.setProducer("StitchBench scanner");
        for (let i = 0; i < pages.length; i++) {
          setBusy(`Page ${i + 1} of ${pages.length}...`);
          const jpg = await doc.embedJpg(await renderPage(pages[i], enhance));
          const width = 612; // US letter width in points; height follows the photo
          const height = (jpg.height / jpg.width) * width;
          doc.addPage([width, height]).drawImage(jpg, { x: 0, y: 0, width, height });
        }
        blob = new Blob([(await doc.save()) as BlobPart], { type: "application/pdf" });
      }
      setBusy("Saving...");
      const r = await saveToLibrary(blob, brand.trim(), filename);
      toast.success(r.saved === "library" ? `Saved to your manuals folder: ${r.path}` : `Downloaded ${r.path}. Move it into your manuals folder.`);
      setPages([]);
      setPdf(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the PDF.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="card card-pad space-y-4">
        <div className="flex flex-wrap gap-2">
          <input id="cam" type="file" accept="image/*" capture="environment" multiple className="sr-only" onChange={(e) => (addImages(e.target.files), (e.target.value = ""))} />
          <label htmlFor="cam" className="btn btn-primary cursor-pointer">
            <Camera size={14} aria-hidden /> Take photos
          </label>
          <input id="imgs" type="file" accept="image/*" multiple className="sr-only" onChange={(e) => (addImages(e.target.files), (e.target.value = ""))} />
          <label htmlFor="imgs" className="btn cursor-pointer">
            <ImagePlus size={14} aria-hidden /> Add scanned images
          </label>
          <input
            id="pdfin"
            type="file"
            accept="application/pdf"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setPages([]);
                setPdf(f);
              }
              e.target.value = "";
            }}
          />
          <label htmlFor="pdfin" className="btn cursor-pointer">
            <FileUp size={14} aria-hidden /> File a PDF from the scanner
          </label>
        </div>
        <p className="muted text-sm">
          Tips: lay the page flat in good light, fill the frame, one page per photo. Photos stay on this device until you save.
        </p>
      </section>

      {pdf && (
        <section className="card card-pad">
          <p>
            Filing <strong>{pdf.name}</strong> ({(pdf.size / 1048576).toFixed(1)} MB) under a standard name.
          </p>
        </section>
      )}

      {pages.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="h2">
              {pages.length} page{pages.length === 1 ? "" : "s"}
            </h2>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="check" checked={enhance} onChange={(e) => setEnhance(e.target.checked)} />
              Document look (grey, sharper)
            </label>
          </div>
          <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {pages.map((p, i) => (
              <li key={p.id} className="card overflow-hidden">
                <div className="flex aspect-[3/4] items-center justify-center overflow-hidden bg-surface-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
                  <img
                    src={p.url}
                    alt={`Page ${i + 1}`}
                    className="max-h-full max-w-full"
                    style={{ transform: `rotate(${p.rotate}deg)`, filter: enhance ? "grayscale(1) contrast(1.35) brightness(1.08)" : undefined }}
                  />
                </div>
                <div className="flex items-center justify-between gap-1 px-1 py-1">
                  <span className="num text-xs font-semibold">{i + 1}</span>
                  <span className="flex gap-1">
                    <button type="button" className="btn btn-sm" onClick={() => move(i, -1)} aria-label="Move earlier">
                      <ArrowLeft size={12} />
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => move(i, 1)} aria-label="Move later">
                      <ArrowRight size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setPages((ps) => ps.map((x) => (x.id === p.id ? { ...x, rotate: (x.rotate + 90) % 360 } : x)))}
                      aria-label="Rotate"
                    >
                      <RotateCw size={12} />
                    </button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => setPages((ps) => ps.filter((x) => x.id !== p.id))} aria-label="Remove page">
                      <Trash2 size={12} />
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {(pages.length > 0 || pdf) && (
        <section className="card card-pad space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="field">
              <label htmlFor="s-brand" className="label">
                Brand
              </label>
              <input id="s-brand" list="s-brands" value={brand} onChange={(e) => setBrand(e.target.value)} className="input" />
              <datalist id="s-brands">
                {brands.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label htmlFor="s-model" className="label">
                Model(s)
              </label>
              <input id="s-model" value={model} onChange={(e) => setModel(e.target.value)} className="input" placeholder="PR655+PR650" />
            </div>
            <div className="field">
              <label htmlFor="s-type" className="label">
                Document type
              </label>
              <select id="s-type" value={docType} onChange={(e) => setDocType(e.target.value)} className="select">
                {DOC_TYPES.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="s-year" className="label">
                Year (optional)
              </label>
              <input id="s-year" value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" className="input num" />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              Saves as <span className="mono font-semibold">{filename}</span> in <span className="mono">{clean(brand) || "Brand"}/</span>
            </div>
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={save}>
              {busy ?? "Save PDF to my manuals"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
