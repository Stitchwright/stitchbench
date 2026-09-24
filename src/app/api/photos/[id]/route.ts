import { auth } from "@/auth";
import { db } from "@/lib/db";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const shopId = session?.user?.shopId;
  if (!shopId) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const p = await db.machinePhoto.findFirst({ where: { id, shopId }, select: { data: true, mime: true } });
  if (!p) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(p.data), {
    headers: { "Content-Type": p.mime, "Cache-Control": "private, max-age=31536000, immutable" },
  });
}
