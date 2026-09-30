import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { sessionUser } from "@/lib/session";
import { libraryDir, resolveInLibrary, writeUnusedPdf } from "@/lib/library-dir";
import { formUpTo } from "@/lib/read-body";

const MAX_UPLOAD = 150 * 1024 * 1024;

/** A manual from the shop PC's library, shown in the browser. ?path= is relative to the library folder. */
export async function GET(req: Request) {
  if (!(await sessionUser())) return new Response("Sign in first.", { status: 401 });
  const root = libraryDir();
  if (!root) return new Response("This StitchBench doesn't serve a manual library.", { status: 404 });
  const full = resolveInLibrary(root, new URL(req.url).searchParams.get("path") ?? "");
  if (!full) return new Response("Not a manual in the library.", { status: 400 });
  let size: number;
  try {
    size = (await fs.promises.stat(full)).size;
  } catch {
    return new Response("That manual isn't in the library folder any more.", { status: 404 });
  }
  // Header values can only carry plain ASCII: the real name goes in filename* (e.g. the Chinese Dahao manuals).
  const name = path.basename(full);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(Readable.toWeb(fs.createReadStream(full)) as ReadableStream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(size),
      "Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** Save a scanned manual into <library>\_inbox, where new manuals wait to be identified and filed. */
export async function POST(req: Request) {
  if (!(await sessionUser())) return new Response("Sign in first.", { status: 401 });
  const root = libraryDir();
  if (!root) return new Response("This StitchBench doesn't serve a manual library.", { status: 404 });
  // Refuse an oversized upload while reading it (a chunked upload has no Content-Length to check first).
  const form = await formUpTo(req, MAX_UPLOAD + 1_000_000);
  if (form === "too large") return new Response("That PDF is too large.", { status: 413 });
  if (!form) return new Response("No PDF received.", { status: 400 });
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) return new Response("No PDF received.", { status: 400 });
  if (file.size > MAX_UPLOAD) return new Response("That PDF is too large.", { status: 413 });
  const stem =
    String(form.get("filename") ?? "scan.pdf")
      .replace(/[^\w\-+.() ]+/g, "_")
      .replace(/\.pdf$/i, "")
      .slice(0, 120) || "scan";
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") return new Response("That isn't a PDF.", { status: 415 });
  const inbox = path.join(root, "_inbox");
  await fs.promises.mkdir(inbox, { recursive: true });
  const name = await writeUnusedPdf(inbox, stem, bytes);
  return Response.json({ path: `_inbox\\${name}` });
}
