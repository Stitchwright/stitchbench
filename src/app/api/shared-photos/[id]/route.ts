import { db } from "@/lib/db";
import { sessionUser } from "@/lib/session";
import { imageResponse } from "@/lib/image-response";

// Shared photos are visible to every signed-in tech on StitchBench, whatever their shop.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await sessionUser())) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const p = await db.sharedPhoto.findUnique({ where: { id }, select: { data: true, mime: true } });
  if (!p) return new Response("Not found", { status: 404 });
  return imageResponse(p.data, p.mime);
}
