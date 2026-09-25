// Runs once when the StitchBench server starts: keep this install in sync with the community hub.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { hubTimer?: NodeJS.Timeout };
  if (g.hubTimer) return;
  const { syncHub } = await import("@/lib/hub");
  const run = () => syncHub().catch((e) => console.error("community hub sync:", e instanceof Error ? e.message : e));
  setTimeout(run, 20_000);
  g.hubTimer = setInterval(run, 10 * 60_000);
}
