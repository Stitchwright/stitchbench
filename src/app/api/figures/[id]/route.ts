import { db } from "@/lib/db";
import { sessionUser } from "@/lib/session";
import { hubPicture } from "@/lib/hub";
import { imageResponse } from "@/lib/image-response";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await sessionUser())) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  // This install's own copy first, then the community hub's.
  const img = (await db.figureImage.findUnique({ where: { id }, select: { data: true, mime: true } })) ?? (await hubPicture("figure", id).catch(() => null));
  if (!img) return new Response("Not found", { status: 404 });
  return imageResponse(img.data, img.mime);
}
