// The mock-up picture on a decorating order, for staff: the signed-in company's own order only, shown inline (it is a PNG or JPEG
// checked when it was saved).
import { sessionUser } from "@/lib/session";
import { mockupFile } from "@/lib/decor";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const f = await mockupFile(user.shopId, id);
  if (!f) return new Response("No mock-up.", { status: 404 });
  return new Response(Buffer.from(f.data), { headers: { "Content-Type": f.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } });
}
