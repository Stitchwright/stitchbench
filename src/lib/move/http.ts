// The move file goes over https, or stays on the program's own PC (company-move-design.md section 8): the download
// route, the hosted upload routes and the Windows program's PC door share these.
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// The X-Forwarded-* headers only from a proxy we trust (TRUST_PROXY=true, hosted): otherwise whoever sends the request
// writes them, a page on another site too (a DNS-rebinding page can send X-Forwarded-Host: localhost, not Host).
const trusted = (req: Request, name: string) => (process.env.TRUST_PROXY === "true" ? req.headers.get(name) : null);

function hostOf(req: Request): string {
  const u = new URL(req.url);
  return (trusted(req, "x-forwarded-host") ?? req.headers.get("host") ?? u.host).split(",")[0].trim().replace(/:\d+$/, "").toLowerCase();
}

/** The request was addressed to this PC itself (localhost, 127.0.0.1). */
export function localRequest(req: Request): boolean {
  return LOCAL.has(hostOf(req));
}

/**
 * https (the proxy's X-Forwarded-Proto on a hosted install, else the request's scheme as Next made it, which on the Windows
 * program carries tailscale serve's https), or the PC itself. A device that claims https over plain http only gives up
 * the encryption of its own download.
 */
export function secureRequest(req: Request): boolean {
  const u = new URL(req.url);
  const proto = (trusted(req, "x-forwarded-proto") ?? u.protocol.replace(":", "")).split(",")[0].trim().toLowerCase();
  return proto === "https" || localRequest(req);
}
