"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Camera, CameraOff } from "lucide-react";
import { saveCounts, scanCode, type ScanResult, type ScannedPart } from "@/actions/scan";

type Mode = "lookup" | "receive" | "count" | "ticket";
type Ticket = { id: string; label: string };
type LogEntry = { at: number; ok: boolean; text: string; partId?: string; code: string; xpartId?: string | null };

const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: "lookup", label: "Look up", hint: "Scan to see stock and bin." },
  { key: "receive", label: "Receive", hint: "Each scan adds stock." },
  { key: "count", label: "Count shelf", hint: "Scan every item on the shelf, then save the counts." },
  { key: "ticket", label: "Use on ticket", hint: "Each scan puts the part on the ticket and takes it from stock." },
];

function beep(ok: boolean) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 1175 : 220;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.09 : 0.3));
  } catch {
    /* sound is optional */
  }
}

type Detector = { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> };

/** USB/Bluetooth scanners type the code and press Enter; phones and tablets can use the camera. */
export function ScanStation({ tickets }: { tickets: Ticket[] }) {
  const [mode, setMode] = useState<Mode>("lookup");
  const [qty, setQty] = useState(1);
  const [ticketId, setTicketId] = useState(tickets[0]?.id ?? "");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [counts, setCounts] = useState<Map<string, { part: ScannedPart; n: number }>>(new Map());
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const last = useRef({ code: "", at: 0 });
  const stopCamera = useRef<(() => void) | null>(null);

  useEffect(() => input.current?.focus(), [mode]);
  useEffect(() => () => stopCamera.current?.(), []);

  async function handle(raw: string) {
    const code = raw.trim();
    if (!code) return;
    // A camera sees the same code many times a second; count it once.
    if (code === last.current.code && Date.now() - last.current.at < 1500) return;
    last.current = { code, at: Date.now() };
    setBusy(true);
    try {
      const r: ScanResult = await scanCode(code, mode === "count" ? "lookup" : mode, qty, ticketId);
      if (r.ok && mode === "count") {
        setCounts((prev) => {
          const next = new Map(prev);
          const cur = next.get(r.part.id);
          next.set(r.part.id, { part: r.part, n: (cur?.n ?? 0) + 1 });
          return next;
        });
      }
      const text = r.ok && mode === "count" ? `Counted ${r.part.partNumber}` : r.message;
      setLog((l) => [{ at: Date.now(), ok: r.ok, text, code, partId: r.ok ? r.part.id : undefined, xpartId: r.ok ? undefined : r.xpart?.id }, ...l].slice(0, 50));
      beep(r.ok);
    } catch (e) {
      beep(false);
      toast.error(e instanceof Error ? e.message : "Scan failed.");
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const v = video.current!;
      v.srcObject = stream;
      await v.play();
      setCamera(true);
      let stopped = false;
      const Native = (window as unknown as { BarcodeDetector?: new (o: object) => Detector }).BarcodeDetector;
      if (Native) {
        const det = new Native({ formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code", "data_matrix"] });
        const tick = async () => {
          if (stopped) return;
          try {
            const found = await det.detect(v);
            if (found[0]?.rawValue) await handle(found[0].rawValue);
          } catch {
            /* keep looking */
          }
          setTimeout(tick, 250);
        };
        tick();
      } else {
        // Chrome on Windows and Safari on iPhone have no built-in barcode reader: use ZXing.
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromVideoElement(v, (res) => {
          if (res && !stopped) handle(res.getText());
        });
        stopCamera.current = () => {
          stopped = true;
          controls.stop();
          stream.getTracks().forEach((t) => t.stop());
          setCamera(false);
        };
        return;
      }
      stopCamera.current = () => {
        stopped = true;
        stream.getTracks().forEach((t) => t.stop());
        setCamera(false);
      };
    } catch (e) {
      toast.error(e instanceof Error ? `Camera: ${e.message}` : "Couldn't start the camera.");
    }
  }

  async function save() {
    const r = await saveCounts([...counts.values()].map((c) => ({ partId: c.part.id, qty: c.n })));
    if ("error" in r) toast.error(r.error);
    else {
      toast.success(`Saved ${r.saved} count${r.saved === 1 ? "" : "s"}`);
      setCounts(new Map());
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Scan mode">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={mode === m.key}
            onClick={() => setMode(m.key)}
            className={`btn btn-sm ${mode === m.key ? "btn-primary" : ""}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="muted text-sm">{MODES.find((m) => m.key === mode)!.hint}</p>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = input.current!.value;
          input.current!.value = "";
          handle(v);
        }}
      >
        <div className="field min-w-64 flex-1">
          <label htmlFor="scan-code" className="label">
            Scan or type a part number
          </label>
          <input id="scan-code" ref={input} autoComplete="off" autoFocus className="input mono text-lg" placeholder="Scan here" disabled={busy} />
        </div>
        {(mode === "receive" || mode === "ticket") && (
          <div className="field w-24">
            <label htmlFor="scan-qty" className="label">
              Qty each
            </label>
            <input id="scan-qty" type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value) || 1)} className="input num" />
          </div>
        )}
        {mode === "ticket" && (
          <div className="field min-w-56">
            <label htmlFor="scan-ticket" className="label">
              Ticket
            </label>
            <select id="scan-ticket" value={ticketId} onChange={(e) => setTicketId(e.target.value)} className="select">
              {tickets.length === 0 && <option value="">No open tickets</option>}
              {tickets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <button className="btn btn-primary">Go</button>
        <button type="button" className="btn" onClick={() => (camera ? stopCamera.current?.() : startCamera())}>
          {camera ? <CameraOff size={14} aria-hidden /> : <Camera size={14} aria-hidden />} {camera ? "Stop camera" : "Use camera"}
        </button>
      </form>
      <video ref={video} className={camera ? "w-full max-w-md rounded border border-line" : "hidden"} muted playsInline aria-label="Camera" />

      {mode === "count" && (
        <div className="card card-pad space-y-2">
          <div className="flex items-center justify-between gap-2">
            <strong>Counted so far ({counts.size} parts)</strong>
            <button type="button" className="btn btn-sm btn-primary" disabled={!counts.size} onClick={save}>
              Save counts
            </button>
          </div>
          <ul className="divide-y divide-line text-sm">
            {[...counts.values()].map(({ part, n }) => (
              <li key={part.id} className="flex items-center justify-between gap-2 py-1">
                <span>
                  <span className="mono">{part.partNumber}</span> {part.description}
                </span>
                <span className="num">
                  counted <strong>{n}</strong> · on record {part.qtyOnHand}
                  {n !== part.qtyOnHand && <span className={`pill ml-1 ${n < part.qtyOnHand ? "tone-bad" : "tone-wait"}`}>{n - part.qtyOnHand > 0 ? "+" : ""}{n - part.qtyOnHand}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card card-pad">
        <strong className="text-sm">Scans</strong>
        {log.length === 0 ? (
          <p className="muted text-sm">Nothing scanned yet.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {log.map((e) => (
              <li key={e.at} className={e.ok ? "" : "text-[var(--bad)]"}>
                {e.ok ? "✓" : "✗"} {e.text}{" "}
                {e.partId && (
                  <Link href={`/parts/${e.partId}`} className="link text-xs">
                    open
                  </Link>
                )}
                {!e.ok && e.xpartId && (
                  <Link href={`/xref/${e.xpartId}`} className="link text-xs">
                    cross-reference
                  </Link>
                )}
                {!e.ok && (
                  <Link href={`/parts?new=${encodeURIComponent(e.code)}#add`} className="link ml-2 text-xs">
                    add as a new part
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
