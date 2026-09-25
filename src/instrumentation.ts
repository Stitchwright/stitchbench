// Runs once when the StitchBench server starts: keep this install in sync with the community hub, and (more often)
// with its partner shops, whose repair status and orders people are waiting on.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { hubTimer?: NodeJS.Timeout; partnerTimer?: NodeJS.Timeout };
  if (g.hubTimer) return;
  const { syncHub } = await import("@/lib/hub");
  const { syncPartners } = await import("@/lib/partners");
  const run = () => syncHub().catch((e) => console.error("community hub sync:", e instanceof Error ? e.message : e));
  const partners = () => syncPartners().catch((e) => console.error("partner sync:", e instanceof Error ? e.message : e));
  setTimeout(run, 20_000);
  g.hubTimer = setInterval(run, 10 * 60_000);
  setTimeout(partners, 10_000);
  g.partnerTimer = setInterval(partners, Number(process.env.PARTNER_SYNC_SECONDS ?? 60) * 1000);
}
