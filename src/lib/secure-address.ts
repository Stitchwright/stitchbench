// The program's own https address for the shop's tablets and phones (HANDOFF item 11). Browsers allow the barcode camera
// and the clipboard only on a secure page; a tablet on plain http://<pc>:3100 can't use them. The Windows program sets
// SECURE_URL from its settings file (secureUrl: the tray's Tailscale item or a certificate the shop installed); the app
// layout puts it in a <meta> tag and the client side (src/components/secure-page.tsx) names it when a feature needs a
// secure page. Not PUBLIC_URL: that is the customers' address and serves only the public pages.

export const SECURE_ADDRESS_META = "stitch-secure-address";

/** SECURE_URL checked (https, host only, no trailing slash), or null. Hosted installs are https already and leave it unset. */
export function secureAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const text = (env.SECURE_URL ?? "").trim();
  if (!text) return null;
  try {
    const u = new URL(text);
    if (u.protocol !== "https:" || u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}
