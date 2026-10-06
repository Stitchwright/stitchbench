import { db } from "@/lib/db";
import { sessionUser } from "@/lib/session";
import { imageResponse } from "@/lib/image-response";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const p = await db.longarmPhoto.findFirst({ where: { id, shopId: user.shopId }, select: { data: true, mime: true } });
  if (!p) return new Response("Not found", { status: 404 });
  return imageResponse(p.data, p.mime);
}
