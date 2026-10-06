import { sessionUser } from "@/lib/session";
import { db } from "@/lib/db";
import { formUpTo } from "@/lib/read-body";
import { baseResponse } from "@/lib/base-gate";
import { MAX_PHOTOS } from "@/lib/longarm";

const MAX_BYTES = 3 * 1024 * 1024; // photos are resized in the browser first; this is a backstop

/** A photo of a quilting work order (the quilt as it came in, the finished work). */
export async function POST(req: Request) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const shopId = user.shopId;
  const form = await formUpTo(req, MAX_BYTES + 100_000);
  if (form === "too large") return new Response("Photo is too large (3 MB max).", { status: 413 });
  if (!form) return new Response("No photo received.", { status: 400 });
  const orderId = String(form.get("orderId") ?? "");
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) return new Response("No photo received.", { status: 400 });
  if (file.size > MAX_BYTES) return new Response("Photo is too large (3 MB max).", { status: 413 });
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return new Response("Use a JPEG, PNG or WebP photo.", { status: 415 });
  const order = await db.longarmOrder.findFirst({ where: { id: orderId, shopId }, select: { id: true } });
  if (!order) return new Response("Work order not found.", { status: 404 });
  const readOnly = await baseResponse(shopId, user.role !== "TECH");
  if (readOnly) return readOnly;
  if ((await db.longarmPhoto.count({ where: { shopId, orderId } })) >= MAX_PHOTOS) return new Response(`That's ${MAX_PHOTOS} photos already.`, { status: 400 });
  const photo = await db.longarmPhoto.create({
    data: { shopId, orderId, mime: file.type, data: new Uint8Array(await file.arrayBuffer()), caption: form.get("caption") ? String(form.get("caption")).slice(0, 300) : null },
    select: { id: true },
  });
  return Response.json(photo);
}
