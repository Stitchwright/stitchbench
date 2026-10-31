import "server-only";
// How this program talks to StitchHub's v2 routes (see sync.ts): the X-Client header, the company named by X-Shop-Ref.
import { hubFetch } from "@/lib/hub";
import pkg from "../../../package.json";

/** The X-Client value: this program and its version (semver, as the hub's minimum-version check reads it). */
export function clientId(): string {
  const v = process.env.STITCH_VERSION?.trim();
  const version = v && /^\d+\.\d+\.\d+/.test(v) ? v : pkg.version;
  return `stitchshop/${version}`;
}
export const clientVersion = () => clientId().split("/")[1];

export const v2 = (shopId: string, path: string, init: { method?: string; json?: unknown } = {}) => hubFetch(path, { ...init, shopRef: shopId, headers: { "X-Client": clientId() } });
export const backoff = (tries: number) => new Date(Date.now() + Math.min(2 ** Math.min(tries, 12), 60) * 60_000);
export const plain = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.").slice(0, 300);

