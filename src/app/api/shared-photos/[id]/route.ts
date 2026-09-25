import { auth } from "@/auth";
import { db } from "@/lib/db";

// Shared photos are visible to every signed-in tech on StitchBench, whatever their shop.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.shopId) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const p = await db.sharedPhoto.findUnique({ where: { id }, select: { data: true, mime: true } });
  if (!p) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(p.data), {
    headers: { "Content-Type": p.mime, "Cache-Control": "private, max-age=31536000, immutable" },
  });
}
