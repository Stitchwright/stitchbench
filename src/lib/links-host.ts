// What the public links address may serve (scheduling-messaging-design.md section 14.2). Pure; the same lists as
// desktop/links-gate.mjs. Used by src/proxy.ts for requests whose Host is PUBLIC_URL's host when PUBLIC_LINKS_ONLY=true.
export const PUBLIC_GET = ["/e/", "/u/", "/api/e/", "/api/u/", "/_next/static/", "/favicon.ico"];
export const PUBLIC_POST = ["/api/e/", "/api/u/"];

/**
 * "pass" for GET / HEAD of a public prefix and POST of a public API prefix; "404" for everything else, including any
 * request carrying a `next-action` header (Next forwards server actions to the worker that owns them, whatever the path).
 */
export function linksHostDecision(method: string, path: string, headers: Headers): "pass" | "404" {
  if (headers.has("next-action")) return "404";
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return PUBLIC_GET.some((p) => path.startsWith(p)) ? "pass" : "404";
  if (m === "POST") return PUBLIC_POST.some((p) => path.startsWith(p)) ? "pass" : "404";
  return "404";
}
