"use client";

import { useEffect } from "react";
import { reportError } from "@/components/help-button";

// A page that failed to load (a server error, or the connection dropped while the shop PC restarted) shows this inside
// the app, so the menu stays and one click tries again.
export default function AppError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => {
    console.error(error);
    // The error alert for the hub (help-feedback-design.md 2): the server adds the message it kept for this digest.
    reportError({ message: error.message, stack: error.stack, digest: error.digest, source: "page" });
  }, [error]);
  return (
    <div className="card card-pad max-w-xl space-y-3">
      <h1 className="text-lg font-semibold">This page couldn&apos;t load</h1>
      <p className="muted text-sm">
        Check the connection to the shop computer and try again. If it keeps happening, tell whoever looks after this program
        {error.digest ? ` (error ${error.digest})` : ""}.
      </p>
      <button type="button" className="btn btn-primary" onClick={() => unstable_retry()}>
        Try again
      </button>
    </div>
  );
}
