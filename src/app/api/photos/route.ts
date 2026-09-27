import { sessionUser } from "@/lib/session";
import { db } from "@/lib/db";
import { PHOTO_KINDS } from "@/lib/constants";
import type { PhotoKind } from "@/generated/prisma/enums";

const MAX_BYTES = 3 * 1024 * 1024; // photos are resized in the browser first; this is a backstop

/**
 * The request body, or null once it runs past `max` bytes. A chunked upload has no Content-Length to check first, so
 * the bytes are counted as they arrive and the upload is dropped at the limit instead of being read whole into memory.
 */
async function readUpTo(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
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

export async function POST(req: Request) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const shopId = user.shopId;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES + 100_000) return new Response("Photo is too large (3 MB max).", { status: 413 });
  const body = await readUpTo(req, MAX_BYTES + 100_000);
  if (!body) return new Response("Photo is too large (3 MB max).", { status: 413 });

  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return new Response("No photo received.", { status: 400 });
  }
  const machineId = String(form.get("machineId") ?? "");
  const ticketId = form.get("ticketId") ? String(form.get("ticketId")) : null;
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) return new Response("No photo received.", { status: 400 });
  if (file.size > MAX_BYTES) return new Response("Photo is too large (3 MB max).", { status: 413 });
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return new Response("Use a JPEG, PNG or WebP photo.", { status: 415 });

  const machine = await db.machine.findFirst({ where: { id: machineId, shopId }, select: { id: true } });
  if (!machine) return new Response("Machine not found.", { status: 404 });
  if (ticketId && !(await db.ticket.findFirst({ where: { id: ticketId, shopId, machineId }, select: { id: true } }))) {
    return new Response("Ticket not found.", { status: 404 });
  }

  const photo = await db.machinePhoto.create({
    data: {
      shopId,
      machineId,
      ticketId,
      mime: file.type,
      data: new Uint8Array(await file.arrayBuffer()),
      caption: form.get("caption") ? String(form.get("caption")).slice(0, 300) : null,
      kind: PHOTO_KINDS.includes(String(form.get("kind")) as PhotoKind) ? (String(form.get("kind")) as PhotoKind) : "CONDITION",
    },
    select: { id: true },
  });
  return Response.json(photo);
}
