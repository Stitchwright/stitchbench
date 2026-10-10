"use client";
// "A new version is ready" (ease-of-use-design.md section 1): owners and admins, installed program only (the layout
// decides both). Update now is a program link the program's own window catches; any other browser is told to use the
// shop's main computer. Later hides it for 3 days on this device. Not on print views.
import { useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

const KEY = "update-banner-later-until";
const DAYS_3 = 3 * 24 * 60 * 60 * 1000;
const noSubscribe = () => () => {};

function readLater(version: string): number {
  try {
    return Number(localStorage.getItem(`${KEY}:${version}`) ?? "0");
  } catch {
    return 0;
  }
}

export function UpdateBanner({ program, version, notes }: { program: string; version: string; notes: string[] }) {
  const pathname = usePathname();
  // Read in the browser only (the server render shows nothing): no flash of the banner for someone who said Later.
  const inProgram = useSyncExternalStore(noSubscribe, () => navigator.userAgent.includes("Electron"), () => false);
  const asked = useSyncExternalStore(noSubscribe, () => readLater(version) > Date.now(), () => true);
  const [dismissed, setDismissed] = useState(false);
  const hidden = dismissed || asked;

  if (hidden || /\/print(\/|$)/.test(pathname ?? "")) return null;

  function later() {
    try {
      localStorage.setItem(`${KEY}:${version}`, String(Date.now() + DAYS_3));
    } catch {
      /* private window: it just comes back next time */
    }
    setDismissed(true);
  }

  return (
    <div className="no-print card card-pad tone-ready mb-4 space-y-3" role="status" data-testid="update-banner">
      <p className="text-lg font-semibold">A new version of {program} is ready.</p>
      {notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-6 text-base">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-4">
        {inProgram ? (
          <a href="/program/update" className="btn btn-primary btn-lg" data-testid="update-now">
            Update now
          </a>
        ) : (
          <p className="text-base">To update, use {program} on the shop&apos;s main computer.</p>
        )}
        <button type="button" className="link min-h-12 px-2 text-sm" onClick={later}>
          Later
        </button>
      </div>
    </div>
  );
}
