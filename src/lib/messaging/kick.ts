import "server-only";
// Nudges the message worker soon after something was queued (scheduling-messaging-design.md section 4.1). A dynamic
// import breaks the worker -> hooks -> queue -> worker cycle. Nothing happens with MESSAGES=off.

type G = { __messageKick?: NodeJS.Timeout | null };
const g = globalThis as unknown as G;

export function kickMessages(): void {
  if (process.env.MESSAGES === "off") return;
  if (g.__messageKick) return;
  g.__messageKick = setTimeout(() => {
    g.__messageKick = null;
    import("./worker")
      .then((w) => w.runMessages())
      .catch((e) => console.error("messages:", e instanceof Error ? e.message : e));
  }, 2_000);
}
