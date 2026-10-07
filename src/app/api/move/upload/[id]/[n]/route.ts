// Part n of a hosted upload (company-move-design.md section 8): PUT the raw bytes, at most UPLOAD_CHUNK (8 MB, under
// the 16 MB request limit). Answers { received }; 409 with { received } when the part isn't the next one the server
// needs, so the browser carries on from there. The StitchBench administrator's own uploads only.
import { UPLOAD_CHUNK } from "@/lib/move/format";
import { putChunk } from "@/lib/move/upload";
import { importer, json, refused } from "@/lib/move/routes";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const user = await importer(req);
  if (user instanceof Response) return user;
  const { id, n } = await params;
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > UPLOAD_CHUNK) return json({ error: "That part is too big." }, 413);
  try {
    const data = new Uint8Array(await req.arrayBuffer());
    const r = await putChunk(user, id, /^\d{1,6}$/.test(n) ? Number(n) : -1, data);
    return json({ received: r.received }, r.ok ? 200 : 409);
  } catch (e) {
    return refused(e);
  }
}
