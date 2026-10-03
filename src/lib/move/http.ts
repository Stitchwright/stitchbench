// The move file goes over https, or stays on the program's own PC (company-move-design.md section 8): the download
// route, the hosted upload routes and the Windows program's PC door share these.
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostOf(req: Request): string {
  const u = new URL(req.url);
  return (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host).split(",")[0].trim().replace(/:\d+$/, "").toLowerCase();
}

/** The request was addressed to this PC itself (localhost, 127.0.0.1). */
export function localRequest(req: Request): boolean {
  return LOCAL.has(hostOf(req));
}

/** https (the request's own scheme, or the proxy's X-Forwarded-Proto on a hosted install), or the PC itself. */
export function secureRequest(req: Request): boolean {
  const u = new URL(req.url);
  const proto = (req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "")).split(",")[0].trim().toLowerCase();
  return proto === "https" || localRequest(req);
}
