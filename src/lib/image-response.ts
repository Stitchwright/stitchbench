import "server-only";
import { safeImageType } from "@/lib/hub";

/**
 * A stored picture as an HTTP response. Only picture types go out, the browser is told not to guess another type,
 * and even if a picture were opened on its own it could run nothing (sandbox).
 */
export function imageResponse(data: Uint8Array, mime: string | null | undefined) {
  return new Response(Buffer.from(data), {
    headers: {
      "Content-Type": safeImageType(mime),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
