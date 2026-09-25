import { auth } from "@/auth";
import { db } from "@/lib/db";
import { PHOTO_KINDS } from "@/lib/constants";
import type { PhotoKind } from "@/generated/prisma/enums";

const MAX_BYTES = 3 * 1024 * 1024; // photos are resized in the browser first; this is a backstop

export async function POST(req: Request) {
  const session = await auth();
  const shopId = session?.user?.shopId;
  if (!shopId) return new Response("Sign in first.", { status: 401 });

  const form = await req.formData();
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
