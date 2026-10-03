"use client";

// Features browsers allow only on a secure page (the barcode camera, one-tap copy), seen from the client side: is this
// page secure, and what https address does the shop have? The address comes from the <meta> tag the app layout renders
// from SECURE_URL (src/lib/secure-address.ts); the Windows program's tray fills that in (Tailscale) or the shop sets it
// by hand. Read on the client only: the server doesn't know the browser's address, so the first render says nothing.
import { useSyncExternalStore } from "react";
import { SECURE_ADDRESS_META } from "@/lib/secure-address";

export type SecurePage = { checked: boolean; secure: boolean; address: string | null };

/** The https address the shop has for its tablets and phones, when the page carries one. */
export function secureAddressOnPage(): string | null {
  if (typeof document === "undefined") return null;
  const content = document.querySelector(`meta[name="${SECURE_ADDRESS_META}"]`)?.getAttribute("content") ?? "";
  return content.startsWith("https://") ? content : null;
}

// Browser-only values with a server fallback, hydration-safe: the server (and the first client render) say "not checked".
const never = () => () => {};
export function useSecurePage(): SecurePage {
  const checked = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  const secure = useSyncExternalStore(
    never,
    () => window.isSecureContext,
    () => true,
  );
  const address = useSyncExternalStore(never, secureAddressOnPage, () => null);
  return { checked, secure, address };
}

/**
 * Why a feature doesn't work here, in one or two plain sentences. `what` is the feature ("The camera", "One-tap copy");
 * `instead` is what to do on this page meanwhile.
 */
export function insecureMessage(what: string, instead: string, address: string | null): string {
  const here = `${what} works only on a secure (https) page, and this address is plain http.`;
  if (address) return `${here} Open ${address} on this device instead (bookmark it). ${instead}`;
  return `${here} ${instead} Whoever runs the shop PC can give tablets a secure address: tray icon, "Secure address for tablets (Tailscale)", or see INSTALL.md.`;
}

/** A quiet line under a feature that needs a secure page, shown only when this page isn't one. */
export function InsecureNotice({ what, instead, page }: { what: string; instead: string; page: SecurePage }) {
  if (!page.checked || page.secure) return null;
  return (
    <p className="muted text-xs" role="note">
      {what} works only on a secure (https) page, and this address is plain http.{" "}
      {page.address ? (
        <>
          Open{" "}
          <a className="link" href={page.address + window.location.pathname}>
            {page.address}
          </a>{" "}
          on this device instead (bookmark it).{" "}
        </>
      ) : null}
      {instead}
      {page.address ? null : ' Whoever runs the shop PC can give tablets a secure address: tray icon, "Secure address for tablets (Tailscale)", or see INSTALL.md.'}
    </p>
  );
}
