import "server-only";
import { safeImageType } from "@/lib/hub";

/**
 * A stored picture as an HTTP response. Only picture types go out, the browser is told not to guess another type,
 * and even if a picture were opened on its own it could run nothing (sandbox).
 */
export function imageResponse(data: Uint8Array, mime: string | null | undefined, cache = "private, max-age=31536000, immutable") {
  return new Response(Buffer.from(data), {
    headers: {
      "Content-Type": safeImageType(mime),
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
