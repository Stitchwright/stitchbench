// A part's shop photo for staff (the part page's "Online shop" card): the signed-in user's own shop only, listed or
// not. The public shop page uses /api/shop/photo instead, which serves only listed items.
import { db } from "@/lib/db";
import { imageResponse } from "@/lib/image-response";
import { sessionUser } from "@/lib/session";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const p = await db.partPhoto.findFirst({ where: { id, shopId: user.shopId }, select: { data: true, mime: true } });
  if (!p) return new Response("Not found", { status: 404 });
  return imageResponse(p.data, p.mime);
}
