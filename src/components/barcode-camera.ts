"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Detector = { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> };

/**
 * Read barcodes with the phone / tablet / webcam camera. USB and Bluetooth scanners don't need this: they type the
 * code and press Enter. `onCode` always sees the latest state of the page (it isn't frozen when the camera starts).
 */
export function useBarcodeCamera(onCode: (code: string) => void) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const handler = useRef(onCode);
  useEffect(() => {
    handler.current = onCode;
  });
  useEffect(() => () => stopRef.current?.(), []);

  async function start() {
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
            if (found[0]?.rawValue) handler.current(found[0].rawValue);
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
          if (res && !stopped) handler.current(res.getText());
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
