import type { Instrumentation } from "next";

/**
 * A page or route that failed on the server: its message and stack are remembered by digest for a few minutes, so when
 * the page's error screen reports the digest (production browsers get nothing more) the error alert carries the real
 * message (help-feedback-design.md 2). Server actions record their own errors in safe().
 */
export const onRequestError: Instrumentation.onRequestError = async (err, _request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs" || context.routeType !== "render") return;
  const e = err as { digest?: string; message?: string; stack?: string };
  const { rememberDigest } = await import("@/lib/help");
  rememberDigest(e.digest, e);
};

// Runs once when the StitchBench server starts: keep this install in sync with the community hub, and (more often)
// with its partner shops, whose repair status and orders people are waiting on; and send the messages that are due.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as {
    hubTimer?: NodeJS.Timeout;
    partnerTimer?: NodeJS.Timeout;
    messageTimer?: NodeJS.Timeout;
    downloadTimer?: NodeJS.Timeout;
    moveSweepTimer?: NodeJS.Timeout;
    auditTimer?: NodeJS.Timeout;
    offsiteTimer?: NodeJS.Timeout;
    eventTimer?: NodeJS.Timeout;
  };
  if (g.hubTimer) return;
  const { syncHub } = await import("@/lib/hub");
  const { syncPartners } = await import("@/lib/partners");
  const run = () => syncHub().catch((e) => console.error("community hub sync:", e instanceof Error ? e.message : e));
  const partners = () => syncPartners().catch((e) => console.error("partner sync:", e instanceof Error ? e.message : e));
  setTimeout(run, 20_000);
  g.hubTimer = setInterval(run, 10 * 60_000);
  setTimeout(partners, 10_000);
  // Blank, a word ("1m") or 0 would make Node run the timer about every millisecond: anything under 10 s means the usual 60.
  const every = Number(process.env.PARTNER_SYNC_SECONDS);
  g.partnerTimer = setInterval(partners, (Number.isFinite(every) && every >= 10 ? every : 60) * 1000);
  // Email and texts (scheduling-messaging-design.md 4.3). MESSAGES=off stops every send path on this server.
  if (!(await import("@/lib/demo-mode")).messagesSwitchedOff()) {
    const { clearStaleOwnLeases } = await import("@/lib/lease");
    await clearStaleOwnLeases().catch(() => {});
    const { runMessages } = await import("@/lib/messaging/worker");
    const { expireStaleOrders } = await import("@/lib/shop/online-shop");
    const messages = () =>
      runMessages()
        .catch((e) => console.error("messages:", e instanceof Error ? e.message : e))
        .then(() => expireStaleOrders())
        .catch((e) => console.error("online shop:", e instanceof Error ? e.message : e));
    setTimeout(messages, 15_000);
    const secs = Number(process.env.MESSAGE_WORKER_SECONDS);
    g.messageTimer = setInterval(messages, (Number.isFinite(secs) && secs >= 2 ? secs : 30) * 1000);
    // Events' "balance due" reminders (shop-features-round-2-design.md 4.5): once an hour is plenty (each is sent once).
    const { runEventReminders } = await import("@/lib/events");
    const reminders = () => runEventReminders().catch((e) => console.error("event reminders:", e instanceof Error ? e.message : e));
    setTimeout(reminders, 60_000);
    g.eventTimer = setInterval(reminders, 3600_000);
  }
  // Manual downloads into the library (HANDOFF item 12), one file at a time. Only where there is a library to download
  // into (LIBRARY_DIR: the Windows program; hosted installs have none), and MANUAL_DOWNLOADS=off stops it anywhere.
  const { libraryDir } = await import("@/lib/library-dir");
  if (process.env.MANUAL_DOWNLOADS !== "off" && libraryDir()) {
    const { runManualDownloads } = await import("@/lib/manual-downloads");
    const downloads = () => runManualDownloads().catch((e) => console.error("manual downloads:", e instanceof Error ? e.message : e));
    setTimeout(downloads, 25_000);
    const dsecs = Number(process.env.MANUAL_DOWNLOAD_SECONDS);
    g.downloadTimer = setInterval(downloads, (Number.isFinite(dsecs) && dsecs >= 5 ? dsecs : 30) * 1000);
  }
  // Company imports (company-move-design.md section 8): uploaded move files left in the temp folder go after a day.
  const { sweepUploads } = await import("@/lib/move/upload");
  const sweep = () => sweepUploads().catch((e) => console.error("move uploads:", e instanceof Error ? e.message : e));
  setTimeout(sweep, 60_000);
  g.moveSweepTimer = setInterval(sweep, 3600_000);
  // The audit log keeps 7 years (sign-ins 1): the clean-up runs once a day, which is all "monthly" needs.
  const { pruneAudit } = await import("@/lib/audit");
  const prune = () => pruneAudit().catch((e) => console.error("audit prune:", e instanceof Error ? e.message : e));
  setTimeout(prune, 90_000);
  g.auditTimer = setInterval(prune, 24 * 3600_000);
  // Off-site backup (later-round-1-design.md 1.4): off for every company until its owner turns it on. Checked every 15
  // minutes and at start (a PC that was off catches up); a company is backed up after 2 am its time, or when overdue.
  if (process.env.OFFSITE !== "off") {
    const { runDueOffsiteBackups } = await import("@/lib/offsite/backup");
    const offsite = () => runDueOffsiteBackups().catch((e) => console.error("off-site backup:", e instanceof Error ? e.message : e));
    setTimeout(offsite, 120_000);
    g.offsiteTimer = setInterval(offsite, 15 * 60_000);
  }
}
