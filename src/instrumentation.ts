// Runs once when the StitchBench server starts: keep this install in sync with the community hub, and (more often)
// with its partner shops, whose repair status and orders people are waiting on; and send the messages that are due.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { hubTimer?: NodeJS.Timeout; partnerTimer?: NodeJS.Timeout; messageTimer?: NodeJS.Timeout };
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
  if (process.env.MESSAGES !== "off") {
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
  }
}
