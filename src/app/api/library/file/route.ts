import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { auth } from "@/auth";
import { libraryDir, resolveInLibrary } from "@/lib/library-dir";

const MAX_UPLOAD = 150 * 1024 * 1024;

/** A manual from the shop PC's library, shown in the browser. ?path= is relative to the library folder. */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.shopId) return new Response("Sign in first.", { status: 401 });
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
  const name = path.basename(full).replace(/"/g, "");
  return new Response(Readable.toWeb(fs.createReadStream(full)) as ReadableStream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(size),
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** Save a scanned manual into <library>\_inbox, where new manuals wait to be identified and filed. */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.shopId) return new Response("Sign in first.", { status: 401 });
  const root = libraryDir();
  if (!root) return new Response("This StitchBench doesn't serve a manual library.", { status: 404 });
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) return new Response("No PDF received.", { status: 400 });
  if (file.size > MAX_UPLOAD) return new Response("That PDF is too large.", { status: 413 });
  const base = String(form.get("filename") ?? "scan.pdf")
    .replace(/[^\w\-+.() ]+/g, "_")
    .replace(/\.pdf$/i, "")
    .slice(0, 120);
  const inbox = path.join(root, "_inbox");
  await fs.promises.mkdir(inbox, { recursive: true });
  let name = `${base || "scan"}.pdf`;
  for (let i = 2; fs.existsSync(path.join(inbox, name)); i++) name = `${base} (${i}).pdf`;
  await fs.promises.writeFile(path.join(inbox, name), new Uint8Array(await file.arrayBuffer()));
  return Response.json({ path: `_inbox\\${name}` });
}
