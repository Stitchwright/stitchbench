"use client";

import "./globals.css";
import { useEffect } from "react";
import { reportBrowserError } from "@/actions/help";

// The last resort when even the app's frame fails: a plain page with a way back in.
export default function GlobalError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  // The error alert for the hub (help-feedback-design.md 2); dropped when nobody is signed in.
  useEffect(() => {
    void reportBrowserError({
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      source: "page",
      path: window.location.pathname,
      userAgent: navigator.userAgent,
      screen: `${window.innerWidth}x${window.innerHeight}`,
    }).catch(() => {});
  }, [error]);
  return (
    <html lang="en">
      <body className="min-h-full p-6">
        <div className="card card-pad max-w-xl space-y-3">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="muted text-sm">
            Check the connection to the shop computer and try again{error.digest ? ` (error ${error.digest})` : ""}.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => unstable_retry()}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
