import "server-only";

/**
 * The address a request came from, as the proxy in front of us saw it (its own entry is the last X-Forwarded-For hop).
 * Null unless TRUST_PROXY=true: without a trusted proxy the header is whatever the sender wrote.
 */
export function clientAddress(req: Request | Headers | undefined): string | null {
  if (process.env.TRUST_PROXY !== "true") return null;
  const headers = req instanceof Headers ? req : req?.headers;
  const hops = headers?.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  return hops.at(-1) ?? null;
}
