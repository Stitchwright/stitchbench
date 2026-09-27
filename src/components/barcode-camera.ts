"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Detector = { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> };

/** How long a code has to be out of the camera's view before seeing it again counts as a new scan. */
const REPEAT_GAP_MS = 1500;

/**
 * Read barcodes with the phone / tablet / webcam camera. USB and Bluetooth scanners don't need this: they type the
 * code and press Enter. `onCode` always sees the latest state of the page (it isn't frozen when the camera starts).
 * A code held in view is reported once, however long it stays there; it is reported again only after it has been out
 * of view for a moment, so the next identical item on a shelf still counts.
 */
export function useBarcodeCamera(onCode: (code: string) => void) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const handler = useRef(onCode);
  const seen = useRef({ code: "", at: 0 });
  useEffect(() => {
    handler.current = onCode;
  });
  useEffect(() => () => stopRef.current?.(), []);

  // The decoders see the same code several times a second for as long as it's in front of the lens. The time of the
  // last sighting is kept even when the sighting is dropped, so "still in view" never turns into "scanned again".
  function report(code: string) {
    const now = Date.now();
    const stillInView = code === seen.current.code && now - seen.current.at < REPEAT_GAP_MS;
    seen.current = { code, at: now };
    if (!stillInView) handler.current(code);
  }

  async function start() {
    // Browsers only hand the camera to a secure page: https, or the shop PC's own window. A phone on the shop's plain
    // http address gets told so, instead of a cryptic error.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      toast.error("The camera only works on an https address or on the shop PC itself. Here, use a USB or Bluetooth scanner, or type the code.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const v = video.current!;
      v.srcObject = stream;
      await v.play();
      setOn(true);
      let stopped = false;
      const Native = (window as unknown as { BarcodeDetector?: new (o: object) => Detector }).BarcodeDetector;
      if (Native) {
        const det = new Native({ formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code", "data_matrix"] });
        const tick = async () => {
          if (stopped) return;
          try {
            const found = await det.detect(v);
            if (found[0]?.rawValue) report(found[0].rawValue);
          } catch {
            /* keep looking */
          }
          setTimeout(tick, 250);
        };
        tick();
        stopRef.current = () => {
          stopped = true;
          stream.getTracks().forEach((t) => t.stop());
          setOn(false);
        };
      } else {
        // Chrome on Windows and Safari on iPhone have no built-in barcode reader: use ZXing.
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromVideoElement(v, (res) => {
          if (res && !stopped) report(res.getText());
        });
        stopRef.current = () => {
          stopped = true;
          controls.stop();
          stream.getTracks().forEach((t) => t.stop());
          setOn(false);
        };
      }
    } catch (e) {
      toast.error(e instanceof Error ? `Camera: ${e.message}` : "Couldn't start the camera.");
    }
  }

  return { video, on, start, stop: () => stopRef.current?.() };
}

/** A short beep: high for found, low for not found. */
export function beep(ok: boolean) {
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
