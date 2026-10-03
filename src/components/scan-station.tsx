"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Camera, CameraOff } from "lucide-react";
import { saveCounts, scanCode, type ScanResult, type ScannedPart } from "@/actions/scan";
import { beep, CAMERA_INSTEAD, useBarcodeCamera } from "@/components/barcode-camera";
import { InsecureNotice } from "@/components/secure-page";

type Mode = "lookup" | "receive" | "count" | "ticket";
type Ticket = { id: string; label: string };
type LogEntry = { at: number; ok: boolean; text: string; partId?: string; code: string; xpartId?: string | null };

const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: "lookup", label: "Look up", hint: "Scan to see stock and bin." },
  { key: "receive", label: "Receive", hint: "Each scan adds stock." },
  { key: "count", label: "Count shelf", hint: "Scan every item on the shelf, then save the counts. With the camera, point away for a moment between two of the same item." },
  { key: "ticket", label: "Use on ticket", hint: "Each scan puts the part on the ticket and takes it from stock." },
];

/** USB/Bluetooth scanners type the code and press Enter; phones and tablets can use the camera. */
export function ScanStation({ tickets, shopId }: { tickets: Ticket[]; shopId: string }) {
  const [mode, setMode] = useState<Mode>("lookup");
  // Kept as typed ("2." on the way to "2.5"); fabric goes by the yard, so a fraction is a real quantity.
  const [qtyText, setQtyText] = useState("1");
  const qty = Number(qtyText) > 0 ? Number(qtyText) : 1;
  const [ticketId, setTicketId] = useState(tickets[0]?.id ?? "");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [counts, setCounts] = useState<Map<string, { part: ScannedPart; n: number }>>(new Map());
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), [mode]);

  // A shelf count takes a while: it is kept in this tab (a reload, or a click on a log link, brings it back) and
  // closing the tab with counts unsaved asks first. Per company, so another sign-in in the same tab doesn't see it.
  const saved = `stitchbench-scan-count:${shopId}`;
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(saved);
    } catch {
      /* no storage here: the count just isn't kept */
    }
    if (!raw) return;
    const stored = raw;
    queueMicrotask(() => {
      try {
        setCounts(new Map(JSON.parse(stored) as [string, { part: ScannedPart; n: number }][]));
      } catch {
        /* not a count of ours */
      }
    });
  }, [saved]);
  useEffect(() => {
    if (!counts.size) return;
    try {
      sessionStorage.setItem(saved, JSON.stringify([...counts]));
    } catch {
      /* no storage here */
    }
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [counts, saved]);

  async function handle(raw: string) {
    const code = raw.trim();
    if (!code) return;
    setBusy(true);
    try {
      const r: ScanResult = await scanCode(code, mode === "count" ? "lookup" : mode, qty, ticketId);
      if (r.ok && mode === "count" && r.part.unit === "yd") {
        // Fabric is counted in yards, not bolts: this scan doesn't count.
        setLog((l) => [{ at: Date.now(), ok: false, text: `${r.part.partNumber} is sold by the yard: enter its yardage on the item page (Count)`, code, partId: r.part.id }, ...l].slice(0, 50));
        beep(false);
        return;
      }
      if (r.ok && mode === "count" && r.part.consigned) {
        // A partner's consigned stock is counted by the partner (saveCounts skips it).
        setLog((l) => [{ at: Date.now(), ok: false, text: `${r.part.partNumber} is a partner's consigned stock: it isn't counted here`, code, partId: r.part.id }, ...l].slice(0, 50));
        beep(false);
        return;
      }
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

  // Scans are handled one after another, in order: a handheld scanner can fire them faster than the server answers.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const enqueue = (code: string) => {
    queue.current = queue.current.then(() => handle(code));
  };
  // The camera reports a code once while it's in view (see useBarcodeCamera), so every code that arrives counts, as
  // does every handheld scan.
  const { video: camVideo, on: camOn, page: camPage, start: camStart, stop: camStop } = useBarcodeCamera(enqueue);

  async function save() {
    const r = await saveCounts([...counts.values()].map((c) => ({ partId: c.part.id, qty: c.n })));
    if ("error" in r) toast.error(r.error);
    else {
      toast.success(`Saved ${r.saved} count${r.saved === 1 ? "" : "s"}`);
      setCounts(new Map());
      try {
        sessionStorage.removeItem(saved);
      } catch {
        /* no storage here */
      }
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
          enqueue(v);
        }}
      >
        <div className="field min-w-64 flex-1">
          <label htmlFor="scan-code" className="label">
            Scan or type a part number
          </label>
          <input id="scan-code" ref={input} autoComplete="off" autoFocus className="input mono text-lg" placeholder="Scan here" aria-busy={busy} />
        </div>
        {(mode === "receive" || mode === "ticket") && (
          <div className="field w-24">
            <label htmlFor="scan-qty" className="label">
              Qty each
            </label>
            <input id="scan-qty" type="number" min={0.125} step="any" inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} className="input num" />
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
        <button type="button" className="btn" onClick={() => (camOn ? camStop() : camStart())}>
          {camOn ? <CameraOff size={14} aria-hidden /> : <Camera size={14} aria-hidden />} {camOn ? "Stop camera" : "Use camera"}
        </button>
      </form>
      <InsecureNotice what="The camera" instead={CAMERA_INSTEAD} page={camPage} />
      <video ref={camVideo} className={camOn ? "w-full max-w-md rounded border border-line" : "hidden"} muted playsInline aria-label="Camera" />

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
