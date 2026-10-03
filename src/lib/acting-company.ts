import "server-only";
// Which company on this install is acting right now, for the hub. A hosted StitchBench serves several companies through
// one install key, so every hub call made for a signed-in person goes out with `X-Shop-Ref: <shopId>` (the hub then
// stores the company with the row, shows its name, limits writes per company and refuses a change to another company's
// row). safe() (src/lib/action.ts) sets it for the whole of a server action from the signed-in user; hubFetch reads it.
// Background work (a sync, a worker) runs with no company, as the hub expects of an install speaking for itself.
// Kept on globalThis so the actions, the pages and the hub module (which Next may load as separate copies) share it.
import { AsyncLocalStorage } from "node:async_hooks";

const store = ((globalThis as unknown as { __actingCompany?: AsyncLocalStorage<string> }).__actingCompany ??= new AsyncLocalStorage<string>());

/** Runs `fn` as this company: hub calls inside carry it. No company (null): as the install itself. */
export function asCompany<T>(shopId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return shopId ? store.run(shopId, fn) : store.exit(fn);
}

/** The company acting now (null in background work and public pages). */
export function actingCompany(): string | null {
  return store.getStore() ?? null;
}
