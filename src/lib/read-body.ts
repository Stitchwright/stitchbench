import "server-only";

/**
 * The request body (or a response's: anything with headers and a body), or null once it runs past `max` bytes. A chunked
 * upload has no Content-Length to check first, so the bytes are counted as they arrive and the upload is dropped at the
 * limit instead of being read whole into memory.
 */
export async function readUpTo(req: Pick<Request, "headers" | "body">, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return body;
}

/** A multipart form of at most `max` bytes: "too large", or null when it can't be read as a form. */
export async function formUpTo(req: Request, max: number): Promise<FormData | "too large" | null> {
  const body = await readUpTo(req, max);
  if (!body) return "too large";
  try {
    return await new Response(body, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return null;
  }
}
