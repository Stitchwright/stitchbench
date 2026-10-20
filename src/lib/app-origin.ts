// This service's own address, for the links it mails or hands out. Pure (no server-only, no database) so the seed script can
// use it too. Never taken from a request (a forged Host header would send an owner a link to someone else's site).

/** An origin from a variable: https, or http for this machine (tests); nothing but scheme, host and port. */
export function origin(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  try {
    const u = new URL(text);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** APP_URL, else PUBLIC_URL when it is the app itself (not a separate links-only address), else Railway's public domain. */
export function appBaseUrl(): string | null {
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  return origin(process.env.APP_URL) ?? (process.env.PUBLIC_LINKS_ONLY === "true" ? null : origin(process.env.PUBLIC_URL)) ?? (railway ? origin(`https://${railway}`) : null);
}
