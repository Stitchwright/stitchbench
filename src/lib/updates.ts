import "server-only";
// "A new version is ready" (docs/plans/ease-of-use-design.md section 1): the installed program asks the hub for the
// latest release of its own program, at most every 6 hours, and compares it with the version it is running.
// Hosted services (Railway deploys them) and development never ask. Offline or any failure means no banner.
import { hubDefaultUrl } from "@/lib/hub";
import { isDesktop } from "@/lib/modules";
import { appName, programVersion } from "@/lib/shops";

export type NewVersion = { version: string; notes: string[] };

const EVERY_MS = 6 * 60 * 60 * 1000;
let cache: { at: number; value: NewVersion | null } | null = null;

function parts(v: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec((v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True only when `a` is a newer x.y.z than `b`. */
export function isNewerVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

let asking: Promise<void> | null = null;

/**
 * The newer release the hub offers this installed program, or null (not the installed program, up to date, offline,
 * or not known yet). Never waits for the hub: the page shows what was last heard, and a stale answer is refreshed in
 * the background, so a slow or unreachable hub never slows a page down.
 */
export async function newVersionReady(): Promise<NewVersion | null> {
  if (!isDesktop()) return null;
  if (!cache || Date.now() - cache.at >= EVERY_MS) asking ??= ask().finally(() => (asking = null));
  return cache?.value ?? null;
}

async function ask(): Promise<void> {
  const running = programVersion();
  let value: NewVersion | null = null;
  try {
    const flavor = appName() === "StitchShop" ? "stitchshop" : "stitchbench";
    const res = await fetch(`${hubDefaultUrl()}/v1/releases/latest?flavor=${flavor}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown; notes?: unknown };
      const version = typeof body.version === "string" ? body.version : "";
      if (isNewerVersion(version, running)) {
        const notes = Array.isArray(body.notes) ? body.notes.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim().slice(0, 200)) : [];
        value = { version, notes: notes.slice(0, 3) };
      }
    }
  } catch {
    // Offline or the hub is down: no banner, and try again in 6 hours (not on every page).
  }
  cache = { at: Date.now(), value };
}
